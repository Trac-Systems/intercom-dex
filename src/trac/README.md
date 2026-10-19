# Trac transfer helpers

The [runner adapter, encrypted wallet and bridge configuration](./ADAPTER.md)
build on these low-level helpers.

All amounts are **integer base-unit decimal strings**. TNK uses 18 decimals and
a uint128 transfer amount; RESET uses 8 decimals and accepts positive canonical
integer strings of at most 78 digits. TNK `from`/`to` are checksummed `trac1…`
addresses. RESET `from`/`to` are 32-byte public keys encoded as lowercase hex.
Hashes, nonces, writer keys and bootstraps are lowercase hex.

## API

`src/trac/transfers.js` runs in Node:

```js
transferNonce(tradeId) // -> 64-character hex SHA-256

await buildTnkTransfer({
  networkId, txv, from, to, amount, tradeId,
  sign, addressPrefix = 'trac'
}) // -> { type: 13, address, tro: { tx, txv, to, am, in, is } }

await buildResetTransfer({
  networkId, txv, writer, subnet, msb, from, to, amount, tradeId,
  sign, addressPrefix = 'trac'
}) // -> { payload: { type: 12, address, txo }, submission }
```

`sign(hashBytes)` may be synchronous or asynchronous and returns a 64-byte
Ed25519 signature as lowercase hex. The builders verify it against `from`.
They do not open wallets or create keys. `submission` has exactly
`{tx, prepared_command, address, signature, nonce}` for the existing RESET
gateway `/v1/tx/submit` API or `broadcastResetTransfer` below.

`peer/src/trac/broadcast.js`:

```js
await broadcastTnkTransfer(msb, payload) // -> { txHash, final: false }
await broadcastResetTransfer(peer, submission) // -> { txHash, final: false }
```

The first argument is a `MainSettlementBus` instance for TNK, or an admitted
RESET writer peer exposing `peer.protocol.instance.api.tx` for RESET.
The caller should use a separate read-only RESET peer for verification.
Broadcast errors propagate. A broadcast receipt never proves finality.

`peer/src/trac/verify-transfer.js`:

```js
const verifyTransfer = createTransferVerifier({
  msb, resetPeer = null, resetBootstrap = null
});
await verifyTransfer({ asset, txHash, from, to, minAmount, nonce });
// -> { ok: boolean, reason: string | null, amount: string | null, final: boolean }
```

The MSB instance supplies `state.getSigned(hash)` and its trusted configuration.
For RESET, the constructor checks `resetPeer.base.key` against the independently
configured trusted RESET bootstrap. The peer must execute the actual RESET
contract with the correct network/checkpoint configuration. No gateway response,
balance difference, or caller-supplied transaction record serves as proof.

`peer/src/trac/used-tx.js`:

```js
const store = openUsedTxStore(absoluteFolder);
store.get(txHash); // -> tradeId | null
store.claim(txHash, tradeId); // -> { ok, reason: null | 'tx_already_used' }
store.close(); // idempotent
```

Claims are synchronous, append-only, flushed before acknowledgment, and protected
by an exclusive native file lock. Repeating the same claim is idempotent; another
trade cannot claim that transaction. The store reads and validates the complete
journal on reopening and refuses truncated, duplicate, or invalid records. An
I/O failure poisons the open handle; reopen and inspect the journal before
continuing. It never truncates or silently repairs a journal. Persist a successful
claim **after verification and before publishing a share**. This store is for a
single local signer process on a local filesystem, not shared network storage.

## Wire encoding and fees

The chosen nonce is SHA-256 of UTF-8 `intercom-dex/v1/transfer` followed by the
**decoded 32 bytes of tradeId**, without a separator. This raw-byte interpretation
is an explicit interface assumption; the other protocol areas must use the same
encoding.

TNK hashes, with BLAKE3, the concatenation of network ID (uint32 BE), `txv`
(32 bytes), recipient address (ASCII), amount (uint128 BE), nonce (32 bytes), and
operation type 13 (uint32 BE). The amount excludes the existing MSB fee of
30,000,000,000,000,000 base units (0.03 TNK).

RESET uses dispatch `{type:'transfer',value:{to,amount}}`, serialized in that
property order with `JSON.stringify` and hashed as UTF-8 using BLAKE3. Its TX
preimage is network ID, `txv`, writer, dispatch hash, RESET bootstrap, MSB
bootstrap, nonce, operation type 12, in the exact MSB/trac-peer order. The verifier
accepts this UTF-8 content encoding; it does not accept the old broken string
hash encoding for new DEX transfers. RESET also needs TNK for its MSB TX fee.

`txv` comes from `msb.state.getIndexerSequenceState()` (or
`peer.msbClient.getTxvHex()`). It hashes the current indexer keys; it is not a
transaction timestamp or an expiring blockhash. Read it from the local MSB node
when building a transfer and rebuild if the indexer set changes before acceptance.

## Final-state proof

TNK: `msb.state.getSigned(txHash)` checks out the MSB Hyperbee at its signed
length. A decoded type-13 record is only written after transfer validation,
balance updates and fee application succeed. The verifier checks the record's
hash, sender, recipient, positive amount and nonce. It never calls unsigned state.

RESET: the type-12 MSB record must target the trusted RESET and MSB bootstraps.
The verifier then opens **one snapshot at the RESET view's signed length**, reads
`tx/<txHash>` to obtain the transaction index (including index zero), and reads
`txi/<index>`. That record is `{val, err, tx, ipk, wp}`. It must identify the same
transaction and sender, contain the exact transfer command, match the MSB content
hash, and have `err === null`. For an overspend, MSB can accept and charge the TX,
but the signed subnet record contains `err: 'balance'`, so verification rejects
it. The contract stores balances under `bal/<publicKey>`; balances alone are not
transfer evidence.

`unknown_or_not_final` means the transaction is absent from the MSB signed view.
A signed-only reader cannot distinguish a transaction that has not arrived from
one that exists only in unsigned state. Both are rejected with `final: false`.
`reset_not_final` means MSB has finalized it but no signed subnet result exists.
`contract_rejected` has `final: true` and `ok: false`: the failed result is final.
Callers must require **both** `ok` and `final`.

Other rejection reasons are `wrong_asset`, `invalid_request`, `read_failed`,
`invalid_msb_record`, `reset_reader_required`, `wrong_contract`,
`invalid_reset_record`, `wrong_content`, `wrong_from`, `wrong_to`, `wrong_nonce`
and `wrong_amount`. Amount checks use BigInt and accept amounts at least
`minAmount`.

`getTransactionConfirmedLength(hash)` can report an MSB history sequence, but a
sequence is not a timestamp and its history scan is unnecessary for this proof.
Neither final record carries trustworthy wall-clock finalization time. Enforcing
`sendBy + grace` requires the signer/caller to durably record when it first saw
a matching final result; this helper does not claim to prove that deadline
retrospectively.

## Runtime limitation

The installed peer dependency `bare-fs@4.5.0` lacks `fsync`/`fsyncSync` and omits
the `O_SYNC` constant even though its flag parser accepts `as`. Consequently,
the replay journal **runs only under Node** and explicitly refuses to open in
that Bare runtime. The runner adapter opens it in the signer's Node process
and acknowledges reservations only after flushing. Pear runs the chain verifier
and bridge commands. Do not move the journal into Bare or replace its refusal
with an unflushed append.

Production signers need their own replicating MSB node and a read-only RESET
subnet peer executing RESET's exact contract and network configuration. A signer
does not need a subnet writer role. Nodes must stay synchronized; missing signed
data never authorizes release. TNK senders need a validator connection; RESET
senders need an admitted writer/gateway to publish the bound signed dispatch.

## Validation

```sh
source ~/.nvm/nvm.sh && nvm use 23.11.0
node --test tests/unit/trac/*.test.mjs
node --test tests/integration/trac/devnet.test.mjs
```

The integration test invokes the same `startDevnet({pear:true})` fixture as
`node scripts/devnet.mjs --pear`. It uses its private test control handles to fund
fresh trader identities under `.test-tmp/trac/`, without opening devnet player
keystores. It connects its own MSB and RESET readers through the local DHT,
checks successful transfers, mismatches and replay, and submits an overspend
which MSB accepts and RESET rejects. It closes its own readers and all fixture
processes. Logs and per-run timing JSON remain under `.test-tmp/trac/`.
