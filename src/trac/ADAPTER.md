# Runner adapter and peer commands

`src/trac/adapter.js` implements the Trac side of `src/core/API.md`'s runner
contract. It uses the agent's authenticated `Bridge.call(type, params)` connection
to its own Pear peer. The peer verifies signed state; the Node agent owns wallet
encryption, durable observation times, and transaction reservations.

## Peer configuration

Start with `cd peer && npm start -- --config /absolute/config.json`. Choose
`network: "mainnet"` to use the complete source pins in `networks/mainnet.json`.
Local tests override only their deployment data, for example:

```js
network: 'local',
peer: {
  // MSB/deployment values are supplied by the local stack.
  trac: { reset: {
    bootstrap: '<local RESET subnet bootstrap, 64 lowercase hex characters>',
    channel: 'local-foundation-subnet',
    dhtBootstrap: ['127.0.0.1:<local DHT port>'],
    beaconOptions: { /* local fixture checkpoint and parameters */ }
  } }
}
```

The profile supplies `source: {commit, manifestSha256}` for the vendored RESET
tree. The peer verifies SOURCE.json and every listed file before importing.
Only local tests may supply `source.directory` for another verified vendor tree.
`beaconOptions` is accepted only with `environment: 'development'`; mainnet
uses the vendored release's own launch configuration. Paths cannot be supplied
by trades or gateways. See `docs/NETWORKS.md` for the complete fields.

The runtime opens the reader under `<storeDirectory>/reset-reader`, using the
same local MSB bus, UTF-8 transaction content hashing, and the configured RESET
contract/protocol. Its transaction and message APIs and background transaction
observer are disabled. It refuses an already-admitted writer identity. The
runtime closes both the reader and its Corestore before closing MSB. The
profile-enabled runtime always supplies the RESET reader. The lower-level helper
can omit it, in which case RESET context, balances and verification fail closed.

`peer/src/trac/handlers.js` exports:

```js
makeHandlers({ bus, peer, config, resetPeer = null }) // -> command map
```

The bridge supplies `message.params` as each handler's argument and wraps the
return value in `{type:'<command>_result',result}`. Commands:

| Command | Parameters | Result |
| --- | --- | --- |
| `dex_balances` | `{address}` | `{TNK,RESET,feeTnk}` |
| `dex_msb_info` | `{}` | `{networkId,txv,addressPrefix,msbBootstrap,feeTnk}` |
| `dex_tnk_broadcast` | `{payload}` | `{txHash}` |
| `dex_reset_context` | `{}` | `{networkId,txv,addressPrefix,subnet,msb}` |
| `dex_verify` | `{asset,txHash,from,to,minAmount,nonce}` | `{ok,reason,amount,final}` |

`feeTnk` is an integer **base-unit string**, currently `30000000000000000`.
TNK handler addresses are bech32m; RESET handler addresses are public-key hex.
The RESET writer key intentionally comes from the gateway prepare response.
The verifier remains bound to the local trusted RESET bootstrap.

`peer/src/trac/reset-reader.js` exports the runtime helper
`openResetReader({bus,config,walletAt}) -> Promise<Peer|null>`; `walletAt` is the
runtime's existing wallet loader. Ordinary agents use the bridge instead.

## Trader wallet

```js
await createWallet(absoluteFile, password) // -> wallet; refuses overwrite
await openWallet(absoluteFile, password)   // -> wallet
wallet.publicKey                          // 64-character lowercase hex
wallet.address                            // checksummed trac1 address
wallet.sign(hashBytes)                    // 128-character signature hex
wallet.close()                            // wipes the in-memory secret
```

The wallet exposes no secret. It generates a fresh 32-byte Ed25519 secret and
encrypts it with scrypt (`N=131072,r=8,p=1,dkLen=32`, fresh 16-byte salt) and
XChaCha20-Poly1305 (fresh 24-byte nonce). Version, KDF parameters, cipher, public
identity, salt and nonce are authenticated as associated data. The file is
created exclusively with mode 0600, flushed before returning, and cannot be
overwritten. Opening requires a regular 0600 file, rejects symlinks, fixes the
KDF parameters rather than accepting arbitrary work factors, and checks the
decrypted identity. Wrong passwords and tampered ciphertext/metadata fail.
Signing accepts exactly 32 hash bytes. `close()` is idempotent; signing afterward
throws. Passwords and plaintext keys are neither logged nor returned.

## Adapter API

```js
const adapter = createTracAdapter({
  bridge, wallet = null, resetGatewayUrl = null, usedTxFolder = null,
  intentFolder = null
});

await adapter.sendTransfer({ terms, tradeId, resume = false });
// {type:'transferSent', now, tradeId, ok:true, txHash, sentAt}
// or {type:'transferSent', now, tradeId, ok:false, unknown:true, txHash, sentAt, reason}
// or {type:'transferSent', now, tradeId, ok:false, reason}

await adapter.gatewayHealth({ fresh = false });
// {ok, eligible, checkedAt, reason}; checkedAt is Unix milliseconds
adapter.gatewayHealthStatus(); // cached snapshot; unknown or stale is ok:false

await adapter.verifyTransfer({
  asset, txHash, from, to, minAmount, nonce, tradeId, finalBefore
});
// {type:'transferVerified', now, tradeId, txHash, asset, from, to, nonce,
//  ok:true, final:true, amount, finalizedAt, usedBy?}
// or the same event identity with ok:false, final, reason and available evidence

adapter.reserveTx({ txHash, tradeId }); // -> {ok,reservedFor}, or failure + reason
adapter.close();                       // closes Node journal handles
```

The factory is synchronous. `wallet` is needed only to sign a new transfer, and
must match `terms.seller.tracAddr`. A recorded transfer can resume without the
wallet. `resetGatewayUrl` is an explicit HTTP(S) origin without
credentials/path/query/fragment; it is needed for RESET health checks and sends. An absolute
`intentFolder` is mandatory for sending; use the same folder across restarts.
An absolute `usedTxFolder` is mandatory for positive verification and reservations.
Each journal has an exclusive native file lock. Close the adapter after its
pending operations finish. The caller owns the wallet and bridge;
closing the adapter does not close either.

RESET health uses GET /v1/state with the same origin validation, redirect refusal,
30-second timeout and 64 KiB response limit as gateway transfer calls. Only an
integer validators.eligible of at least 3 permits a new transfer. Results,
including failures, are cached for less than 15 seconds; concurrent reads share
one request. A new transfer forces a read before preparing, and checks health
and the deadline again before signing if preparation was slow. A refusal at
either check leaves no signature or intent. Existing intents bypass this gate
and continue reconciliation of the exact recorded bytes.

The runner supplies approved terms and their trade ID. The adapter reads
`pair`, `baseAmount`, `seller.tracAddr`, `buyer.tracAddr`, and `sendBy`; full terms
schema/ID validation remains in the core. Both assets use bech32m addresses at
this boundary. RESET addresses are converted to public-key hex for the gateway
and peer, then normalized back to the original terms addresses in events.
Amounts are exact base-unit strings. `transferNonce(tradeId)` agrees with the
core: SHA-256 of the domain followed by the raw 32 trade-ID bytes.

TNK signing uses context from `dex_msb_info`, then submits through
`dex_tnk_broadcast`. RESET prepares `/v1/tx/prepare` with the chosen nonce and
compares its identities, amount, nonce, exact dispatch, network ID, `txv`, subnet,
MSB bootstrap and content hash with locally established expectations. It
recomputes the transaction hash before invoking the wallet signer, then posts
`/v1/tx/submit`. Both paths validate the returned transaction hash. The adapter
checks `sendBy` before signing and again before submission. `sentAt` is the local
Unix second when the signed intent was prepared, preserved on every retry. It is
not proof of submission or timely execution: a crash can happen before the first
broadcast. Signers judge timeliness from their own durable final observations.
Every submission, including a retry, must start strictly before the deadline.

Before submission, `intents.jsonl` durably records the trade ID, asset, addresses,
amount, deadline, exact signed payload (and RESET submission), hash, creation time
and `sentAt`. The file and new directories are fsynced, and concurrent sends for
one trade are serialized. Journal records include a checksum to detect accidental
corruption; malformed, truncated, conflicting or duplicate records fail closed.
A failed flush prevents broadcast. Journal integrity assumes trusted local storage;
the checksum is not an authentication mechanism.

Repeated calls, including `resume:true`, read this intent before signing or gateway
preparation. Changed transfer terms are rejected with the existing hash retained.
The adapter asks `dex_verify` about that exact hash. A matching final transfer
returns success without another broadcast. Before `sendBy`, a nonfinal result
allows re-broadcasting the same payload/submission. At or after `sendBy`, recovery
only reconciles: anything other than matching finality, including a read error,
returns `{ok:false,unknown:true,txHash,sentAt,reason:'past_send_deadline'}`.
The deadline is checked again when the lookup finishes. No new signature, nonce,
txv, or hash is created, and reconciliation leaves the journal untouched.
A missing intent can be created on resume only while the initial deadline
permits it. Submission errors, malformed receipts, and failed reconciliation
preserve `{unknown:true,txHash,sentAt}`. A crash between
journaling and the network call is conservatively treated as a possible submission.
A bare failure means this call has no recorded or attempted submission to report.
The runner must keep unknown results in recovery and pass their hashes to signers;
it must not treat them as safely unpaid. `ok:true` reports network acceptance or
matching finality; share release still requires separate signed verification.

MSB currently accepts TNK only when `tro.txv` equals its current indexer sequence
state (`PartialOperationValidator.validateTransactionValidity`). Recovery first
checks finality, then attempts the identical signed transaction only before
`sendBy`. An expired-txv rejection remains unknown if the signed view has not
proven the transfer. The peer's `unknown_or_not_final` result cannot distinguish
absence from an unsigned
or lagging record, so **this adapter never rebuilds an intent**, even after txv
expiration. It has no proof of definite absence. Preserve the journal for further
reconciliation; clearing it could enable a second payment.

`src/trac/intents.js` exports the Node storage helper
`openIntentStore(absoluteFolder) -> {get(tradeId), save(intent), close()}`.
`get` returns an isolated copy or `null`; `save` appends exactly one immutable
intent per trade and refuses replacements. The adapter owns its record schema.

Without a matching durable observation, verification calls `dex_verify` and
requires both `ok === true` and `final === true`, plus the **exact** requested
amount. Pending/unknown records, failed contract results, and all mismatches
remain failures. The supplied nonce
must also match this trade ID. A runner that wants to wait for finality should
poll pending results before delivering `transferVerified` to the core; the
core treats a failed verification event as an abort.

## Durable finality and replay

Before returning successful verification, the adapter appends the observed
signed fact and local Unix-second observation time to `finality.jsonl` and
fsyncs it. The first successful matching observation is preserved across calls
and process restarts; it is never replaced with a later or earlier clock value.
Conflicting, duplicate, truncated or malformed journal records fail closed, as
do write/flush failures. A persisted observation in the future relative to the
current clock is rejected. The first observation must occur **strictly before**
`finalBefore`. Before any network read, verification looks for an exact match on
`(asset, txHash, from, to, amount, nonce)` in this journal. A persisted timely
observation returns success, subject to local reservation and clock checks,
including at/after the cutoff and after restart while the bridge is unavailable.
Current time does not revoke it. A matching observation first seen at/after the
cutoff returns `{ok:false,final:true,reason:'finality_deadline',finalizedAt}`
without a network read. When a network read is needed, thrown read errors and
`read_failed` results return `ok:false,final:false`; an unavailable read is not
proof that timely finality never existed. This is a local observation time, not
a retrospectively proven chain timestamp.

Verification does not reserve a transaction. For the core's
`persist(scope:'verifiedTransfer')` action, call `reserveTx` and emit the
`persisted` event with `txHash` and returned `reservedFor` only after `ok:true`.
Reservations use the existing append-only, fsynced `used-tx.jsonl` journal.
Same-trade retries are idempotent; another trade receives `ok:false` with the
actual reservation owner. Verification also rejects an existing conflicting
reservation and rechecks after its asynchronous peer call. Sharing one Node
adapter/store between concurrent signer trades prevents a check/reserve race
from authorizing both trades' share releases.

This Node-side placement resolves the earlier Bare `fsync` limitation for role
runners. The Pear process performs only chain reads/broadcasting and does not
open the durable replay journal.

## Tests

```sh
source ~/.nvm/nvm.sh && nvm use 23.11.0
node --test tests/unit/trac/*.test.mjs
node --test --test-concurrency=1 tests/integration/trac/*.test.mjs
```

The integration test starts RESET's Pear devnet fixture, funds two freshly
encrypted wallets under `.test-tmp/trac/adapter/`, and starts one dex peer through the
same Pear runner used by `npm start`. Its bridge uses an available loopback port.
The test covers both assets, chosen-nonce gateway preparation, signed finality,
wrong amount/nonce, cross-trade replay, strict deadlines, and journal reopening.
It also drops accepted TNK/RESET submission responses, verifies the retained
hashes, resumes without wallets, and checks that repeated sends leave the receiver
with exactly one payment. Unit tests exercise concurrent retries, failed fsync,
crash/reopen, expired txv, conflicting terms, deadline crossing during a lookup,
no rebroadcast at/after `sendBy`, and offline recovery of timely finality facts.
`local-devnet.mjs` redirects two reference-fixture modules to disposable local
copies so network artifacts stay under the test's disposable folder; no RESET source files
are changed and the existing Pear runner/contract/network are used. XDG paths
isolate the child processes without overriding HOME.
It stops its own dex runner by its exact child PID and closes all fixture
processes. No existing keystores, live services, or real funds are used.

The suite also runs the lower-level signed-reader tests for accepted TNK/RESET,
TNK fees, replay reservations, and RESET contract rejection after MSB acceptance.

## Wallets and source pins

`peer.trac.reset.source: {commit, manifestSha256}` identifies the canonical
`peer/vendor/reset/SOURCE.json`. All ten listed sources are verified before import.
Only local tests accept `source.directory`; mainnet refuses overrides. See
`docs/NETWORKS.md` for exact pins and canonical manifest bytes.

`walletOptions(profile)` reads the profile environment's MSB derivation path and
prefix and checks its network id. `createWallet(file, password, {profile,
mnemonic?, onMnemonic?})` stores an encrypted v2 mnemonic backup and returns only
the signing capability. `openWallet(file, password)` also opens legacy v1 files.
`walletMnemonic(file, password)` is used by the terminal-only owner export.

The adapter adds `balances(address?) -> {TNK, RESET, feeTnk}` through
`dex_balances {address}`. Reads use signed MSB node entries and the pinned RESET
reader's signed `bal/<pubkey>` view, never gateway balance claims.
The two signed reads run concurrently with a five-second deadline each; timed-out
checkouts close and failures identify MSB or RESET. Concurrent requests for one
address share a pending read, but completed balance results are not reused for
trading or withdrawal checks. Missing signed blocks are unavailable data, not a
zero balance. A RESET read timeout refreshes replica discovery and frees one
reader connection, at most once per 30 seconds, without restarting the reader.
Dashboard values may be retained for display after a failed refresh, with a
warning and the original successful-read timestamp; the trade ticket does not
use those stale values as available funds.

`withdrawalStatus({id, asset, to, amount}) -> {ok, unknown, txHash?, reason?}`
checks the matching durable intent and signed finality. Without a journaled intent
the withdrawal was never sent (`unknown:false`). A final mismatch is definite
(`unknown:false`). A transfer that is not final once its send deadline passed is
broadcast again with the exact journaled bytes (MSB and the RESET contract accept a
hash once); errors of that broadcast change nothing. The wallet manager uses
`sendTransfer({terms, tradeId})` with a fresh withdrawal id and a durable
300-second send deadline, and confirms from this transfer evidence, not from
balances. See `docs/WALLETS.md`.
