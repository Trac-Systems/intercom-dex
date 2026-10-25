// Explicitly preloaded by stack.mjs into the test trader processes. No production module imports this file.
import { readFileSync } from 'node:fs';
import { TradeHost } from '../../src/roles/host.js';
import { fromLe32, hexToBytes, le32 } from '../../src/core/canonical.js';
import { SCALAR_ORDER, split, verifyShare } from '../../src/core/vss.js';
import { sealTo } from '../../src/core/seal.js';
import { WalletManager } from '../../src/wallets/manager.js';
import { Trader } from '../../src/roles/trader.js';

// Exercise the signer fallback when the maker cannot read the taker's wallet. Signers still read real balances.
const originalTraderStart = Trader.prototype.start;
Trader.prototype.start = function() {
  const balances = this.host.trac.balances.bind(this.host.trac);
  this.host.trac.balances = address => {
    const selected = JSON.parse(readFileSync(process.env.DEX_E2E_ATTACK_FILE, 'utf8'));
    if (selected.kind === 'unfunded-seller' && address === selected.sellerAddr && address !== this.me.tracAddr) {
      throw new Error('test maker balance reader unavailable');
    }
    return balances(address);
  };
  return originalTraderStart.call(this);
};
import { offerIdOf } from '../../src/roles/common.js';
import { seal } from '../../src/core/envelope.js';

// authenticate the wire packet with the real DEX identity while substituting a funded foreign Trac address.
// This bypasses only the attacker's own admission checks; venue, counterparty and signer checks stay untouched.
const originalPublic = TradeHost.prototype.sendPublic;
TradeHost.prototype.sendPublic = function(channel, kind, body) {
  const attack = JSON.parse(readFileSync(process.env.DEX_E2E_ATTACK_FILE, 'utf8'));
  if (attack.kind === 'address-proof-offer' && kind === 'offer' && body.maker.dexKey === attack.attackerKey) {
    body.maker = { ...body.maker, tracAddr: attack.foreignAddr };
    delete body.maker.tracProof;
    body.offerId = offerIdOf(body);
  }
  return originalPublic.call(this, channel, kind, body);
};
const originalEnvelope = TradeHost.prototype.sendEnvelope;
TradeHost.prototype.sendEnvelope = function(trade, channel, envelope) {
  const attack = JSON.parse(readFileSync(process.env.DEX_E2E_ATTACK_FILE, 'utf8'));
  if (attack.kind === 'address-proof-take' && envelope.kind === 'take' && envelope.from === attack.attackerKey) {
    const body = structuredClone(envelope.body);
    body.taker.tracAddr = attack.foreignAddr;
    envelope = seal({ kind: 'take', ch: channel, body }, this.identity.secretKey, { ts: envelope.ts, nonce: envelope.nonce });
  }
  return originalEnvelope.call(this, trade, channel, envelope);
};

// A malicious taker can omit its own wallet preflight. Keep the real zero balance visible to every signer.
const originalRequireFunds = WalletManager.prototype.requireFunds;
WalletManager.prototype.requireFunds = function(terms) {
  const selected = JSON.parse(readFileSync(process.env.DEX_E2E_ATTACK_FILE, 'utf8'));
  if (selected.kind === 'unfunded-seller' && terms.role === 'seller' && terms.seller.tracAddr === selected.sellerAddr) return Promise.resolve();
  return originalRequireFunds.call(this, terms);
};

const originalDeliver = TradeHost.prototype.deliver;
TradeHost.prototype.deliver = function(key, event) {
  const trade = this.trades.get(key);
  const s = trade?.state;
  const selected = JSON.parse(readFileSync(process.env.DEX_E2E_ATTACK_FILE, 'utf8'));
  if (event.type === 'certificateAssigned' && selected.buyerKey === s?.self) {
    if (['cheating-dealer', 'cheating-certificate'].includes(selected.kind)) event = { ...event, certificate: null };
    if (selected.kind === 'fee-change') {
      if (!event.certificate) throw new Error('Fee-change requires a ready certificate');
      // Terms are signed; preserve the prepared certificate while the new collector finalizes.
      if (!selected.release) return gate('DEX_E2E_FEE_TERMS_SIGNED', selected, s).then(() => originalDeliver.call(this, key, event));
    }
    if (['signers-vanish-before-ack', 'refund'].includes(selected.kind) && !selected.release) {
      return gate('DEX_E2E_TERMS_SIGNED', selected, s).then(() => originalDeliver.call(this, key, event));
    }
  }
  if (event.type === 'transferSent' && event.ok && selected.kind === 'signers-offline' && selected.sellerKey === s?.self && !selected.release) {
    return gate('DEX_E2E_TRANSFER_SENT', selected, s).then(() => originalDeliver.call(this, key, event));
  }
  if (event.type === 'proved' && event.ok === true && s?.phase === 'proving') {
    const attack = JSON.parse(readFileSync(process.env.DEX_E2E_ATTACK_FILE, 'utf8'));
    if (attack.buyerKey === s.self && ['cheating-dealer', 'cheating-certificate'].includes(attack.kind)) {
      if (attack.kind === 'cheating-dealer') {
        const other = fromLe32(hexToBytes(s.privateState.secretHex, 32)) % (SCALAR_ORDER - 1n) + 1n;
        let shares;
        do { shares = split(other, s.terms.k, s.terms.committee.map((_, i) => i + 1)).shares; }
        while (shares.some(p => verifyShare(p.id, p.share, s.deal.commitments)));
        s.deal.sealedShares = shares.map(p => sealTo(le32(p.share), s.deal.committeeBoxKeys[p.id - 1], { tradeId: s.tradeId, signerIndex: p.id }));
      } else if (attack.kind === 'cheating-certificate') {
        event = { ...event, proof: JSON.parse(readFileSync(attack.certificateFile, 'utf8')) };
      } else throw new Error('Unknown e2e attack');
      console.log('DEX_E2E_ATTACK_APPLIED ' + JSON.stringify({ kind: attack.kind, tradeId: s.tradeId }));
    }
  }
  return originalDeliver.call(this, key, event);
};

async function gate(marker, selected, s) {
  console.log(marker + ' ' + JSON.stringify({ tradeId: s.tradeId, committee: s.terms.committee.map(c => c.dexKey), fees: s.terms.fees }));
  const until = Date.now() + (selected.kind === 'fee-change' ? 120000 : 30000);
  for (;;) {
    const current = JSON.parse(readFileSync(process.env.DEX_E2E_ATTACK_FILE, 'utf8'));
    if (current.kind !== selected.kind || current.release) return;
    if (Date.now() >= until) throw new Error('E2e gate was not released');
    await new Promise(r => setTimeout(r, 100));
  }
}
const originalAdd = TradeHost.prototype.addTrade;
TradeHost.prototype.addTrade = function(trade) {
  if (trade.role === 'seller' && !this.e2eWithholdInstalled) {
    this.e2eWithholdInstalled = true;
    const send = this.trac.sendTransfer.bind(this.trac);
    this.trac.sendTransfer = input => {
      const selected = JSON.parse(readFileSync(process.env.DEX_E2E_ATTACK_FILE, 'utf8'));
      if (selected.kind === 'seller-no-send-refund' && input.terms.seller.tracAddr === selected.sellerAddr) {
        throw new Error('test transfer adapter unavailable before submission');
      }
      if (selected.kind === 'seller-no-send' && input.terms.seller.tracAddr === selected.sellerAddr) {
        return Promise.resolve({ ok: false, reason: 'test seller deliberately withholds transfer' });
      }
      return send(input);
    };
  }
  if (!this.e2eObserved) {
    this.e2eObserved = true;
    this.hooks.afterStep.push((t, before) => {
      if (t.state.phase === 'transferring' && before.phase !== 'transferring') console.log('DEX_E2E_TRANSFER_AUTHORIZED ' + t.state.tradeId);
      if (t.state.lockAttempted && !before.lockAttempted) console.log('DEX_E2E_LOCK_ATTEMPTED ' + t.state.tradeId);
    });
  }
  return originalAdd.call(this, trade);
};

// Stop after the accept transition persisted, before the taker's reveal can leave its peer.
import { Bridge } from '../../src/net/bridge.js';
const originalSend = Bridge.prototype.send;
Bridge.prototype.send = function(channel, envelope) {
  const selected = JSON.parse(readFileSync(process.env.DEX_E2E_ATTACK_FILE, 'utf8'));
  if (selected.kind === 'silent-taker' && envelope.from === selected.takerKey && envelope.kind === 'reveal') {
    console.log('DEX_E2E_SILENT_AFTER_ACCEPT ' + JSON.stringify({ offerId: envelope.body.offerId }));
    return new Promise(() => {});
  }
  return originalSend.call(this, channel, envelope);
};

// A successful broadcast receipt whose bytes never reached the chain, followed by a process restart.
const originalCall = Bridge.prototype.call, originalFetch = globalThis.fetch;
function droppedTransfer(asset, txHash) {
  const selected = JSON.parse(readFileSync(process.env.DEX_E2E_ATTACK_FILE, 'utf8'));
  if (selected.kind !== 'transfer-retry' || selected.asset !== asset) return false;
  console.log('DEX_E2E_TRANSFER_BYTES ' + JSON.stringify({ asset, txHash, dropped: !selected.release }));
  return !selected.release;
}
Bridge.prototype.call = function(method, params, ...rest) {
  if (method === 'dex_tnk_broadcast' && droppedTransfer('TNK', params.payload.tro.tx)) return Promise.resolve({ txHash: params.payload.tro.tx });
  return originalCall.call(this, method, params, ...rest);
};
globalThis.fetch = function(url, options) {
  if (new URL(url).pathname === '/v1/tx/submit') {
    const { tx } = JSON.parse(options.body);
    if (droppedTransfer('RESET', tx)) return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { txo: { tx } } })));
  }
  return originalFetch(url, options);
};

// A returning isolated peer bootstraps fallback keys from a cached, verified public registry.
if (process.env.DEX_E2E_REGISTRY_SEED) {
  const { Trader } = await import('../../src/roles/trader.js');
  const { open, createReplayCache } = await import('../../src/core/envelope.js');
  const start = Trader.prototype.start;
  Trader.prototype.start = async function () {
    const raw = JSON.parse(readFileSync(process.env.DEX_E2E_REGISTRY_SEED, 'utf8'));
    const message = open(raw, { now: Math.floor(Date.now() / 1000), seen: createReplayCache(), maxAgeSec: 3600 });
    if (!this.registry.offer(message)) throw Error('Invalid cached registry');
    return start.call(this);
  };
}
