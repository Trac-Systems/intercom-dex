// Registry keys are operational routing hints, not network identity pins.
export class RegistryRelays {
  constructor(bridge) { this.bridge = bridge; this.applied = null; this.queue = Promise.resolve(); }
  update(registry) {
    const keys = [...new Set([registry?.serviceRelayKey, ...(registry?.signers ?? [])
      .filter(s => s.status === 'active' && !registry.removed.some(r => r.dexKey === s.dexKey)).map(s => s.relayKey)].filter(Boolean))].sort();
    const value = JSON.stringify([registry?.version ?? null, keys]);
    const work = this.queue.then(async () => {
      if (this.applied === value) return;
      await this.bridge.setRelays(keys);
      this.applied = value;
    });
    this.queue = work.catch(() => {});
    return work;
  }
}
