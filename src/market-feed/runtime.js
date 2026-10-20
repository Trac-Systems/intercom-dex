import { mkdirSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createKeyring, openKeyring } from '../roles/keyring.js';
import { openStore } from '../roles/store.js';
import { MarketFeed } from '../roles/market-feed.js';
import { startMarketFeedHttp } from './http.js';
import { TradeHistory } from './history.js';

export async function startMarketFeed({ config, profile, bridge, password, log = () => {} }) {
  if (!isAbsolute(config.dataDir ?? '')) throw new Error('market-feed dataDir must be absolute');
  if (!config.marketFeed || Object.keys(config.marketFeed).some(k => !['port', 'viewerKeyFile'].includes(k))) throw new Error('Expected marketFeed: {port, viewerKeyFile}');
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  let feed, server, closing, keys, history;
  const close = () => closing ??= (async () => {
    feed?.stop();
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await feed?.queue;
    history?.close();
    keys?.storeKey.fill(0); keys?.solanaSecret?.fill(0);
  })();
  try {
    history = new TradeHistory({ dataDir: config.dataDir, log });
    const file = join(config.dataDir, 'keyring.json');
    if (!existsSync(file)) await createKeyring(file, password);
    keys = await openKeyring(file, password);
    if (keys.solanaSecret) throw new Error('market-feed requires its own wallet-free data directory');
    feed = new MarketFeed({ bridge, store: openStore(config.dataDir, keys.storeKey), identity: keys.identity,
      profile, serviceKey: config.serviceKey, log, history });
    server = await startMarketFeedHttp({ feed, ...config.marketFeed });
    await feed.start();
    return { feed, server, close };
  } catch (error) { await close(); throw error; }
}
