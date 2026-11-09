export class SignerReaderHealth {
  constructor({ bridge, now = Date.now }) { Object.assign(this, { bridge, now }); this.sample = null; }
  async poll() {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.bridge.call('dex_reader_health', {});
      if (!result?.readers || ['MSB', 'RESET'].some(chain => !['unavailable', 'observing', 'advancing', 'stalled'].includes(result.readers[chain]?.status)))
        throw new Error('Invalid reader health');
      this.sample = { at: this.now(), readers: result.readers };
    } catch { this.sample = { at: this.now(), readers: null }; }
    finally { this.running = false; }
  }
  status() {
    if (!this.sample || this.now() - this.sample.at > 120000 || !this.sample.readers)
      return { status: 'unavailable', message: 'Trac/RESET reader health unavailable', readers: this.sample?.readers ?? null };
    const stalled = Object.entries(this.sample.readers).filter(([, r]) => ['stalled', 'unavailable'].includes(r.status)).map(([chain]) => chain);
    const unpatched = Object.entries(this.sample.readers).filter(([, r]) => r.hypercoreStallfix?.patched === false).map(([chain]) => chain);
    const messages = [];
    if (stalled.length) messages.push(`${stalled.join('/')} signed view is stalled or unavailable`);
    if (unpatched.length) messages.push(`WARNING: ${unpatched.join('/')} Hypercore replication stall fix is not active; run npm run postinstall --prefix peer and restart the peer`);
    return { status: messages.length ? 'degraded' : 'online', message: messages.join('; '), readers: this.sample.readers };
  }
}
