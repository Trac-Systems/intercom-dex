// Opening fees come out of the maker's receipt; the taker pays the displayed total.
export function openingAmounts(product, terms, fee) {
  const total = BigInt(product === 'loan' ? terms.principal : terms.premium);
  const bps = product === 'loan' ? fee.loanBps ?? fee.bps : fee.optionBps ?? fee.bps;
  if (total <= 0n || !Number.isSafeInteger(bps) || bps < 0 || bps > 1000) throw new Error('Invalid opening fee');
  let charge = total * BigInt(bps) / 10000n;
  if (product !== 'loan') { const minimum = BigInt(fee.optionMin ?? '0'); if (minimum < 0n) throw new Error('Invalid opening fee'); if (minimum > charge) charge = minimum; }
  if (charge > total) charge = total;
  return { opening: total.toString(), openingTotal: total.toString(), openingFee: charge.toString(), makerReceives: (total - charge).toString() };
}
