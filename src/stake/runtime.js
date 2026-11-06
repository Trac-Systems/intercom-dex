import { RewardOffers } from './reward-book.js';
import { PenaltySigner } from './penalty-signer.js';
import { PenaltyCoordinator } from './penalty-coordinator.js';
import { StakeAwardClient } from './award-client.js';
import { tradeId as termsTradeId } from '../core/terms.js';
import { bondAck, bondReservation } from './admission.js';
import { tracPublicKey } from '../core/addresses.js';
import { randomBytes } from 'node:crypto';
import { StakeAdmission } from './admission-runtime.js';
import { verifyStakeFunding } from './funding.js';
import { requireResetGateway } from '../market/gateway-status.js';
import { StakeTransport, STAKE_CHANNEL } from './transport.js';
import { STAKE_PAYOUT_RATE } from './paging.js';
import { finalizedStakeClock } from './chain.js';
import { StakePriceService, stakeContext } from './price-service.js';
import { StakeCustodySigner } from './custody-signer.js';
import { StakeClient } from './client.js';
import { verifyCertificate, verifyFact, factDigest } from './certificates.js';
import { StakeLedger } from './ledger.js';
import { effectiveSettings } from './settings.js';
import { createLocksTrac } from '../wallets/locks-trac.js';
import { scalarSigner } from '../locks/crypto/scalar-sign.js';
import { address } from '../locks/trac-lock.js';
import { DeliveryObserver } from './delivery-evidence.js';
import { verifySummon } from '../roles/common.js';
import { transferNonce } from '../trac/transfers.js';
import { RewardCheckpoints } from './reward-checkpoints.js';
import { Clock } from '../locks/clock.js';
import { rewardsStatus } from './status.js';
import { StakeEpochHandoff } from './epoch-handoff.js';
import { archiveCustodyTransition } from './custody-archive.js';

// Stake is an independent authenticated channel, with existing spot registry and
// original signer identities. It does not depend on optional Locks configuration.
export function createStakeRuntime({ type, role, bridge, identity, box, store, solana, trac, rpc, wallet, profile, resetGatewayUrl, log }) {
  const registry = () => type === 'service' ? role.registry : role.registry.usable;
  const clock = () => finalizedStakeClock(rpc ?? {});
  let price, signer, client, rewards, admission, penalty, coordinator, award;
  const rewardOffers = type === 'signer' ? new RewardOffers({ bridge, registry }) : null;
  const handle = async (method, body, from) => {
    if (type === 'signer' && method.startsWith('penalty')) return penalty.handle(method, body, from);
    if (type === 'service' && method === 'penaltyPing') {
      const current = registry().sellerBond;
      const policies = [current, ...store.list('stake-venue-epoch-').map(name => store.get(name)),
        ...store.list('stake-penalty-job-').map(name => store.get(name)?.reservation.admission.policy)];
      if (!policies.some(p => p?.networkId === current?.networkId && p?.venueKey === current?.venueKey && p?.epoch.members.some(m => m.dexKey === from)) ||
          !/^[0-9a-f]{64}$/.test(body.nonce)) throw new Error('Original signer health challenge required');
      store.put(`stake-venue-proof-health-${from}`, { nonce: body.nonce }); return { nonce: body.nonce };
    }
    if (type === 'service' && method === 'penaltyCollection') return coordinator.collection(body.reservationId, body.certificate);
    if (type === 'service' && method === 'penaltyAwards') return coordinator.awards(body.after);
    if (type === 'service' && method === 'penaltyResult') return coordinator.result(body.reservationId);
    if (type === 'payout' && ['rewardStatus', 'rewardAudit'].includes(method)) return role.rewardRead(method, body);
    if (type === 'payout' && ['rewardHandoffFreeze', 'rewardHandoffAdopt', 'rewardHandoffRelease'].includes(method)) return role.rewardHandoff(method, body, from);
    if (method.startsWith('reward') && rewards) return rewards.handle(method, body, from);
    if (type === 'signer' && method === 'admissionInventory') return admission.inventoryVote(body);
    if (method.startsWith('price')) return price.handle(method, body, from);
    if (type === 'signer' && method === 'deliveryObserve') {
      const r = role.registry.snapshot(body.summon?.terms?.registryVersion), context = stakeContext(r);
      if (context.venueKey !== registry().sellerBond?.venueKey) throw new Error('Wrong delivery venue');
      const { terms, tradeId } = verifySummon(body.summon, r, body.summon.terms.sendBy - r.params.sendWindowSec,
        { networkId: context.networkId, required: true });
      if (![terms.seller.dexKey, terms.buyer.dexKey, context.venueKey].includes(from)) throw new Error('Delivery party authorization required');
      const observer = new DeliveryObserver({ store, context, identity, clock, verify: input => trac.verifyTransfer({
        ...input, minAmount: input.amount, finalBefore: Number.MAX_SAFE_INTEGER, fresh: true }) });
      return observer.observe({ tradeId, txHash: body.txHash, from: terms.seller.tracAddr, to: terms.buyer.tracAddr,
        asset: terms.base.id, amount: terms.baseAmount, nonce: transferNonce(tradeId), networkId: context.networkId });
    }
    if (type === 'signer') return signer.handle(method, body, from);
    if (type === 'service' && method === 'custodyRecord') {
      const current = registry().sellerBond, epochId = body.certificate?.[0]?.fact.epochId;
      const policy = store.get(`stake-venue-epoch-${epochId}`) ?? current;
      if (!policy || policy.networkId !== current.networkId || policy.venueKey !== current.venueKey) throw new Error('Original custody archive scope differs');
      const context = stakeContext({ sellerBond: policy }), fact = verifyCertificate(body.certificate, context, body.kind);
      if (!['funded', 'funding-refund', 'freeze', 'decision', 'collected'].includes(body.kind)) throw new Error('Invalid custody archive kind');
      const id = ['funded', 'funding-refund', 'collected'].includes(body.kind) ? fact.body.unitId : fact.body.pieces[0].unitId;
      const original = ['funded', 'funding-refund'].includes(body.kind) ? fact.body :
        (store.get(`stake-venue-funded-${id}`) ?? store.get(`stake-venue-refund-${id}`))?.[0]?.fact.body;
      if (!original || original.descriptor.owner.dexKey !== from) throw new Error('Stake owner archive authorization required');
      const ledger = new StakeLedger({ store, context, address: original.descriptor.owner.tracAddr });
      const at = (await clock()).at, settings = effectiveSettings(policy, at).settings;
      if (body.kind === 'funding-refund') {
        ledger.admitRefund(body.certificate); store.put(`stake-venue-refund-${id}`, body.certificate);
        store.put(`stake-venue-epoch-${epochId}`, policy);
      } else if (body.kind === 'funded') {
        const old = ledger.read().pieces[id];
        if (old) { if (old.fundingHash !== factDigest(fact)) throw new Error('Conflicting funding archive'); }
        else {
          const snapshot = await price.handle('priceSnapshot', {}, from), q = await price.import(snapshot);
          ledger.admitFunded(body.certificate, { settings, price: q, now: at });
        }
        store.put(`stake-venue-funded-${id}`, body.certificate);
        store.put(`stake-venue-epoch-${epochId}`, policy);
      } else archiveCustodyTransition(ledger, body.kind, body.certificate, settings);
      return { archived: true };
    }
    throw new Error('Unsupported stake request');
  };
  const allowPagingPeer = key => {
    if (!['service', 'signer', 'payout'].includes(type)) return false;
    const current = registry()?.sellerBond;
    if (!current) return false;
    const policies = [current, ...['stake-retained-epoch-', 'stake-venue-epoch-'].flatMap(prefix => store.list(prefix).map(name => store.get(name)))];
    return key === current.venueKey || key === current.rewardService?.dexKey || policies.some(p =>
      p?.networkId === current.networkId && p?.venueKey === current.venueKey && p.epoch?.members.some(m => m.dexKey === key));
  };
  const transport = new StakeTransport({ bridge, identity, handle, allowPagingPeer,
    // Payout retains its existing 64 kB/s receive limit alongside public traffic.
    pageRate: to => to === registry()?.sellerBond?.rewardService?.dexKey ? STAKE_PAYOUT_RATE : 0 });
  // Nested quorum rounds plus the rate-limited archive may outlast one RPC.
  // This does not extend proposal freshness or any individual page transfer.
  const request = (to, method, body) => to === identity.publicKey ? handle(method, body, identity.publicKey) :
    transport.request(to, method, body, method === 'rewardBlock' ? 60000 : 30000);
  if (type === 'service') {
    const handoff = new StakeEpochHandoff({ store, registry, clock, request, publish: policy => role.publishStake(policy),
      prepare: () => price.handle('priceSnapshot', {}, identity.publicKey) });
    role.stakeQuiesce = () => handoff.quiesce();
    role.stakeHandoff = next => handoff.handoff(next);
    role.stakeResume = () => handoff.resume();
  }
  price = new StakePriceService({ store, identity, registry, clock, solana, trac, request, venue: type === 'service',
    snapshot: version => type === 'service' ? role.registries.get(version) : role.registry.snapshot(version) });
  admission = new StakeAdmission({ store, identity, registry, price, clock, request, role, trader: type === 'trader' });
  if (role.host) role.host.stakeAdmission = admission;
  if (['service', 'signer'].includes(type)) rewards = new RewardCheckpoints({ store, identity, registry, price, clock,
    blockClock: new Clock({ bridge }), request, venue: type === 'service',
    offers: () => type === 'service' ? [...(role.rewardOffersByPair?.values() ?? [])].flat() : rewardOffers.snapshot(),
    balances: address => trac.balances(address) });
  if (type === 'signer') signer = new StakeCustodySigner({ store, identity, box, registry, clock, trac, price,
    verifyFunding: args => verifyStakeFunding({ bridge, ...args }) });
  const position = p => bridge.call('dex_stake_position', p ? { position: p } : {});
  if (type === 'signer') {
    penalty = new PenaltySigner({ store, identity, clock, position, history: args => solana.stakeEscrowHistory(args),
      verifyDelivery: (terms, txHash, position) => {
        const key = address => Buffer.from(tracPublicKey(address)).toString('hex'), reset = terms.base.id === 'RESET';
        return bridge.call('dex_stake_delivery', { asset: terms.base.id, txHash, from: reset ? key(terms.seller.tracAddr) : terms.seller.tracAddr,
          to: reset ? key(terms.buyer.tracAddr) : terms.buyer.tracAddr, minAmount: terms.baseAmount, nonce: transferNonce(termsTradeId(terms)), position });
      },
      health: async ({ terms }) => {
        await requireResetGateway({ id: 'RESET' }, trac);
        await trac.balances(terms.seller.tracAddr);
        const nonce = randomBytes(32).toString('hex'), response = await request(registry().sellerBond.venueKey, 'penaltyPing', { nonce });
        return response?.nonce === nonce;
      } });
    role.host.stakePenalty = penalty;
  }
  if (type === 'service') coordinator = new PenaltyCoordinator({ store, registry, request, clock, position, timing: terms => PenaltySigner.prototype.timing(terms) });
  if (type === 'trader') {
    const adapter = signingWallet => {
      const base = createLocksTrac({ bridge, wallet: signingWallet, profile, store, resetGatewayUrl });
      return { ...base, hasIntent: id => !!store.get(`locks-trac-${id}`), balances: async account => ({ ...await trac.balances(account), final: true }),
        transfer: async args => { await requireResetGateway({ id: 'RESET' }, trac); return base.transfer(args); },
        sendTransfer: async args => { await requireResetGateway(args.terms.base, trac); return base.sendTransfer(args); } };
    };
    client = new StakeClient({ store, identity, box, me: role.me, registry, clock, trac, price, request, funding: adapter(wallet),
      exclusive: fn => { if (!role.wallets) throw new Error('Wallet accounting is unavailable'); return role.wallets.exclusive(fn); },
      freeBalances: () => role.wallets.balances(),
      collector: scalar => { const w = scalarSigner(scalar); return adapter({ ...w, address: address(w.publicKey) }); } });
  }
  if (client) {
    award = new StakeAwardClient({ client });
    role.host.hooks.afterStep.push(trade => {
      const s = trade.state;
      if (trade.role === 'seller' && s.terms?.bond && s.H && s.acks.length >= s.terms.k) {
        const ledger = client.ledger(), input = bondReservation(s.terms, s.H), id = bondAck(s.terms, s.H).reservationId;
        if (!ledger.read().reservations[id]) ledger.reserve(input);
      }
    });
  }
  let timer, rewardTimer, admissionTimer, penaltyTimer;
  let penaltyRunning = false;
  const penaltyTick = async () => {
    if (penaltyRunning || !registry()?.sellerBond) return;
    penaltyRunning = true;
    try {
      if (coordinator) await coordinator.tick();
      if (client) for (const trade of role.host.trades.values()) {
        try {
        const s = trade.state; if (!s.terms?.bond || !s.H) continue;
        const id = bondAck(s.terms, s.H).reservationId, policy = s.registry?.sellerBond ?? role.registry.snapshot(s.terms.registryVersion)?.sellerBond;
        if (store.get(`stake-penalty-finished-${id}`)) continue;
        if (!policy) continue;
        const originalLedger = new StakeLedger({ store, context: stakeContext({ sellerBond: policy }), address: role.me.tracAddr });
        if (trade.role === 'seller' && s.acks.length >= s.terms.k && !originalLedger.read().reservations[id])
          originalLedger.reserve(bondReservation(s.terms, s.H));
        if (trade.role === 'seller') {
          let txHash = s.txHash;
          if (!txHash && Math.floor(Date.now() / 1000) >= s.terms.sendBy) txHash = (await trac.checkSellerTransfer({ terms: s.terms, tradeId: s.tradeId }))?.txHash;
          if (txHash) {
            store.put(`stake-proof-outbox-${id}`, { tradeId: s.tradeId, txHash, reservationId: id });
            const results = await Promise.allSettled(policy.epoch.members.map(m => request(m.dexKey, 'penaltyEvidence', { reservationId: id, txHash })));
            const receipts = results.flatMap((r, i) => {
              if (r.status !== 'fulfilled') return [];
              try { const b = verifyFact(r.value, stakeContext({ sellerBond: policy }), 'delivery-result', policy.epoch.members[i].dexKey).body;
                return b.reservationId === id && b.txHash === txHash ? [r.value] : []; } catch { return []; }
            });
            store.put(`stake-proof-receipts-${id}`, { txHash, receipts });
          }
          const now = Math.floor(Date.now() / 1000), retry = store.get(`stake-original-retry-${id}`);
          if (!s.transferFinal && now >= s.terms.sendBy && now <= s.terms.sendBy + s.terms.bond.overdueDelaySec && (!retry || now - retry.at >= 10)) {
            store.put(`stake-original-retry-${id}`, { at: now });
            await trac.retryOriginalTransfer({ terms: s.terms, tradeId: s.tradeId, overdueDelaySec: s.terms.bond.overdueDelaySec }).catch(() => {});
          }
        }
        const result = await request(policy.venueKey, 'penaltyResult', { reservationId: id }).catch(() => store.get(`stake-trade-penalty-${s.tradeId}`));
        if (!result) continue;
        store.put(`stake-trade-penalty-${s.tradeId}`, result);
        if (result.resolved) {
          const closure = verifyCertificate(result.resolved, stakeContext({ sellerBond: policy }), 'resolved').body;
          if (closure.reservationId !== id) throw new Error('Closure reservation differs');
          if (trade.role === 'seller') originalLedger.resolve(result.resolved);
          store.put(`stake-penalty-finished-${id}`, { outcome: closure.outcome });
        }
        if (result.decision && trade.role === 'seller') {
          originalLedger.decide(result.decision);
          for (const certificate of Object.values(result.collections ?? {})) originalLedger.collected(certificate);
        }
        if (result.decision && trade.role === 'buyer') {
          const collected = await award.collect({ terms: s.terms, H: s.H, policy, result });
          if (collected.complete) {
            store.put(`stake-trade-penalty-${s.tradeId}`, { ...result, collections: collected.collections });
            store.put(`stake-penalty-finished-${id}`, { outcome: 'collected' });
          }
        }
        if (result.decision && trade.role === 'seller' && s.terms.bond.pieces.every(p => result.collections?.[p.unitId]))
          store.put(`stake-penalty-finished-${id}`, { outcome: 'collected' });
        } catch (e) { log('stake trade penalty waiting', trade.state.tradeId, e.message); }
      }
    } catch (e) { log('stake penalty waiting', e.message); } finally { penaltyRunning = false; }
  };
  return { price, client, request, admission, penalty, coordinator, boxKey: box?.publicKey,
    async start() {
      await transport.start();
      if (rewardOffers) await rewardOffers.start();
      if (coordinator || client) { void penaltyTick(); penaltyTimer = setInterval(penaltyTick, 5000); penaltyTimer.unref?.(); }
      if (['trader', 'service'].includes(type)) {
        let refreshing = false;
        const refresh = async () => {
          if (refreshing || !registry()?.sellerBond) return;
          refreshing = true;
          try { await admission.refresh(type === 'service' ? [...new Map(role.registry.pairs.flatMap(p => role.book.snapshot(p.pair, role.now())).filter(o => o.side === 'sell').map(o => [o.maker.dexKey, o.maker])).values()] : []); }
          catch (e) { log('stake admission waiting', e.message); } finally { refreshing = false; }
        };
        void refresh(); admissionTimer = setInterval(refresh, 15000); admissionTimer.unref?.();
      }
      if (rewards) {
        let observing = false;
        const observe = async () => {
          if (observing || !registry()?.sellerBond?.rewardService) return;
          observing = true;
          try { await rewards.observe(); await rewards.certifyCaptured(); } catch (e) { log('reward checkpoint waiting', e.message); }
          finally { observing = false; }
        };
        void observe(); rewardTimer = setInterval(observe, 5000); rewardTimer.unref?.();
      }
      if (client) { const recover = () => client.recover().catch(e => log('stake recovery', e.message));
        const poll = async () => {
          void recover();
          const source = registry()?.sellerBond?.rewardService?.dexKey;
          if (!source) return;
          try {
            const response = await request(source, 'rewardStatus', { address: role.me.tracAddr });
            if (response.address !== role.me.tracAddr) throw new Error('Wrong reward address');
            store.put('stake-reward-status', { source, address: response.address, at: Math.floor(Date.now() / 1000), rewards: rewardsStatus(response.rewards) });
          } catch (e) { log('rewards waiting', e.message); }
        };
        void poll(); timer = setInterval(poll, 15000); timer.unref?.(); }
    },
    restore: () => bridge.join(STAKE_CHANNEL),
    stop() { clearInterval(timer); clearInterval(rewardTimer); clearInterval(admissionTimer); clearInterval(penaltyTimer); transport.stop(); rewardOffers?.stop(); },
  };
}
