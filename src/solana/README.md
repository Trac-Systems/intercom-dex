# Solana escrow layer

The decoders implement the deployed program's account layouts.
Only EscrowState v3 (263 bytes) and config v1 (68 bytes) are accepted. Keys returned by
PDA helpers and decoders are `PublicKey`; token amounts and signed timestamps returned
by decoders are `bigint`. Builders accept PublicKey-compatible keys and exact integer
amounts (`bigint`, decimal string, or safe integer). Fee bps are numbers.

## Program binary

`vendor/ln_usdt_escrow.mainnet.so` contains 137,936 bytes. Its SHA-256 is:

```
8dee3f57f64b23511246572270410f58c6fa9089bd96e7abddfdcae512dd2fc2
```

The local chain tests load this binary at the public program address in
`networks/mainnet.json`. The platform config uses version 1, bump 254 and a
10 bps fee. Its address is `GYEkMpHz9MEFiGjhLJTB3WC4itkVVk1ySn3jvSDhA2ig`;
the collector is pinned in the network profile. The adapter verifies the
on-chain config before sending a transaction.

## Fee and lifecycle behavior

For net amount `N`, platform bps `P`, and trade bps `T`:

```
platformFee = floor(N * P / 10000)
tradeFee    = floor(N * T / 10000)
deposit     = N + platformFee + tradeFee
```

The payer deposits `deposit` tokens and pays transaction fees and rent separately in
SOL. Each fee is floored independently in base units; no floats are used. Caps are
P <= 500, T <= 1000, total <= 1500 bps; deposit must fit u64. For N=1,234,567, P=10,
T=50, fees are 1,234 and 6,172, and deposit is 1,241,973.

Init creates the escrow and missing vault ATAs, stores the fee snapshot, and requires
both supplied fee-bps expectations to match the configs. Only the configured recipient
can claim with a 32-byte SHA-256 preimage. Claim pays N to the recipient and moves fees
to their respective PDA-owned vaults. Claim does **not** check time; after the refund
deadline, claim and refund race. Only the stored refund authority can refund, at chain
Unix time >= refundAfter; refund returns net plus both fees and charges no token fees.
Both paths zero stored amounts and mark the escrow inactive; the hash cannot be reused.
They transfer the recorded amounts, leaving any unsolicited surplus in the vault.

Config authority must equal its collector; a trade config is seeded by that collector.
SetConfig/SetTradeConfig can change bps but cannot rotate the collector. Withdrawal
requires that collector's signature and a destination token account owned by it, of
the same mint. Amount 0 means withdraw the entire fee-vault balance. No automatic ATA
creation is done for claim, refund, or withdrawals; callers supply existing accounts.

## Public API

`constants.js`: `PROGRAM_ID`, `USDC_MINT`, `USDC_DECIMALS`, `PLATFORM_CONFIG`,
`DEFAULT_ENDPOINTS` (ordered public RPC URLs), `DEFAULT_SLOT_TOLERANCE` (32 slots), `PROGRAM_ERRORS`
(Rust custom error codes 1–17).

`escrow.js`:

```js
deriveEscrowPda(paymentHashHex, programId = PROGRAM_ID) // {pda, bump}
deriveConfigPda(programId = PROGRAM_ID)                 // {pda, bump}
deriveTradeConfigPda(feeCollector, programId = PROGRAM_ID) // {pda, bump}
deriveVaultAta(owner, mint)                            // PublicKey, any of the three PDA owners
escrowAddresses({paymentHashHex, mint, tradeFeeCollector, programId = PROGRAM_ID})
// {escrowPda, bump, configPda, tradeConfigPda, vault, platformFeeVault, tradeFeeVault}
calculateFees(amount, platformFeeBps, tradeFeeBps)
// {netAmount, platformFeeAmount, tradeFeeAmount, totalAmount}

buildInitConfigInstruction({payer, feeCollector, feeBps, programId = PROGRAM_ID})
buildSetConfigInstruction({authority, feeCollector, feeBps, programId = PROGRAM_ID})
buildInitTradeConfigInstruction({payer, feeCollector, feeBps, programId = PROGRAM_ID})
buildSetTradeConfigInstruction({authority, feeCollector, feeBps, programId = PROGRAM_ID})
buildWithdrawFeesInstruction({feeCollector, destination, mint, amount = 0n, programId = PROGRAM_ID})
buildWithdrawTradeFeesInstruction({feeCollector, destination, mint, amount = 0n, programId = PROGRAM_ID})
buildInitInstruction({payer, payerTokenAccount, paymentHashHex, recipient, refund,
  refundAfter, amount, mint, expectedPlatformFeeBps, expectedTradeFeeBps,
  tradeFeeCollector, programId = PROGRAM_ID})
buildClaimInstruction({paymentHashHex, preimageHex, recipient, recipientTokenAccount,
  mint, tradeFeeCollector, programId = PROGRAM_ID})
buildRefundInstruction({paymentHashHex, refund, refundTokenAccount, mint, programId = PROGRAM_ID})
// All builders return TransactionInstruction, derive every PDA/ATA, and do not perform IO.

decodeEscrowState(data)      // v, status, paymentHashHex, recipient, refund, refundAfter,
                           // mint, netAmount, platformFeeAmount/Bps/Collector,
                           // tradeFeeAmount/Bps/Collector, vault, bump
decodeConfigState(data)     // {v, authority, feeCollector, feeBps, bump}
decodeTradeConfigState(data) // same config fields

await buildTransaction({connection, payer, instructions, signers = [],
  computeUnitLimit, computeUnitPriceMicroLamports})
// {tx, blockhash, lastValidBlockHeight}; signs but never sends.
```

Compose any builder with `buildTransaction` to prepare its transaction, e.g.
`await buildTransaction({connection, payer: buyer, instructions: [buildInitInstruction(args)]})`.
The caller owns submission and confirmation using the returned blockhash strategy.

`rpc.js`:

```js
new RpcError(kind, message, details = {})
await rpcCall(endpoint, method, params = [], {timeoutMs = 5000} = {}) // JSON-RPC result
await readAccount(endpoint, address, {timeoutMs = 5000, minContextSlot, commitment = 'confirmed'} = {})
// {slot, value: null | {data: Buffer, owner: string, lamports: number, executable: boolean}}
```

RPC errors have `kind`: http, protocol, rpc, network, timeout, or stale. RPC-server
errors include `code`/`data`; HTTP errors include `status`. Invalid caller inputs throw
TypeError/RangeError. Unsafe JSON integer lamports and malformed base64 fail closed.
Account reads default to confirmed commitment and also accept finalized; the default public endpoint list is
only consumed by account reads. The timeout covers response headers **and body**.

`quorum.js`:

```js
new QuorumError(message, reports)
await readAccountQuorum(address, {endpoints = DEFAULT_ENDPOINTS, need = 2,
  timeoutMs = 5000, slotTolerance = 32, minContextSlot, commitment = 'confirmed', unanimous = false} = {})
// {value, slot, newestSlot, agreeing: endpoint[], reports}
```

Every endpoint is queried in parallel. Data bytes, owner, lamports, and executable
flag must match. Reports contain endpoint, slot, digest and status (`agreed`,
`disagreed`, `stale`, `error`), plus error details when applicable. Missing accounts
can agree as null. The freshness tip (`newestSlot`) is the highest slot that a
majority of the successful readers reached, and at least `need` of them: the
k-th newest successful slot with k = max(need, floor(successes / 2) + 1). Readers
reporting a far-ahead slot therefore cannot make the others stale. Votes >32 slots
behind that tip are excluded. The returned `slot` is the need-th newest agreeing
slot; one far-ahead endpoint cannot veto a quorum or advance its next read fence.
With `unanimous: true` (safety reads) the read also fails when any reader that
answered, stale or not, reported different account bytes.
Duplicate canonical URLs, insufficient
votes, and multiple distinct qualifying groups are rejected. `minContextSlot` is
requested and independently checked; vault reads use the escrow's agreed slot.

This is majority agreement, not a proof of chain truth. Endpoint independence is the
caller's responsibility; URL paths do not establish independent providers. Two
identically lying endpoints can satisfy need=2 when nobody else answers, and every
endpoint could be equally stale. The tests explicitly demonstrate that limitation.
Two lying endpoints next to correct ones produce no quorum, whatever slot they
report. `checkEscrow` (the seller's send decision, venue settlement proofs and
recovery fences), the adapter's fee config reads and every `createFeeReader` read
are unanimous. Balance reads are not. The 32-slot tolerance is configurable and has
not been tuned in production.

`check.js`:

```js
await checkEscrow({terms, hashHex, endpoints, need = 2, timeoutMs = 5000, slotTolerance, minContextSlot,
  programId = PROGRAM_ID, commitment = 'confirmed', purpose = 'lock'})
// {ok, reasons: [{code, message}], address, state, reads: {escrow?, vault?}}
```

Consumes the existing `src/core/schemas.js` terms names: `seller.solRecipient`,
`buyer.solPayer`, `mint`, `quoteAmount`, `refundAfter`, and
`fees.{platformFeeBps,tradeFeeBps,platformCollector,collector}`. Requires positive
quoteAmount and exact integer fields. Additional core terms fields are left to core
validation. No fallback aliases are accepted. Callers must validate signatures,
committee, sendBy/refundAfter timing, and acks before trusting a verdict to send base.

Checks program ownership, layout, status, hash/PDA bump, parties, mint, exact net,
exact refund time, both fee bps/collectors and fee math, derived vault address, and a
quorum-read classic SPL vault's mint, authority, state, controls and net-plus-fee
balance. Extra vault tokens are accepted, but the stored net must equal the signed
quote amount. Low-level reads default to confirmed; the runner adapter defaults to
finalized for decision checks. Neither snapshot reserves an escrow against a
subsequent claim/refund.

## Runner adapter

```js
createSolanaAdapter({endpoints, sendEndpoint, need = 2, keypair = null,
  programId = PROGRAM_ID, commitment = 'confirmed', finality = 'finalized',
  intents = null, mint = USDC_MINT,
  timeoutMs = 3000, confirmationTimeoutMs = 20000})

await adapter.lockEscrow({terms, hashHex})
// {ok:true, hashHex, signature} | {ok:false, reason}
await adapter.checkEscrow({terms, hashHex, purpose = 'lock'})
// {ok, hashHex, purpose, status, reasons?}
await adapter.claim({terms, hashHex, preimageHex})
// {ok:true, claimSignature} | {ok:false, reason}
await adapter.refund({terms, hashHex})
// {ok:true, refundSignature} | {ok:false, reason}
// All three mutation methods can instead return an unresolved submission:
// {ok:false, unknown:true, hashHex, signature, reason}
await adapter.pendingIntents()
// [{id, signature, ageMs, createdAt, attempt}]; throws if journal loading fails
await adapter.lockOutcome({terms, hashHex})
// {ok:true, outcome:'none'|'landed'|'unknown'} | {ok:false, reason}; never signs or broadcasts
await adapter.finalizedSlot() // finalized slot number; throws on unavailable quorum
const watch = adapter.chainWatch({ onUpdate }) // pushed slots (slotSubscribe) from up to 3 of the RPC nodes; watch.start(),
                                                // watch.view(maxAgeMs) -> {finalized, tip, at} or null, watch.stop()
await adapter.firstFinalizedBlockAtLeast(minSlot)
// {slot, blockhash: 32-byte lowercase hex, finalized:true}; throws if unprovable
await adapter.ensureTradeConfig({feeBps}) // {ok:true, signature: string|null} | {ok:false, reason}
await adapter.tradeFeeBalance() // base-unit decimal string; throws on unavailable/invalid reads
await adapter.withdrawTradeFees({amount, to}) // {ok:true, signature} | {ok:false, reason}

// Generic, explicitly configured read quorum used by the adapter:
await readRpcQuorum(method, params, {endpoints, need = 2, timeoutMs = 3000,
  select = value => value, unanimous = false}) // {value, reports}; throws QuorumError

// Used by the wallet manager:
await adapter.walletWithdrawalStatus(id)
// {ok:true, unknown:false, signature, slot} | {ok:false, unknown:false, signature?, reason} (rejected, or proven
// not executed) | {ok:false, unknown:true, signature, reason}
await adapter.accountOwner(address) // owning program (base58) or null; finalized
await adapter.chainTime() // Clock sysvar unix seconds at confirmed commitment: median of >= need readers
```

`mint` is an optional constructor extension for **service fee operations**, defaulting
to USDC. Lock/check/claim/refund always use `terms.mint`. It allows the integration
suite's local mint without changing global constants. `to` means an existing SPL
token account owned by the service collector, not a wallet address. `amount` is a
base-unit string; `"0"` uses the program's withdraw-all convention. Service methods
require the service keypair; read-only trader checks and finality need no keypair.
The adapter uses the already installed `bs58@4.0.1` dependency of web3; manifests
were not changed.

Result mapping follows `src/core/API.md`. Active checks have `ok:true,status:'active'`.
Missing accounts and unavailable quorum give `ok:false,status:'missing'|'pending'`.
Actual differences give `ok:false,status:'mismatch',reasons:[{code,message}]`.
A settlement check returns `ok:true,status:'claimed'|'refunded'` after verifying
immutable account terms and the original successful lock transaction; lock-purpose
checks for either terminal status have `ok:false`. Amounts are zeroed by the program,
so account data alone cannot prove the original net amount after settlement.
The adapter verifies the signed transaction and its init bytes against the terms.
Unavailable transaction history stays pending. Successful idempotent claim/refund
calls return the actual quorum-verified historical settlement signature, including
after creating a new adapter instance. Once the configured finality exposes a verified
claim and its settlement receipt, calling `claim` again needs no preimage. Finalized
account state can become visible before receipt history; retry while that history is
unavailable. A verified refunded escrow makes
`claim` return exactly `{ok:false, reason:'escrow_refunded'}`.

`finality` accepts `confirmed` or `finalized`, defaulting to `finalized`. Seller lock
checks, settlement checks, their receipt history and refund Clock checks use it.
Submission `commitment` is separate and defaults to `confirmed`: a mutation can
return success before a default decision check sees the change. Callers poll checks
until the required state is visible. Recovery always uses finalized expiry and
account reads, even when `finality:'confirmed'` is explicitly selected.

The low-level `check.js` settlement mode checks the stored account/vault invariants
and zeroed amounts only; use the adapter for the historical original-amount proof.
History inspection currently supports the legacy transactions emitted by this layer,
examines the newest 100 successful account-history entries within a bounded search,
and fails closed if the needed receipts are unavailable or unsupported.

The runner adds `type`, `tradeId`, and its own `now` when delivering core events;
the adapter does not own protocol time or validate core signatures/committee/acks.
Signed terms retain the core field names described above. Refund eligibility itself
uses a quorum read of the chain Clock sysvar, never the runner's or machine's clock.
Local time is used only for operation timeout deadlines and intent ages.

Every decision read uses need-of-N identical responses: accounts/configs/balances,
Clock, signature statuses, blockhashes/heights, transaction receipts and finality.
Confirmation waits for the selected commitment (`confirmed` or `finalized`). Finality
selection queries finalized `getBlocks` ranges to establish skipped slots, compares
the first block's hash, and refuses requests older than quorum `getFirstAvailableBlock`.
The test URL aliases reach one local validator and do **not** represent independent
production providers. The matching-dishonest-majority limitation still applies.

Submission retries resend the **same signed transaction** while it can still land.
Mutations are serialized per adapter. After finalized block height exceeds its
last-valid height, recovery rechecks a signature-status quorum and reads finalized
escrow state fenced at a finalized slot observed after expiry. Only proof that the
intent was not executed permits a fresh signature. A confirmed/finalized receipt
or matching terminal state resolves the original attempt; unavailable or conflicting
evidence retains it as unknown. This prevents overlapping live attempts for one
intent. Later `checkEscrow` calls can find a lock whose submission response was lost.

Buyers call `lockOutcome` every 60 seconds while locking or uncertain, and on resume.
It proves a dropped lock only when finalized block height is past the journaled
`lastValidBlockHeight`, signature history unanimously has no status, and a subsequent
fenced finalized escrow read finds no account. A finalized failed signature and absent
escrow also prove nonexecution. A matching escrow means `landed`; unavailable,
conflicting or incomplete evidence means `unknown`. A missing journal entry cannot
prove that a lock never ran. The core aborts a proven dropped lock with `Lock did not go through`
and releases its wallet commitment without waiting for `refundAfter`.
Before returning `none`, the adapter saves the terminal `not-executed` phase.
Subsequent lock calls, including queued host retries and calls after restart,
cannot sign or resend that intent. A failed terminal journal write keeps the
outcome unknown; the buyer retains its commitment until the verdict is durable.

Inject `intents: {get(id), put(id, value), delete(id)}` for restart recovery. Methods
may be synchronous or asynchronous. Because this interface has no enumeration
method, the adapter stores one journal snapshot (`{v:1, entries:[...]}`) under
`solana-intents/v1/<program>/<signer-public-key>`; the argument named `id` is that
journal key, not an individual intent id. Store implementations must make each
write/delete atomic and durable before resolving. One adapter writer may own a
given program/wallet namespace at a time; cross-process locking and separate stores
for different chain networks belong to the caller. The adapter does not open a
filesystem or wallet store itself. Omitting
`intents` retains pending state only in memory.

Signed bytes, signature, `lastValidBlockHeight` (also retained as the older `height`
field), intended terms and a `lastBroadcastAt` timestamp in milliseconds are saved
before every broadcast. Startup validates
the journal and reconciles entries before any new mutation; it does not broadcast
automatically. Calling the original method resumes the attempt. Journal failures
prevent new broadcasts. Protect stored signed claim bytes: they contain the preimage.
`pendingIntents()` exposes ids, signatures, ages, creation times and attempt counts,
without signed bytes; completed, rejected and terminally retired entries are excluded. Definite validation
or first-attempt preflight failures return `{ok:false,reason}`. Unresolved submitted
escrow transactions add `unknown:true`, `hashHex` and the attempted `signature`.

Older lock entries that have neither expiry-height field wait at least ten minutes
since `lastBroadcastAt` and require the signed blockhash to be invalid at finalized
commitment, in addition to absent signature status and escrow. If the broadcast date
is also missing, startup persists `legacyObservedAt` and waits the full interval from
there; `createdAt` cannot substitute because it survives replacement attempts.
An old `height` field alone still supplies exact expiry evidence. The signing cutoff
for any new or replacement lock remains `sendBy - LOCK_START_MARGIN_SEC`.

Service configuration and withdrawal submissions also use the journal. A balance
cannot prove whether a withdrawal executed. After expiry, its signature status is
read again with `searchTransactionHistory` and `unanimous`: when every answering
reader returns `null`, the withdrawal never executed and becomes `retryable`; this is
decided only within 6 hours of the first signature, while that history search still
covers it, and otherwise stays unknown. A finished wallet withdrawal is confirmed
from its finalized `getTransaction`: the exact journaled bytes, `err: null`, and the
amount arriving at the destination in the transaction's balance records (lamports
for SOL, the destination's USDC account for USDC). A wallet withdrawal id without a
journal entry was never signed. After an acknowledged withdrawal, a later
invocation is a new request; callers must not retry acknowledged withdrawals.

## Validator lifecycle

The harness uses bounded HTTP polling (15-second confirmation, 3-second HTTP
requests), aborts outstanding requests when its child exits, and records exit code
and signal. Market setup uses instruction builders and the same bounded send
function. Shutdown waits at most two seconds for SIGTERM, then two for SIGKILL,
with exit observation installed at spawn; repeated stop calls share one cleanup
promise. `startValidator({maxLifetimeMs = 140000})` limits validator lifetime;
the expiry test uses 300 seconds. The lifecycle test stops its child during
confirmation and checks that the pending operation and repeated stop complete.

The harness uses RPC 18899, WebSocket 18900, faucet 19900, gossip 18001 and dynamic
ports 18010 to 18060. RPC and proxy servers bind to 127.0.0.1; validator 1.18 can
also open wildcard sockets for its other services. Every validator has a fresh
ledger and generated keys under `.test-tmp/solana/`.

## Test commands

Run from the repository root; integration tests are sequential because ports are shared:

```sh
source ~/.nvm/nvm.sh && nvm use 23.11.0 && node --test 'tests/unit/solana/*.test.mjs'
source ~/.nvm/nvm.sh && nvm use 23.11.0 && node --test --test-concurrency=1 'tests/integration/solana/*.test.mjs'
```

Individual chain suites:

```sh
source ~/.nvm/nvm.sh && nvm use 23.11.0 && node --test tests/integration/solana/escrow.test.mjs
source ~/.nvm/nvm.sh && nvm use 23.11.0 && node --test tests/integration/solana/adapter.test.mjs
source ~/.nvm/nvm.sh && nvm use 23.11.0 && node --test tests/integration/solana/lifecycle.test.mjs
source ~/.nvm/nvm.sh && nvm use 23.11.0 && node --test tests/integration/solana/recovery.test.mjs
```

The unit suite covers fee/deposit vectors, all result statuses, malformed RPCs,
quorum disagreements, wrong roles, missing historical proof, same-byte retry and
ambiguous-response recovery, durable restart/crash recovery, safe expired-attempt
replacement, finality selection, lone future-slot outliers and chain-clock refunds.
The chain suite covers escrow instructions, adapter lock/check/claim/settlement,
refund/idempotency, altered terms, fee configuration creation/update/withdrawal,
and deterministic finalized-block lookup from two local URL aliases. The recovery
chain test hides a successful lock response, observes it at default finalized
commitment, then drops a claim, waits for actual finalized blockhash expiry and
restarts with the durable journal before successfully replacing the claim.
