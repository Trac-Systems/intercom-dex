# Changing service fees

The running service owns fee changes through its authenticated loopback control API.
Its config needs `control.port`, a private `control.tokenFile`, Solana endpoints and
`registry.fee.platformFeeBps` (integer 0–500). The initial collector is the service's
main Solana key and must already have its matching finalized trade config. The
platform fee must match the finalized global platform config before any registry
can be published.

```sh
node bin/dex.mjs fee set --config /absolute/service.json --trade-fee 0.75 --signer-share 60
node bin/dex.mjs fee set --config /absolute/service.json --signer-share 50
node bin/dex.mjs fee platform --config /absolute/service.json --bps 30 --authority-keypair /absolute/authority.json --yes
node bin/dex.mjs balances --config /absolute/service.json
node bin/dex.mjs withdraw --config /absolute/service.json --asset USDC --amount all
```

Percent inputs have at most two decimal places. Trade fees range from 0 to 10%,
signer shares from 0 to 100%, and platform plus trade fees cannot exceed 15%.
Every trade-fee change creates a new encrypted collector key, even when returning
to a rate already present in its collector history. A signer-share-only change keeps the current collector.
The main Solana wallet pays the transaction fee and funds the collector's config
rent in the same transaction. The deployed program requires that collector's
signature and uses it as the instruction's rent payer.

The service waits for finality and reads the config back before publishing the next
registry version. Retry an interrupted command with the same values; startup also
resumes pending changes. The operation id is saved before key creation and is kept
with the encrypted key. Config writes use the existing signed-transaction journal.
Older collectors, registry versions and fee configs remain available for old trades.
Service settlements and signer credits identify the collector from those terms.

Fee changes persist in the encrypted service records. They override the initial
`config.registry.fee` after a restart; the config file itself is not rewritten.
Back up the entire encrypted data directory, including `keyring.json` and `records`.
Service wallet export includes every collector key as well as the main key.

The platform command prints a warning and requires `--yes`. Its authority file must
be an absolute Solana keygen JSON file, owned by the current user, regular, not a
symlink, and mode 0600. The key is used only for signing and is never saved in service
records or the keyring. After a crash before signing, repeat the command with the
file. A journaled transaction can resume without reopening that file. Changing the
global platform fee prevents old terms that have not locked from locking:
`platform fee changed, take again`. Already locked trades settle their stored fees.

Service USDC balances expose `collectedFees` and `collectors` alongside the total.
Configure `payout.solana` before withdrawing. `--amount all` / `dex_withdraw` sweeps
all funded collector vaults, with one journaled transaction per collector, and sends
any main-wallet USDC in a separate transaction. Each collector transaction withdraws
to its own token account and transfers to the payout address atomically, because the
escrow program requires a collector-owned withdrawal destination. A specific amount
uses collectors in creation order, then the main wallet. Pending sweeps resume the
saved parts; responses include each collector's amount, signature and outcome.

Control routes (service only, same bearer token as `/withdraw`):

- `POST /fee/set`: `{ "tradeFee": "0.75", "signerShare": "60" }`; at least one is required.
- `POST /fee/platform`: `{ "bps": 30, "authorityKeypair": "/absolute/authority.json", "yes": true }`.

Both routes return the resulting registry. `/status` includes `fee`, `feeAccounting`
per collector, and signer payout credits tagged with their collector.

The local stack scenario is `DEX_PROOF_ZKEY=/absolute/proving.zkey node tests/e2e/stack.mjs fee-change`.
It holds a taken trade after signed terms, rotates the venue fee, then checks that
the old trade and a new trade finish with exact token balances in both fee vaults.
