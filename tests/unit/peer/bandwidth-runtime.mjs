import { Bandwidth } from '../../../peer/runtime/bandwidth.js';
import UDX from '../../../peer/node_modules/udx-native/lib/udx.js';
import b4a from '../../../peer/node_modules/b4a/index.js';

const meter = new Bandwidth(), udx = new UDX();
meter.trackUdx(udx, 'peer');
const a = udx.createSocket(), b = udx.createSocket();
a.bind(0, '127.0.0.1'); b.bind(0, '127.0.0.1');
try {
  const arrived = new Promise(resolve => b.once('message', resolve));
  a.trySend(b4a.from('bare-local-probe'), b.address().port, '127.0.0.1');
  await arrived;
  const snapshot = meter.snapshot();
  const bytes = direction => snapshot.rows.find(row => row.subsystem === 'peer/dht' && row.direction === direction)?.bytes;
  if (bytes('sent') !== 16 || bytes('received') !== 16) throw new Error('Bare DHT accounting mismatch');
  console.log('Bare bandwidth accounting passed');
} finally { await meter.close(); await a.close(); await b.close(); }
Bare.exit();
