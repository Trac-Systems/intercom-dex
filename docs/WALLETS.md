# Trader wallets

Configure peer.json and trader.json, proof files, RPC/gateway endpoints and the control port/token path. Run node bin/dex.mjs start --config /absolute/trader.json; the hidden prompt or DEX_KEY_PASSWORD supplies the password (at least 12 characters). MCP with DEX_CONFIG attaches to that trader or uses the same background launcher when its environment has the password. Closing MCP leaves the peer and trader running. DEX_CONTROL_URL and DEX_CONTROL_TOKEN_FILE remain attach-only.

The first role start creates `dataDir/keyring.json` and
`dataDir/trac-wallet.json`. The former contains the Solana key, DEX identity,
box key and encrypted-record key. The latter contains the Trac mnemonic and
MSB derivation path. Both files use scrypt-131072-8-1 and XChaCha20-Poly1305,
are mode 0600, and are never overwritten. The data folder is mode 0700.
The profile's installed MSB config supplies the mnemonic derivation path and
address prefix. TNK and RESET share one `trac1` address; USDC and SOL share
one Solana owner address. No automatic setup path prints a mnemonic.

`trac.walletFile` can place the encrypted Trac wallet elsewhere.
`keyPasswordEnv` names the password setting; an existing `trac.passwordEnv`
can name a separate Trac password. These are environment variable **names**,
never password values. Keep the passwords separately from backups. Back up the
whole data folder (including encrypted trade/withdrawal records and transaction
journals), plus a separately configured Trac wallet file. Legacy seed-only Trac
files can still sign; they have no recoverable mnemonic and cannot export one.

Call MCP `dex_wallets {}` when the owner asks how to trade. Explain its addresses,
confirmed balances, fee minima, committed and free amounts, file paths, environment
variable names, backup/export command and payout settings. The authenticated
local `GET /wallets` route returns the same object. `GET /status` / `dex_status`
include a short `wallets` object. Nothing returns private keys or mnemonic words.

All balance strings are integer base units; each asset includes `decimals`.
USDC has 6, SOL 9, TNK 18 and RESET 8. `wallet` is the chain wallet balance
(plus the service's collected fee vault for USDC). `balance` also includes known
active buyer escrow. `committed` includes open offers, running trades, escrow,
fee reserves and unresolved withdrawals; `free` never goes below zero.
Open buys reserve quote plus the independently rounded platform/venue fees.
Maker trades replace the corresponding offer reservation instead of doubling it.
Expired/cancelled offers release their remainder; completed/refunded trades release
reservations. An unknown lock stays reserved in the wallet. A known lock is shown
in escrow until claim/refund. Seller funds remain conservatively reserved until
settlement, including while their transfer is unconfirmed. Reservations can exceed
available funds after fees or an externally submitted payment; free then is zero.

The code reserves at least 10,000,000 lamports (0.01 SOL) and 60,000,000,000,000,000
TNK units (0.06 TNK), increasing reserves with open offers/trades and the MSB's
current fee. These are operational reserves, including SOL account rent, rather
than a promise of an exact transaction fee. Read confirmed balances again after
withdrawal fees have been charged. New offers/takes and withdrawals serialize
balance admission within the role.

MCP `dex_withdraw {asset, amount, to?}` and local `POST /withdraw` accept a decimal
token amount or `"all"` (all currently free units). By default `to` is required
and the agent uses the destination its owner supplied. Optional config
`payout: {solana?: "<base58 pubkey>", trac?: "<checksummed trac1 address>"}`
locks each chain to that destination; omission selects the lock, and another
address is refused. The service requires `payout.solana` for withdrawals.
A payout lock is recommended for every trader: setup reports the missing locks in
`payoutLock`, and an agent should propose them to its owner. Without one, a
withdrawal can go to any address an agent was given.
USDC creates the destination owner's ATA idempotently with the trader paying.
SOL and USDC destinations, and `payout.solana`, must be wallet addresses: an
off-curve address (a token account address, a program address) is refused, and so
is an existing account owned by the SPL Token or Token-2022 program ("This is a
token account, give the wallet address"). For SOL, an account owned by any program
other than System is refused too. `payout.solana` is checked this way at start.
The service can withdraw both wallet USDC and collected trade fees atomically
through its collector ATA. Trac transfers use the existing signed builders,
gateway/bridge and durable intent journals; TNK pays MSB fees.

A withdrawal request is saved in the encrypted store before signing. Each asset
allows one unresolved withdrawal. Its outcome comes from the transaction itself,
never from live balances, which trades and deposits move as well:

- `confirmed`: Solana returns the finalized transaction with the exact journaled
  bytes, `err: null`, and the amount arriving at the destination in the
  transaction's own balance records (lamports for SOL, the destination's USDC
  account for USDC). Trac needs a final signed transfer of the journaled hash with
  the same sender, destination, amount and nonce.
- `failed`: the transaction is proven rejected, or proven never executed. On Solana,
  after the blockhash expired, a signature status search with transaction history
  that every answering endpoint returns empty proves it never executed; this is
  only decided within 6 hours of signing, while that search still covers it. A
  request with no signed transaction in the journal (a crash before signing) was
  never sent. A failed withdrawal no longer reserves its amount; withdraw again.
- `unconfirmed`: anything else. `dex_wallets` and startup check it again without
  ever signing a second payment. A Trac transfer that is still not final after its
  5-minute send window is broadcast again with the same signed bytes, which the
  network accepts at most once.

A Trac transfer has no proof of absence: a signed transfer stays valid until the
MSB indexer set changes, so one that never becomes final stays `unconfirmed`.
Repeating a withdrawal of that asset returns the existing record with
`existing:true`. Keep its journals.

Optional owner commands (absolute config paths):

```sh
node bin/dex.mjs setup --config /absolute/role.json
node bin/dex.mjs setup --config /absolute/role.json --import-solana /absolute/solana-keypair.json
node bin/dex.mjs setup --config /absolute/role.json --import-trac-mnemonic
node bin/dex.mjs setup --config /absolute/role.json --import-reset-keystore /absolute/reset-keystore
node bin/dex.mjs balances --config /absolute/role.json
node bin/dex.mjs withdraw --config /absolute/role.json --asset USDC --amount 1.25 --to <owner-address>
node bin/dex.mjs withdraw --config /absolute/role.json --asset RESET --amount all
node bin/dex.mjs export --config /absolute/role.json --out /absolute/new-backup-directory
```

Setup refuses existing wallet files. It shows a newly generated mnemonic once on
stderr with a backup notice. Mnemonic imports and RESET-keystore passwords use
hidden terminal input, never argv. Solana imports require a private 0600
solana-keygen JSON file. RESET imports accept the authenticated v1
scrypt-32768-8-1/AES-256-GCM signer keystore and check its derivation and address.
Balances/withdraw commands call the running role's authenticated control API,
sharing its reservation and withdrawal function.

Export is owner-only: there is no MCP or dashboard export endpoint. It always asks
for a hidden terminal password, ignoring environment passwords. The new directory
is 0700 and every file is 0600. An existing directory is refused. It prints only
filenames. Trader exports retain `solana-keypair.json` and `trac-mnemonic.txt`.
The exported files contain plaintext secrets and must be kept private.

## Venue backup and recovery

The service keyring holds the DEX identity that traders pin as `serviceKey`, the
box key, the record-store encryption key, the main Solana rent/fee payer, and
every retained fee collector. Losing or regenerating the identity breaks traders'
existing pin. The platform authority stays in an owner-managed Solana keypair file
outside the venue and is never included in its keyring, records or exports.

Every trader, signer and market feed keeps each registry version it has seen. A
venue that signs a known version number again with different content (a new
version 1 after a lost data folder, for example) makes all of them record a
conflict and stop trading until each one clears its data. So the venue refuses to
start without its stored registry. Only the first start of a brand-new venue
passes `--first-launch`:

```sh
node bin/dex.mjs --config /absolute/service.json --first-launch
```

The flag has no effect once a registry is stored. A new registry version is always
numbered above every version in the data folder.

For an ordinary backup, stop the service, copy the entire data folder, and remember
the keyring password separately. Keep the service config and peer configuration
and data as well. To restore, copy the data folder onto the new machine, point
`dataDir` at it, set the original password environment variable, and restart with
the same `serviceKey`. The records contain registry history, signer credits,
settlements, pending operations and signed transaction journals; preserve them.

The plaintext disaster-recovery route can give the restored keyring a new password:

```sh
node bin/dex.mjs export --config /absolute/service.json --out /absolute/new-venue-export
node bin/dex.mjs restore --config /absolute/new-service.json --from /absolute/new-venue-export
```

Stop the venue before exporting so its keyring and saved records form one backup.
Export writes `MANIFEST.json`, `identity-<dex public key>.json`,
`box-<box public key>.json`, `store-key.json`, `solana-main-<base58>.json`, and
`collector-<base58>.json` for every collector, and `venue-records.json`. The
identity, main and collector files contain 64-byte solana-keygen arrays; the X25519
box and symmetric store files contain 32-byte arrays. The manifest records roles,
purposes, public keys, collector operation IDs and fee bps. The symmetric store key
has a SHA-256 fingerprint instead of a public key. `venue-records.json` holds the
records a venue cannot rebuild: every registry version (`service-registry`,
`service-registry-v<n>`, `service-registry-published`), `service-fee-policy` and
`book-sequence`; the manifest lists their names and SHA-256. Other records
(credits, settlements, journals) are not exported.

Restore requires an absent or empty `dataDir`, verifies the private directory and
file modes, validates the manifest and derived public keys, checks `serviceKey`
when configured, then asks for a new terminal password of at least 12 characters.
It writes an encrypted `keyring.json`, writes the exported venue records into the
new store, and prints public keys and record names only. The restored venue starts
without `--first-launch` and continues its registry versions and fee policy. If the
old `records/` folder survived, copy it into this new data folder as well, without
replacing the new keyring; the recovered store key decrypts it unchanged. Keep
every journal. Credits, settlements and pending payments come only from those
records. An export made before records were included holds keys only: then the
venue refuses to start until the old `records/` folder (or at least its
`service-registry*` records) is back.
Export and restore never take passwords from argv or environment variables.

Audit the recovered venue before operating it:

```sh
node bin/dex.mjs keys check --config /absolute/service.json
node bin/dex.mjs keys check --config /absolute/service.json --authority-keypair /absolute/platform-authority.json
```

Set the service config's `serviceKey` to the same DEX identity pinned by traders.
The audit opens the keyring with a terminal password, then uses the configured
Solana RPC quorum at `finalized` commitment. It reports main-wallet lamports and
rent for another collector config, each collector's config/bps and USDC vault,
and membership of the latest published registry collector in the keyring.
An older installation must publish a registry once with this version before the
audit can verify its publication marker. Optional authority checking compares the
file's public key with the platform config authority, platform collector, and
escrow programdata upgrade authority, and reports the profile mint's platform
vault balance. Every line begins with `OK` or `PROBLEM`; any problem gives exit 1.
This command never sends a transaction or changes records.

## Platform fee withdrawal

```sh
node bin/dex.mjs fee withdraw-platform --config /absolute/service.json \
  --authority-keypair /absolute/platform-authority.json --to <owner-base58>
node bin/dex.mjs fee withdraw-platform --config /absolute/service.json \
  --authority-keypair /absolute/platform-authority.json --to <owner-base58> \
  --mint <spl-mint-base58> --amount 1.25
```

This service-only owner command works without the running service control API.
It asks for the keyring password to open the encrypted journal. The authority
file must be an absolute, owner-held, regular 0600 solana-keygen file. Its public
key must match both platform authority and collector. The authority pays Solana
transaction fees and any token-account rent. Its secret buffer is wiped immediately
after signing and on every exit path; neither the secret nor file path is saved.

`--mint` defaults to the profile's USDC mint. Other standard SPL Token mints are
supported with their on-chain decimals. `--amount` defaults to `all`; an empty
vault prints `Platform fee vault is empty` and succeeds. Withdrawal goes through
the authority's ATA as required by the program, creating it idempotently. A
different `--to` receives an onward transfer in that same atomic transaction.
The command prints the finalized transaction signature after verifying its exact
signed bytes and vault/destination token balance deltas from transaction metadata.

A native process lock prevents concurrent owner withdrawal commands in one data
folder and releases automatically on process death. The request, mint, destination,
exact base-unit amount and signed transaction are journaled before sending. After
an interruption repeat the same command: an unfinished request keeps its original
amount and signature, including when `all` now sees an empty vault. A different
request is refused until the unfinished one resolves. Repeating a completed request
while the vault balance is unchanged replays its signature (or the empty message
for `all`), covering a crash after saving completion but before printing. New fees
or a different destination/amount allow a new withdrawal. Missing finalized
history or balance evidence leaves the request pending, without a replacement
payment. Retain the data folder and journals when moving machines.
## Wallet commitments for locks

A lock is separate from both traders' ordinary wallets. While funding is pending, its RESET, TNK or USDC counts
as committed in the funding wallet. After finality, those funds are external locked balances, not spendable
wallet money. Lock accounting adds `breakdown.locks` for pending wallet commitments and `breakdown.locked`
for funded external locks. A pending opening, repayment or exercise reserves its payment until reconciliation.
Do not count the same funding twice or spend a pending payment's reservation through a withdrawal.

Keep enough free USDC for automatic loan repayment or call exercise, and RESET or TNK for the put holder lock at take. Keep SOL and
TNK for network fees. The `tnkReserve` inside a RESET lock funds its final transfers and is distinct from wallet
fees. Opening fees go directly to the locks registry collector; put escrow funding also includes the program's
escrow fees. [LOCKS.md](LOCKS.md) describes the payment rules and refund conditions.

Back up the complete locks data directory, the separate identity and box key, registry snapshots, sealed
releases, payment intents and signed transaction journals. Keep encryption passwords separately. Recovery
reconciles pending transactions instead of signing a second payment. Do not delete a pending journal because
a payment or sweep is slow. Status and events expose public facts only, never scalar shares or signing keys.

RESET/TNK locks rely on enough signers surviving and retaining their shares; they cannot be refunded without the
threshold. For put USDC locks, the writer may refund through the escrow after `refundAfter` while unclaimed.
Losing the writer's wallet key also loses its ability to sign that refund. See [operator backups](OPERATORS.md#running-lock-signers-and-a-locks-venue).

Lock admissions, spot trading and withdrawals share the wallet admission queue. Pending holder funding and the
full opening amount are reserved before a put take. Final lock funds appear outside the spendable wallet.
Network reserves include the pending funding transfers and a SOL allowance for each active position.
Opening fees are deducted from the maker receipt, with exact total, fee and net amounts shown. Put exercise
spends only Solana network fees on a signed memo. Early release is usually 1–2 hours after payment.
Signers can be replaced by handover while at least k survive; a put writer can refund after `refundAfter`.
