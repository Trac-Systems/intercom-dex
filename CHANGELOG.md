# Changelog

## 0.1.36

- When a buyer refunds and the seller never sent tokens, the amount returns to the seller's open offer,
  including after a restart. Recorded or uncertain transfers still count as consumed.
- Wallet commitments, dashboard offer sizes and trade history follow the same rule.
- Restored offers are announced once immediately, then on the normal schedule. Cancelled and expired offers
  stay closed.
- A buyer lock that never landed on Solana no longer holds the buyer's USDC for 48 hours: once the lock
  transaction has provably expired without an escrow, the trade ends and the USDC is free again, including for
  trades already stuck in that state.
- Works with 0.1.32 and later; no minimum-version change.

## 0.1.35

- Trades waiting for a refund no longer repeat old messages, so their proof-of-work no longer slows new trades
  ("Reveal arrived too late", "Accept slot outside the freshness window").
- New trade negotiations are stamped before repeated trade dealings.
- Sellers stop repeating transfer messages once the verification window has closed.
- Reconnect recovery, missing-share requests and automatic refunds are unchanged. Works with 0.1.32 and later;
  no minimum-version change.

## 0.1.34

- Traders prove control of their Trac addresses before new trades are admitted.
- Signers check seller funds and pause sellers who repeatedly leave funded trades unsent. Changing DEX identity
  does not clear a proven wallet's strikes.
- Updated apps explain refused trades immediately. Makers reject takes that cannot cover the trade and fees.
- Offers under still-valid older fee or registry terms remain visible.

Upgrade signers, then the venue and market feeds, then traders. Raise the registry minimum to 0.1.34 last to
activate proofs. Traders must update and repost open offers; committed trades retain settlement and recovery.
See the [rollout instructions](docs/OPERATORS.md#activating-trac-address-proofs-0134). No collateral or trading
deposit is required.
