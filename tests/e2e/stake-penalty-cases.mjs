import assert from 'node:assert/strict';

// Named acceptance rows share the disposable stack. A failed row is retained and
// the next row still runs; the caller reports a nonzero exit if any row failed.
export async function stakePenaltyCases(c) {
  const { api, until, setAttack, resetOf, usdcOf, escrowHeld, escrowTotal, readJob, readBuyer, clock, lateLock, restart, network, wallets, log, saveResults } = c;
  // The never-lock balance assertion precedes every refundable test lock, so
  // another row's delayed refund cannot change this buyer's balance mid-case.
  const cases = c.cases ?? ['buyer-never-lock', 'no-show', 'bonded-delivery', 'inside-grace', 'after-grace', 'outage', 'buyer-late-lock'];
  if (cases.some(kind => !['no-show', 'bonded-delivery', 'inside-grace', 'after-grace', 'outage', 'buyer-late-lock', 'buyer-never-lock', 'epoch-handoff', 'deferred-withdraw'].includes(kind))) throw Error('Unknown stake acceptance case');
  const results = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (const kind of cases) {
    let offer, key, tradeId, stage = 'stake inventory';
    const timing = {};
    const mark = value => { stage = value; log('stake case', kind, stage); };
    try {
      await setAttack({}); let started = false;
      await until('free stake for ' + kind, async () => {
        const stake = (await api('alice', 'GET', '/stake')).stake;
        if (BigInt(stake.free) >= 25000n && !stake.operationPending) return true;
        if (!started && !stake.operationPending && BigInt(stake.reserved ?? '0') === 0n) {
          try { await api('alice', 'POST', '/stake/deposit', { amount: '0.00025' }); started = true; }
          catch (e) {
            if (!/Stake response timed out/.test(e.message)) throw e;
            log('deposit reply timed out; checking durable operation', kind);
            started = !!(await api('alice', 'GET', '/stake')).stake.operationPending;
          }
        }
        return false;
      }, 240000, 5000);
      const buyerCheat = kind.startsWith('buyer-');
      const attack = kind === 'no-show' ? { kind: 'seller-no-send', sellerAddr: wallets.alice.address }
        : buyerCheat ? { kind: 'stake-buyer-no-lock', sellerAddr: wallets.alice.address }
        : kind === 'bonded-delivery' ? {} : { kind: 'transfer-retry', asset: 'RESET', release: false, stakePause: false };
      await setAttack(attack);
      mark('covered offer');
      await until('covered offer for ' + kind, async () => {
        try { offer = await api('alice', 'POST', '/offer', { pair: 'RESET/USDC', side: 'sell', baseAmount: '50000', price: '2000', ttlSec: 1500 }); return true; }
        catch (e) { log('offer waiting', kind, e.message); return false; }
      }, 120000, 5000);
      const visible = () => until('visible offer for ' + kind, async () =>
        (await api('bob', 'GET', '/status')).offers.some(o => o.offerId === offer.offerId), 180000);
      await visible();
      if (kind === 'no-show') {
        mark('active reward checkpoint');
        await network.gift(wallets.payout.publicKey, '1000'); await network.sync(); await sleep(15000);
        await network.mineOne();
        const height = (await network.admin.protocol.instance.api.coinState()).counted;
        const reward = await until('active offer reward checkpoint', async () => {
          const state = await api('payout', 'GET', '/status'); return state.height === height && state;
        }, 180000, 3000);
        const weight = reward.summary.body.weights.find(w => w.address === wallets.alice.address);
        assert.equal(weight.activeReset, '25000'); assert.equal(weight.weight, '500000000');
        assert.equal(reward.accounts.find(a => a.address === wallets.alice.address).unpaid, '100');
        log('nonempty live checkpoint passed: active stake 25000, weight 2x, unpaid 100');
      }
      const beforeBuyer = BigInt(await resetOf('bob')), beforeSeller = BigInt(await resetOf('alice')), beforeUsdc = await usdcOf('bob');
      mark('take');
      await visible();
      timing.takeAt = Date.now();
      key = (await api('bob', 'POST', '/take', { offerId: offer.offerId, price: offer.price })).key;
      const current = async () => (await api('bob', 'GET', '/status')).trades.find(t => t.key === key);
      mark('bonded reservation and buyer lock');
      const admitted = await until('bonded admission for ' + kind, async () => {
        const t = await current(); if (t?.phase === 'aborted') throw Error('Bonded trade aborted: ' + t.reason);
        const state = await readBuyer(key);
        if (state?.terms?.bond) timing.termsAt ??= Date.now();
        if (state?.acks?.length >= 3) timing.acksAt ??= Date.now();
        if (state?.locked) timing.lockedAt ??= Date.now();
        return state?.terms?.bond && state.acks.length >= 3 && (buyerCheat || state.locked) && state;
      }, 240000, 1500);
      tradeId = admitted.tradeId;
      timing.takeToTermsMs = timing.termsAt - timing.takeAt;
      timing.takeToAcksMs = timing.acksAt - timing.takeAt;
      timing.priceAgeAtAdmissionSec = Math.floor(timing.acksAt / 1000) - admitted.terms.bond.priceReference.cutoffAt;
      log('stake handshake timing', kind, JSON.stringify(timing));
      assert.equal(admitted.terms.bond.payoutReset, '25000');
      if (buyerCheat) {
        mark('qualifying lock cutoff');
        assert.equal(await escrowHeld(admitted), '0', 'the test buyer has not sent a lock');
        if (kind === 'buyer-late-lock') {
          await until('late lock boundary', async () => (await clock()).at >= admitted.terms.sendBy - 120, 600000, 1500);
          await lateLock(admitted);
          assert.equal(await escrowHeld(admitted), await escrowTotal(admitted), 'the late lock really moved the quoted USDC and fees into its escrow');
        }
        await until('full lock window', async () => (await clock()).at > admitted.terms.sendBy, 600000, 1500);
        mark('unfunded closure');
        const job = await until('safe unfunded closure', async () => { const j = await readJob(tradeId); return j?.resolved && j; }, 180000, 3000);
        assert.equal(job.resolved[0].fact.body.outcome, 'unfunded'); assert.equal(job.decision ?? null, null);
        assert.equal(BigInt(await resetOf('bob')), beforeBuyer); assert.equal(BigInt(await resetOf('alice')), beforeSeller);
        if (kind === 'buyer-never-lock') assert.equal(await escrowHeld(admitted), '0', 'the never-locking buyer funded no escrow');
        results.push({ name: kind, ok: true, tradeId, noPenalty: true, actualLateLock: kind === 'buyer-late-lock' });
      } else if (kind === 'no-show') {
        mark('original-piece award');
        await until('buyer receives original penalty principal', async () => BigInt(await resetOf('bob')) === beforeBuyer + 25000n, 480000, 3000);
        assert.equal(BigInt(await resetOf('alice')), beforeSeller);
        assert.ok((await readJob(tradeId))?.decision);
        results.push({ name: 'no-show', ok: true, tradeId, awardReset: '25000' }); await saveResults(results);
        mark('unpaid reward forfeiture');
        await until('certified penalty forfeits unpaid rewards', async () => {
          const account = (await api('payout', 'GET', '/status')).accounts.find(a => a.address === wallets.alice.address);
          return account?.unpaid === '0' && account.forfeited === '100';
        }, 60000, 3000);
        assert.equal(await resetOf('payout'), '1000');
        results.push({ name: 'reward-forfeiture', ok: true, tradeId, forfeitedReset: '100' }); await saveResults(results);
        mark('award restart');
        await restart('bob'); await sleep(20000);
        assert.equal(BigInt(await resetOf('bob')), beforeBuyer + 25000n, 'award restart cannot collect twice');
        results.push({ name: 'award-restart', ok: true, tradeId });
      } else {
        if (kind !== 'bonded-delivery') {
          const seller = async () => (await api('alice', 'GET', '/status')).trades.find(t => t.tradeId === tradeId);
          mark('original signed delivery');
          await until('original delivery bytes', async () => (await seller())?.delivery?.tx, 60000, 1000);
          if (kind === 'deferred-withdraw') {
            mark('withdraw all while reserved');
            const pending = await api('alice', 'POST', '/stake/withdraw', { amount: 'all' });
            assert.equal(pending.deferred, '25000'); assert.equal(pending.availableAt, null);
            assert.equal(BigInt(await resetOf('alice')), beforeSeller);
            await restart('alice');
          }
          else if (kind === 'epoch-handoff') { mark('quiesced epoch handoff with original reservation'); await c.handoff(admitted); }
          else if (kind === 'inside-grace') assert.ok(!(await readJob(tradeId))?.cutoff, 'release original bytes before cutoff');
          else {
            await until('certified cutoff', async () => (await readJob(tradeId))?.cutoff, 180000, 1000);
            timing.cutoffObservedAt = Date.now();
          }
          if (kind === 'after-grace') {
            mark('certified penalty before late delivery');
            await until('healthy proof window expires before late delivery', async () => (await readJob(tradeId))?.decision, 480000, 2000);
            timing.decisionObservedAt = Date.now();
            timing.cutoffToDecisionMs = timing.decisionObservedAt - timing.cutoffObservedAt;
            const decided = await readJob(tradeId);
            timing.healthySec = decided.clock.activeElapsedSec; timing.pausedSec = decided.clock.pausedSec;
            log('stake decision timing', kind, JSON.stringify(timing));
          }
          if (kind === 'outage') {
            mark('outage pause'); attack.stakePause = true; await setAttack(attack); await sleep(30000);
            const paused = await readJob(tradeId);
            assert.equal(paused.decision ?? null, null); assert.ok(paused.clock.pausedIntervals.length > 0); assert.ok(paused.clock.remainingSec > 0);
          }
          attack.release = true; await setAttack(attack);
          await api('alice', 'POST', '/retry-delivery', { tradeId });
        }
        mark('delivery finality');
        await until('original delivery final', async () => BigInt(await resetOf('bob')) >= beforeBuyer + 50000n, 120000, 2000);
        if (kind === 'outage') { await sleep(10000); attack.stakePause = false; await setAttack(attack); }
        if (kind === 'after-grace') {
          mark('late delivery award');
          await until('late delivery still pays original stake', async () => BigInt(await resetOf('bob')) === beforeBuyer + 75000n, 180000, 2000);
          assert.ok((await readJob(tradeId))?.decision);
        } else {
          mark('delivered closure');
          const job = await until('timely proof closes reservation', async () => { const j = await readJob(tradeId); return j?.resolved && j; }, 180000, 2000);
          assert.equal(job.resolved[0].fact.body.outcome, 'delivered'); assert.equal(job.decision ?? null, null);
          assert.equal(BigInt(await resetOf('bob')), beforeBuyer + 50000n);
          if (['bonded-delivery', 'epoch-handoff'].includes(kind)) await until('updated buyer complete', async () => (await current())?.phase === 'complete', 120000);
        }
        assert.equal(BigInt(await resetOf('alice')), beforeSeller - 50000n);
        if (kind === 'deferred-withdraw') {
          await until('deferred withdrawal cooldown after closure', async () => (await api('alice', 'GET', '/stake')).stake.withdrawing === '25000', 120000, 2000);
          await c.finishDeferred(beforeSeller - 50000n + 25000n);
        }
        results.push({ name: kind, ok: true, tradeId, exactOriginalDelivery: true, penalty: kind === 'after-grace' });
      }
      log('stake named case passed', kind);
    } catch (error) {
      results.push({ name: kind, ok: false, stage, tradeId, error: error.message });
      log('stake named case FAILED', kind, stage, error.message);
      if (tradeId) {
        const job = await readJob(tradeId).catch(() => null), clock = job?.clock;
        log('stake job diagnostic', JSON.stringify({ tradeId, error: job?.error,
          clock: clock && { seq: clock.seq, throughAt: clock.throughAt, remainingSec: clock.remainingSec,
            activeElapsedSec: clock.activeElapsedSec, pausedIntervals: clock.pausedIntervals },
          decision: !!job?.decision, resolved: !!job?.resolved }));
      }
    } finally {
      for (const row of results.filter(r => r.name === kind)) row.timing = timing;
      await saveResults(results);
      if (offer) await api('alice', 'POST', '/cancel', { offerId: offer.offerId }).catch(e => log('case cleanup', e.message));
    }
  }
  return results;
}
