# Signer strike settings

Seller strikes are disabled by default. The signer configuration accepts:

```json
{
  "strikes": { "enabled": false }
}
```

Only a boolean is accepted, and the setting applies only to signer roles.
With strikes disabled, a signer records no new strikes and refuses no seller
because of existing strikes. Saved strike records remain available for inspection.
`GET /status` reports `strikes.enabled`, and startup logs report the effective
setting. Keep the setting disabled while transfer infrastructure is unavailable.

## Infrastructure failures

When strikes are explicitly enabled, each held trade samples seller balances
every 15 seconds. RESET trades also check gateway health. A failed balance or
transfer read, a read taking more than 30 seconds, fewer than three eligible
gateway validators, unavailable health, or an unconfigured gateway exempts the
trade. A failed balance read before acknowledgement also counts.

Observation runs from admission through the transfer deadline and finality
grace period. A read started in that window delays strike evaluation until it
finishes. Exemptions persist with the trade and are not cleared by a later
successful read. A window interrupted by a signer restart or observed with
strikes disabled cannot produce a strike retrospectively.

A signed abort from the trade's seller that identifies a read or gateway
failure also exempts the trade. Generic send failures do not. Signers forward
qualifying notices and accept them through the refund deadline. An exemption
cancels a strike for that trade. It does not prove payment or release a signer
share: settlement still requires verified transfer evidence.

## Updating signers

1. Retain role storage and make a backup before updating.
2. Keep `strikes.enabled` false and update one signer role at a time.
3. Verify its startup message and authenticated `GET /status` report strikes
   disabled. Wait for the signer committee to return before updating the next
   signer. Already acknowledged trades retain their settlement and recovery.
4. Inspect existing strike records with the commands in
   [the operator guide](OPERATORS.md#activating-trac-address-proofs-0134).

The setting is not part of the signed registry. No registry minimum-version
change or trader update is required to disable strikes.

Keep the data folder when rolling back. Strike-capable versions without this
setting enforce their own strike policy and cannot honor these exemptions;
review that behavior before reverting.
