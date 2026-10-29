# Signer strike settings

Seller and buyer strikes are disabled by default. The signer configuration accepts:

```json
{
  "strikes": { "enabled": false }
}
```

Only a boolean is accepted, and the setting applies only to signer roles.
With strikes disabled, a signer records no new strikes and refuses no buyer or seller
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

## Buyer nonpayment

With the same setting enabled, a buyer receives a strike only after both traders signed the terms, their Trac
addresses were proved, and the seller could deliver the amount plus fees. The signer observes venue and committee
heartbeats, seller funds, the buyer's Solana reader and RESET gateway health every 15 seconds. A missed observation
window, restart, disabled period, failed send/read, or qualifying signed infrastructure notice exempts the trade.
If a deal was received, at least k matching signer acknowledgements must have been seen before the lock-start cutoff.

After `sendBy + graceSec`, finalized Solana readers must agree that no matching payment attempt exists. The read
uses a complete `getProgramAccounts` payer scan, including when no deal hash was sent, fenced after finalized clocks
past that deadline. Unsupported scans, stale clocks and ambiguous reads cannot produce a strike. Any matching
active, claimed or refunded payment attempt exempts; this does not authorize settlement. Late payment or authenticated
transfer/refund evidence removes a strike and any dependent pause.

Two strikes within seven days refuse that proven buyer address for seven days from the second strike, across DEX
identity changes. Buyer and seller ledgers are independent. Venue bid hiding requires k current signers' signed pause
notices. Notices and clears persist and are retried in bounded batches without delaying signer heartbeats.

`strikes list` includes a `buyers` ledger alongside the existing seller fields. Clear a buyer on each affected signer:

```sh
node bin/dex.mjs strikes clear --buyer <Trac-address> --identity <DEX-public-key> --config /path/to/signer.json
```

Deploy the venue and signers for bid hiding and buyer enforcement; retain their stores. Traders need no update for
normal trading or enforcement. Updated traders display the buyer-specific refusal; older strict-schema traders ignore
that new refusal code and can show their existing timeout instead. No minimum-version change is made. Trades without
address proofs cannot create address-wide strikes, just as with seller strikes.

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
