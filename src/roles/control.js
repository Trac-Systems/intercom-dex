import { locksControlHandler } from '../dashboard/server.js';
// Shared local control handler; the runner binds it only to 127.0.0.1.
export function controlHandler({ token, role, wallets = null, fees = null }) {
  const routes = {
    ...(role.stakeQuiesce ? { 'POST /stake/quiesce': b => {
      if (Object.keys(b).length) throw new Error('Unknown quiesce field'); return role.stakeQuiesce();
    }, 'POST /stake/handoff': b => {
      if (Object.keys(b).some(k => k !== 'nextPolicy') || !b.nextPolicy) throw new Error('nextPolicy required'); return role.stakeHandoff(b.nextPolicy);
    }, 'POST /stake/resume': b => {
      if (Object.keys(b).length) throw new Error('Unknown resume field'); return role.stakeResume();
    } } : {}),
    ...(role.stakeAction ? { 'GET /stake': () => role.stakeAction({ action: 'status' }),
      'GET /rewards': () => ({ ok: true, rewards: role.stakeView().rewards }),
      'POST /stake/deposit': b => { if (Object.keys(b).some(k => k !== 'amount')) throw new Error('Unknown stake field'); return role.stakeAction({ ...b, action: 'deposit' }); },
      'POST /stake/withdraw': b => { if (Object.keys(b).some(k => k !== 'amount')) throw new Error('Unknown stake field'); return role.stakeAction({ ...b, action: 'withdraw' }); } } : {}),
    'GET /status': async () => ({ ...role.status(), ...(wallets ? { wallets: await wallets.info({ short: true }) } : {}) }),
    ...(wallets ? { 'GET /wallets': () => wallets.info(), 'POST /withdraw': b => wallets.withdraw(b) } : {}),
    ...(fees ? { 'POST /fee/set': b => fees.set(b), 'POST /fee/platform': b => fees.platform(b) } : {}),
    ...(role.listSellerStrikes ? { 'GET /seller-strikes': () => role.listSellerStrikes(),
      'POST /seller-strikes/clear': b => role.clearSellerStrikes(b) } : {}),
    ...(role.clearBuyerStrikes ? { 'POST /buyer-strikes/clear': b => role.clearBuyerStrikes(b) } : {}),
    ...(role.readChat ? { 'GET /chat': (_, url) => {
      const values = url.searchParams.getAll('since');
      if ([...url.searchParams.keys()].some(key => key !== 'since') || values.length > 1 ||
          (values.length && !/^(0|[1-9][0-9]*)$/.test(values[0]))) throw new Error('Invalid chat since timestamp');
      return role.readChat(values.length ? Number(values[0]) : undefined);
    } } : {}),
    ...(role.sayChat ? { 'POST /chat': b => role.sayChat(b) } : {}),
    ...(role.retryDelivery ? { 'POST /retry-delivery': b => role.retryDelivery(b) } : {}),
    'POST /offer': b => role.makeOffer(b),
    'POST /cancel': b => role.cancelOffer(b.offerId),
    'POST /take': b => role.takeOffer(b.offerId, b.baseAmount, b.price),
    // As if a dashboard showed this market with these offers on top: the makers kept connected are returned.
    ...(role.warmNow ? { 'POST /warm': async b => {
      if (typeof b.pair !== 'string' || !Array.isArray(b.offerIds) || b.offerIds.length > 2 || b.offerIds.some(id => typeof id !== 'string')) throw new Error('Invalid warm request');
      role.noteViewing(b.pair, b.offerIds);
      return { peerKeys: await role.warmNow() };
    } } : {}),
  };
  const handler = (req, res) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', async () => {
      const reply = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' });
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const route = routes[`${req.method} ${url.pathname}`];
        if (!route) return reply(404, { error: 'not found' });
        reply(200, await route(body ? JSON.parse(body) : {}, url));
      } catch (e) { reply(400, e.result ?? { error: e.message }); }
    });
  };
  return role.locks ? locksControlHandler({ token, client: role.locks, fallback: handler }) : handler;
}
