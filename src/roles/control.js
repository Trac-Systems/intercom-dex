// Shared local control handler; the runner binds it only to 127.0.0.1.
export function controlHandler({ token, role, wallets = null, fees = null }) {
  const routes = {
    'GET /status': async () => ({ ...role.status(), ...(wallets ? { wallets: await wallets.info({ short: true }) } : {}) }),
    ...(wallets ? { 'GET /wallets': () => wallets.info(), 'POST /withdraw': b => wallets.withdraw(b) } : {}),
    ...(fees ? { 'POST /fee/set': b => fees.set(b), 'POST /fee/platform': b => fees.platform(b) } : {}),
    ...(role.readChat ? { 'GET /chat': (_, url) => {
      const values = url.searchParams.getAll('since');
      if ([...url.searchParams.keys()].some(key => key !== 'since') || values.length > 1 ||
          (values.length && !/^(0|[1-9][0-9]*)$/.test(values[0]))) throw new Error('Invalid chat since timestamp');
      return role.readChat(values.length ? Number(values[0]) : undefined);
    } } : {}),
    ...(role.sayChat ? { 'POST /chat': b => role.sayChat(b) } : {}),
    'POST /offer': b => role.makeOffer(b),
    'POST /cancel': b => role.cancelOffer(b.offerId),
    'POST /take': b => role.takeOffer(b.offerId, b.baseAmount, b.price),
  };
  return (req, res) => {
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
      } catch (e) { reply(400, { error: e.message }); }
    });
  };
}
