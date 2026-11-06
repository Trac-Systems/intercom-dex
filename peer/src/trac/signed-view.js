import Hyperbee from 'hyperbee';
import b4a from 'b4a';

// A named Autobase batch tracks its committed storage dependency, which can lag
// a signed head received through replication. Read that head by the same view
// key, never the batch's unsigned tail. Sparse blocks still require replication.
export async function signedCheckout(base, label) {
  const original = base.view, core = original.core;
  let source, view;
  try {
    if (core.state?.name) {
      source = new Hyperbee(base.store.get({ key: core.key, encryption: core.encryption, writable: false }), {
        keyEncoding: original.keyEncoding, valueEncoding: original.valueEncoding, extension: false, readonly: true
      });
      await source.ready();
    }
    const signed = source ?? original, length = signed.core.signedLength;
    if (!Number.isSafeInteger(length) || length < 1) throw new Error(`${label} signed view is not ready`);
    view = signed.checkout(length);
    if (source) { await view.ready(); await source.close(); }
    return { view, length, coreKey: signed.core.key ? b4a.toString(signed.core.key, 'hex') : null };
  } catch (error) {
    await Promise.allSettled([view?.close(), source?.close()]);
    throw error;
  }
}
