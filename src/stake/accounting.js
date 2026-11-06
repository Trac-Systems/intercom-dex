// Pending stake funding shares the ordinary wallet admission lock and holds.
// Confirmed principal is shown in the separate stake row, never liquid funds.
export function stakeWalletHolds(operation, feeTnk) {
  if (operation?.kind === 'withdraw' && !operation.done && operation.batches) {
    const holds = operation.batches.map(b => stakeWalletHolds(b, feeTnk));
    return Object.fromEntries(['RESET', 'TNK'].map(asset => [asset, holds.reduce((n, h) => n + BigInt(h[asset]), 0n).toString()]));
  }
  if (operation?.kind === 'withdraw' && !operation.done && operation.replacementOperation)
    return stakeWalletHolds(operation.replacementOperation, feeTnk);
  const held = { RESET: 0n, TNK: 0n }, fee = BigInt(feeTnk);
  if (operation?.kind === 'deposit' && !operation.done) for (const p of operation.pieces) {
    if (p.returning) continue;
    if (!p.funding?.TNK) held.TNK += BigInt(p.descriptor.tnkReserve) + fee;
    if (!p.funding?.RESET) { held.RESET += BigInt(p.descriptor.principalReset); held.TNK += fee; }
  }
  return Object.fromEntries(Object.entries(held).map(([asset, amount]) => [asset, amount.toString()]));
}
export function accountStakeBalances(balances, operation, feeTnk) {
  const result = structuredClone(balances), held = stakeWalletHolds(operation, feeTnk);
  for (const asset of ['RESET', 'TNK']) {
    const row = result[asset], amount = BigInt(held[asset]), free = BigInt(row.free) - amount;
    row.committed = (BigInt(row.committed) + amount).toString();
    row.free = (free > 0n ? free : 0n).toString(); row.breakdown.stake = held[asset];
  }
  return result;
}
