const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export async function broadcastTnkTransfer(msb, payload) {
  if (payload?.type !== 13 || !hash(payload.tro?.tx) || typeof msb?.broadcastTransaction !== 'function') throw new Error('Expected MSB instance and TNK transfer');
  // MainSettlementBus validates the partial operation, routes it to a validator,
  // and waits for local unsigned inclusion. This is not a finality receipt.
  const result = await msb.broadcastTransaction(payload);
  if (result?.tx !== payload.tro.tx) throw new Error('TNK broadcast failed');
  return { txHash: result.tx, final: false };
}

export async function broadcastResetTransfer(peer, submission) {
  if (!hash(submission?.tx) || !hash(submission.address) || !hash(submission.nonce) || submission.prepared_command?.type !== 'transfer' || typeof peer?.protocol?.instance?.api?.tx !== 'function') throw new Error('Expected RESET peer and submission');
  const { tx, prepared_command, address, signature, nonce } = submission;
  const result = await peer.protocol.instance.api.tx(tx, prepared_command, address, signature, nonce);
  if (result?.txo?.tx !== tx) throw new Error('RESET broadcast failed');
  return { txHash: tx, final: false };
}
