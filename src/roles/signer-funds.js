// Called only for a signer's first ack. The host evaluates this and saves the resulting holding state without an
// intervening await: two concurrent balance reads cannot both spend the same reservation. Read durable trades so
// startup order cannot hide a reservation in a trade that has not been installed yet.
export function sellerFunds({ state, balances, store, now }) {
  const units = value => {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid seller balance or reservation');
    return BigInt(value);
  };
  const { terms } = state, base = terms.base.id, fee = units(balances.feeTnk);
  const needed = { [base]: units(terms.baseAmount) };
  needed.TNK = (needed.TNK ?? 0n) + fee;
  const reserved = Object.fromEntries(Object.keys(needed).map(asset => [asset, 0n]));
  for (const name of store.list('trade-')) {
    const s = store.get(name)?.state;
    if (!s || s.role !== 'signer' || s.tradeId === state.tradeId || s.phase !== 'holding' || s.txHash ||
        s.terms.seller.tracAddr.toLowerCase() !== terms.seller.tracAddr.toLowerCase() || now >= s.terms.sendBy + s.terms.graceSec) continue;
    if (s.terms.base.id in reserved) reserved[s.terms.base.id] += units(s.terms.baseAmount);
    // v0.1.32 has already-acked holding records without a recorded fee; reserve the currently quoted fee for them.
    reserved.TNK += units(s.sellerFundsReservation?.feeTnk ?? balances.feeTnk);
  }
  const available = Object.fromEntries(Object.keys(needed).map(asset => [asset, units(balances[asset]) - reserved[asset]]));
  const strings = amounts => Object.fromEntries(Object.entries(amounts).map(([asset, value]) => [asset, value.toString()]));
  return { ok: Object.keys(needed).every(asset => available[asset] >= needed[asset]), feeTnk: fee.toString(),
    needed: strings(needed), available: strings(available), reserved: strings(reserved) };
}
