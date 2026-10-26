const sol = lamports => {
  const n = BigInt(lamports), fraction = (n % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${n / 1_000_000_000n}${fraction ? '.' + fraction : ''}`;
};

// Unlike the advisory check of a remote taker, our seller must establish it can pay to receive its USDC.
export async function requireSellerClaimFunds({ solana, address, mint, collector }) {
  let funds;
  try { funds = await solana.claimFunds({ address, mint, collector }); }
  catch (error) {
    throw new Error(`Cannot check SOL needed to receive USDC at ${address}: ${error?.message ?? error}. Try again before selling.`);
  }
  if (!funds.ok) throw new Error(`Add at least ${sol(funds.shortfall)} SOL to ${address} to receive USDC ` +
    `(${sol(funds.required)} SOL needed for the claim fee${BigInt(funds.rent) > 0n ? ' and USDC account rent' : ''}).`);
  return funds;
}
