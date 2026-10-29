// Signers publish every 30 s and count online for 90 s. Give resubscription one
// more heartbeat plus scheduling headroom before replacing the local bridge.
export const NETWORK_SILENCE_MS = 90_000;
export const NETWORK_RETRY_MS = 45_000;
export const NETWORK_CHECK_MS = 5_000;
export const NETWORK_RECONNECTING = 'Not connected to the DEX network, reconnecting…';
export const MARKET_CHANNELS = ['intercom-dex', 'intercom-dex:offers', 'intercom-dex:signers', 'intercom-dex:chat'];

export class NetworkWatchdog {
  constructor({ bridge, hasSigners, restore = async () => {}, validate = async () => {}, log = () => {}, now = () => performance.now() }) {
    Object.assign(this, { bridge, hasSigners, restore, validate, log, now });
    this.startedAt = now(); this.heartbeatAt = null; this.marketAt = null;
    this.stage = 'listening'; this.generation = 0; this.stopped = true;
    this.onClose = () => {
      if (!this.stopped && this.stage !== 'reconnecting') this.#reconnect('bridge closed');
    };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false; this.startedAt = this.now();
    this.bridge.on('close', this.onClose);
    this.timer = setInterval(() => this.check(), NETWORK_CHECK_MS); this.timer.unref?.();
  }

  stop() {
    this.stopped = true; this.generation++;
    clearInterval(this.timer); this.bridge.off('close', this.onClose);
  }

  heard(kind) {
    if (kind === 'heartbeat') this.heartbeatAt = this.now();
    else this.marketAt = this.now();
  }

  status() {
    const now = this.now(), age = at => at == null ? null : Math.max(0, Math.round(now - at));
    const silent = this.hasSigners() && now - Math.max(this.startedAt, this.heartbeatAt ?? -Infinity, this.marketAt ?? -Infinity) >= NETWORK_SILENCE_MS;
    const reconnecting = silent || this.stage !== 'listening';
    return { reconnecting, message: reconnecting ? NETWORK_RECONNECTING : '', stage: this.stage,
      heartbeatAgoMs: age(this.heartbeatAt), marketAgoMs: age(this.marketAt),
      bridgeFrameAgoMs: age(this.bridge.lastReceivedAt), bridgeReplyAgoMs: age(this.bridge.lastReplyAt), silent };
  }

  check() {
    if (this.stopped) return;
    const status = this.status(), now = this.now();
    if (this.stage === 'reconnecting') {
      if (now >= this.retryAt) this.#reconnect('bridge recovery deadline');
      return;
    }
    if (!status.silent) {
      if (this.stage !== 'listening') {
        this.generation++; this.stage = 'listening';
        this.log('DEX network traffic recovered', status);
      }
      return;
    }
    if (this.stage === 'listening') this.#rejoin();
    else if (now >= this.retryAt) this.#reconnect('still no signer or market traffic');
  }

  // Empty SC-Bridge subscriptions mean ALL channels. Adding only the market
  // channels would silently unsubscribe live trades and locks. Query and clear
  // the filter with existing 0.1.32 commands, then repair the market joins.
  async #subscribe(current) {
    const reply = await this.bridge.subscribe([]);
    if (!current()) return;
    if (reply.channels?.length) await this.bridge.request({ type: 'unsubscribe', channels: reply.channels });
    if (!current()) return;
    await this.bridge.request({ type: 'clear_filter' });
    if (!current()) return;
    await Promise.all(MARKET_CHANNELS.map(channel => this.bridge.join(channel)));
  }

  #rejoin() {
    this.stage = 'rejoining'; this.retryAt = this.now() + NETWORK_RETRY_MS;
    const generation = ++this.generation, current = () => !this.stopped && this.generation === generation;
    this.log('DEX network silent; re-subscribing and rejoining market channels', this.status());
    // Probe independently: a stuck join must not postpone escalation. Stats is
    // the existing command; log only counts, never identity/auth data.
    this.bridge.stats().then(stats => {
      if (current()) this.log('DEX bridge responding', { connections: stats.connectionCount, sidechannelStarted: stats.sidechannelStarted,
        channels: stats.channels?.length });
    }).catch(error => { if (current()) this.log('DEX bridge probe failed', error.message); });
    this.#subscribe(current).then(() => {
      if (current()) this.log('DEX market channels rejoined; waiting for traffic');
    }).catch(error => { if (current()) this.log('DEX market rejoin failed', error.message); });
  }

  #reconnect(reason) {
    this.stage = 'reconnecting'; this.retryAt = this.now() + NETWORK_RETRY_MS;
    const generation = ++this.generation, current = () => !this.stopped && this.generation === generation;
    this.log('DEX network reconnecting bridge', reason, this.status());
    Promise.resolve().then(async () => {
      if (!current()) return;
      await this.bridge.reconnect();
      if (!current()) return;
      await this.validate();
      if (!current()) return;
      await this.#subscribe(current);
      if (!current()) return;
      await this.restore(current);
      if (!current()) return;
      this.stage = 'waiting'; this.retryAt = this.now() + NETWORK_RETRY_MS;
      this.log('DEX bridge reconnected; trades retained; waiting for traffic');
      this.check();
    }).catch(error => {
      if (current()) {
        this.log('DEX bridge recovery failed; will retry', error.message);
        this.bridge.close({ force: true });
      }
    });
  }
}
