# Changelog

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
