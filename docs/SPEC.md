# intercom-dex protocol specification

intercom-dex is a non-custodial exchange between Trac-side assets (TNK and RESET) and USDC on Solana. Coordination
runs over Intercom sidechannels. The only on-chain program is the existing Solana escrow program
`4RS6xpspM1V2K7FKSqeSH6VVaZbtzHzhJqacwrz8gJrF` (sha256 hashlock, refund time, any SPL mint, a global platform fee
and a per-collector trade fee). RESET's contract, MSB and the escrow program are used as they are.

All times are integer Unix seconds unless a unit is given. Amounts are decimal strings of integer base units. Keys
and hashes are lowercase hex. `stableJSON` is JSON with object keys sorted, no whitespace, and only plain objects,
arrays, strings, finite numbers, booleans and `null`.

## 1. Roles and processes

One program, `bin/dex.mjs`, runs one of three roles, chosen by the `role` field of its config:

| Role | Does | Keys |
| --- | --- | --- |
| `service` (the venue) | Publishes the signer registry, the order book, tickers and the trade log; checks reported trades on both chains; accounts signer credits; collects the trade fee. | dex identity (Ed25519), box key (X25519), store key, main Solana key, one Solana key per fee collector |
| `signer` | Holds one sealed share per trade it serves, verifies the seller's Trac transfer on its own node, publishes the share. | dex identity, box key, store key |
| `trader` | Posts and takes offers, runs the buyer or seller side, locks, sends, claims and refunds. | dex identity, box key, store key, Solana key, Trac wallet |

Each role runs next to its own peer process (`peer/`, on the Pear runtime): Hyperswarm, the dex sidechannels, an
MSB client, a read-only RESET subnet reader and a local bridge. The role talks to its peer over an authenticated
WebSocket on 127.0.0.1. The peer's own wallets are network identities only; every dex message is signed by the
role's dex identity. Keys at rest are kept in one keyring per role (scrypt N=131072, r=8, p=1 and
XChaCha20-Poly1305); the trader's Trac wallet is encrypted the same way.

Every role and peer chooses `network: "mainnet"` or `network: "local"`. The profile in `networks/` pins the USDC
mint, the escrow program, the platform fee collector, the MSB network and the RESET subnet and source. Mainnet
refuses any config value that changes a pin. Details are in [NETWORKS.md](NETWORKS.md).

## 2. Channels

| Channel | Writers | Kinds |
| --- | --- | --- |
| `intercom-dex` | the venue's peer only | `registry`, `book`, `bookDelta`, `ticker`, `tradeLog`, `status` |
| `intercom-dex:offers` | anyone | `offer`, `cancel`, `settled` |
| `intercom-dex:chat` | anyone | `chat` |
| `intercom-dex:signers` | anyone | `summon`, `heartbeat`, `sharePublish`, `shareRequest` |
| `intercom-dex:t:<offerId>` | anyone | `take`, `accept`, `decline`, `reveal`, `abort`, `present` |
| `intercom-dex:t:<tradeId>` | anyone | `terms`, `termsSig`, `deal`, `working`, `ack`, `transferSent`, `sharePublish`, `shareRequest`, `claimed`, `refunded`, `abort`, `present` |

All channels are open to join. On `intercom-dex` the transport accepts and relays only content signed by the
venue's peer key (`servicePeerKey`). A receiver acts only on the kinds each sender may send in that place: only the
venue key on `intercom-dex`, only the two traders and the committee on a trade channel, and only the committee
member at index i for share i.

## 3. Envelope

Every message is an envelope:

```json
{ "v": 1, "kind": "<kind>", "ch": "<channel>", "from": "<64 hex Ed25519 key>", "ts": 0, "nonce": "<64 hex>", "body": {}, "sig": "<128 hex>" }
```

`sig` is Ed25519 (strict verification) by `from` over `"intercom-dex/v1\n" + stableJSON({v, kind, ch, from, ts,
nonce, body})`. A receiver rejects an envelope with extra keys, an unknown `kind`, a body that fails its exact
schema (extra keys are refused everywhere), a bad signature, a `ts` more than 120 seconds in the future or older
than the receiver's window (120 seconds on public channels; the trade's lifetime on trade channels, so members who
join late can check earlier messages), or a repeated `(from, nonce)`. Replay caches fail closed when full. On public
channels each sender key first fills its own cache of 512 entries, so one key cannot fill a receiver's shared cache.
Chat uses a 300-second window in both directions; its body `ts` must equal the envelope `ts`.

## 4. Message kinds

Field types: `hex32` is 64 lowercase hex characters; `units` is a decimal integer string; `price` is a decimal
string with at most 12 decimals; `trac1` is a checksummed Trac address; `sol` is a base58 Solana public key.

| Kind | Sent by | Body |
| --- | --- | --- |
| `chat` | any peer on `intercom-dex:chat` | `text` (1 to 280 characters, trimmed, one line without control characters), optional `name` (1 to 24 ASCII letters/digits/spaces/`._-`, not containing `venue`, `system`, `admin`, `exchange`, `intercom`, `official`, `moderator` or `support`), `ts`. Receivers remove bidirectional controls and zero-width characters from `text`. |
| `offer` | maker | `offerId`, `pair`, `side` (`buy`/`sell`), `baseAmount`, `price`, `maker` {`dexKey`, `tracAddr`, `solAddr`}, `peerKey`, `expiresAt`, `registryVersion`, `software` |
| `cancel` | maker | `offerId` |
| `take` | taker | `offerId`, `pair`, `registryVersion`, `software`, `baseAmount`, `taker` {`dexKey`, `tracAddr`, `solAddr`}, `commitment`, `sendBy`, `refundAfter` |
| `accept` | maker | `offerId`, `takeCommitment`, `commitment`, `slot` |
| `decline` | maker | `offerId`, `takeNonce`, `reason` (`busy`, `insufficient`, `signers`, `expired`, `invalid`, `version`) |
| `reveal` | both traders | `offerId`, `takeCommitment`, `nonce` |
| `commit` | none | `offerId`, `commitment` (defined in the schema; no role sends it) |
| `terms` | both traders | `tradeId`, `terms` |
| `termsSig` | both traders | `tradeId` (the signed envelope is the trader's signature of the terms) |
| `summon` | buyer | `tradeId`, `terms`, `sigs` (both `termsSig` envelopes) |
| `working` | buyer | `tradeId`, `step: "certificate"` |
| `deal` | buyer | `tradeId`, `k`, `committeeBoxKeys`, `H`, `commitments`, `sealedShares`, `proof` |
| `ack` | committee signer | `tradeId`, `H`, `holdUntil` |
| `transferSent` | seller | `tradeId`, `txHash` |
| `sharePublish` | committee signer | `tradeId`, `H`, `signerIndex` (1-based), `share`, `commitments` |
| `shareRequest` | seller, venue | `tradeId` |
| `claimed` | seller | `tradeId`, `claimSignature` |
| `refunded` | buyer | `tradeId`, `refundSignature` |
| `abort` | trader | `tradeId` (or the `offerId` before terms), `commitment` (optional), `reason` |
| `present` | trade member | `ref` (the offer or trade ID of the channel) |
| `settled` | seller | `offerId`, `tradeId`, `terms`, `hashHex`, `claimSignature` (optional), `txHash` |
| `heartbeat` | signer | `registryVersion`, `software`, `status` (`online`/`offline`), `holdCount` |
| `registry` | venue | the registry (section 9) |
| `book` | venue | `pair`, `registryVersion`, `ts`, `seq`, `levels`, optional `remaining: [{offerId,amount}]` (at most 200) |
| `bookDelta` | venue | `pair`, `seq`, `upserts`, `removes` |
| `ticker` | venue | `pair`, `registryVersion`, `ts`, `last`, `volume24h`, `high24h`, `low24h`, `trades24h` |
| `tradeLog` | venue | `tradeId`, `pair`, `registryVersion`, `baseAmount`, `quoteAmount`, `price`, `seller`, `buyer`, `ts`, `termsHash`, `escrowAddress`, `claimSignature`, `tracTxHash` |
| `status` | venue | `status` (`online`/`degraded`/`offline`), `software`, `ts`, `message`, `latest` (optional: `version`, `commit`, `sha256`) |

`src/core/schemas.js` is the exact field specification, including every length and range.

### Terms

```json
{
  "offerId": "<hex32>", "pair": "RESET/USDC", "base": { "kind": "trac-contract-token", "id": "RESET", "decimals": 8 },
  "baseAmount": "<units>", "quoteAmount": "<units>", "mint": "<sol>",
  "seller": { "dexKey": "<hex32>", "tracAddr": "<trac1>", "solRecipient": "<sol>" },
  "buyer": { "dexKey": "<hex32>", "tracAddr": "<trac1>", "solPayer": "<sol>" },
  "registryVersion": 1, "committee": [{ "dexKey": "<hex32>", "boxKey": "<hex32>" }], "k": 3,
  "fees": { "platformFeeBps": 10, "tradeFeeBps": 50, "signerShareBps": 5000, "collector": "<sol>", "platformCollector": "<sol>" },
  "sendBy": 0, "refundAfter": 0, "graceSec": 300, "R": "<hex32>"
}
```

`tradeId = sha256(stableJSON(terms))`. Terms require `k <= n` (n is the committee length, at most 16), distinct
committee identity and box keys, neither trader in the committee, distinct traders, and
`refundAfter - sendBy - graceSec >= 600`. `quoteAmount` is the seller's net USDC amount. The mint and the platform
collector must equal the network profile's; signers and the venue refuse other terms.

## 5. Trade protocol

The base asset is TNK or RESET; the quote is USDC. The seller sends the base asset and the buyer locks USDC. The
maker or the taker can be either side; the sequence is the same.

1. **Take.** The taker sends `take` on `intercom-dex:t:<offerId>` with `commitment = sha256(n_t)` for a fresh
   32-byte nonce `n_t`, and the absolute deadlines `sendBy = now + sendWindowSec` and
   `refundAfter = now + refundSec` from the registry.
2. **Admission.** The maker admits takes in arrival order. A take gets no answer when the sender is not the named
   taker. It is declined `invalid` when the pair or registry version differs from the offer, the amount is below the
   pair minimum, `sendBy` has passed or is more than 120 seconds away from the take's `ts` plus `sendWindowSec`, or
   `refundAfter - sendBy` differs from the registry's `refundSec - sendWindowSec` (makers before 0.1.18 did not
   answer those). Otherwise the maker declines it with `expired` when the
   offer expired; `version` when either side's software is below the registry minimum; `busy` when 3 trades on the offer
   (`MAX_TRADES_PER_OFFER`) or 3 negotiations with that taker (`MAX_NEGOTIATIONS_PER_TAKER`) have not locked yet;
   `insufficient` when the offer's size minus filled and reserved amounts is too small; and `signers` when fewer
   than n eligible signers exist or fewer than k+1 of them are online. Each take envelope gets at most one
   decline, and the decline names the take's envelope nonce. Declines answer strangers, so they are bounded: at
   most one per sender per minute and 30 per minute in total (`DECLINES_PER_MINUTE`). They are stamped last
   (section 12).
3. **Accept.** The maker sends `accept` with `commitment = sha256(n_m)` and `slot = A`, the latest finalized Solana
   slot it saw, followed by its `reveal` of `n_m`. The taker accepts only when `A` is within -12 to +150 slots of
   its own finalized view, which is at most 15 seconds old. Then the taker reveals `n_t`.
4. **Reveal cutoff.** Each side refuses the other's reveal, and the taker refuses the accept, once its view of the
   chain tip (the highest processed slot any of its RPC endpoints reports, at most 6 seconds old, dated when the
   request started) reaches `A + 56`.
5. **Randomness.** `R = sha256(n_m ‖ n_t ‖ blockhash(S))`, where `S` is the first finalized block at or after
   `A + 96` and the blockhash is its 32 decoded bytes.
6. **Committee and terms.** Both traders compute the committee from the registry snapshot the offer names
   (section 7), build the terms, exchange `terms`, check they are identical, and send `termsSig`. Both require
   k+1 committee members online before signing.
7. **Deal.** The buyer sends one `deal` with a lock certificate (section 6) and sends `summon` (both terms
   signatures) on `intercom-dex:signers` every 20 seconds until it has k acks. The seller and each signer check the
   dealing shape and the certificate; each signer also opens its own sealed share and checks it against the
   commitments.
8. **Acknowledge.** A signer stores its share encrypted and durably, then sends `ack` with
   `holdUntil = refundAfter`. It repeats the ack every 10 seconds until `sendBy`; after that, only a member that
   announces itself with `present` gets it again.
9. **Lock.** With k valid acks (distinct committee members, this trade's `H`, `holdUntil >= refundAfter`) the
   buyer creates the escrow with hash `H`, recipient `seller.solRecipient`, the terms' mint, amount and fees, and
   refund time `refundAfter`. The first lock attempt starts only before `sendBy - 120` (`LOCK_START_MARGIN_SEC`).
   Without k acks by then, the buyer aborts with `Signers did not confirm` and nothing is locked. A new lock
   transaction is signed only before `sendBy - 120`; signed bytes already in the buyer's journal may still be sent
   for the first time until `sendBy`.
10. **Check and send.** The seller reads the escrow at `finalized` commitment from its configured RPC endpoints
    and requires identical account data from at least `need` of them (default 2): status active, hash, recipient,
    refund key, mint, amount, refund time, fee bps, fee collectors and the derived vault. It requires k acks,
    reserves the escrow for this trade in its own store (one escrow never pays for two trades), and sends the base
    asset with the Trac nonce `sha256("intercom-dex/v1/transfer" ‖ tradeId)` before `sendBy`. It posts
    `transferSent`.
11. **Verify and publish.** Each signer looks the transaction up in its own node's signed, final view. For TNK it
    reads MSB's signed state; for RESET it reads the MSB transaction and the RESET contract's applied result from
    its own subnet reader. It checks sender, recipient, exact amount, nonce, the pinned RESET contract, that the
    transaction became final before `sendBy + graceSec`, and that no other trade used it. It then publishes its
    share on the trade channel and on `intercom-dex:signers`, and re-sends it after 10, 20, 40, 80, 160, 320 and
    600 seconds and then every 600 seconds until `refundAfter`. A `shareRequest` from the seller or the venue gets
    an answer at most once per 30 seconds per requester.
12. **Claim.** The seller collects k shares, checks each against its saved commitments, reconstructs `s`, checks
    `sha256(le32(s)) = H` and claims with `le32(s)` as the preimage. The escrow pays the net amount to the
    recipient and the two fees to their vaults. If no claim lands, the buyer refunds after `refundAfter`. The escrow
    does not check time on claim, so after `refundAfter` a claim and a refund can race.

Locks, claims and refunds count only once finalized. Every signed Solana and Trac transaction is journaled before it
is sent, so a restart resumes the same transaction and never signs a second payment. The commit points are buyer
`locking` (after the first lock attempt), seller `transferring` and signer `holding`; after them, network messages
cannot end the trade.

## 6. Lock certificate

The buyer derives one scalar `s` with `1 <= s < l`, a polynomial `f` of degree k-1 with `f(0) = s` and a non-zero
top coefficient, Feldman commitments `C_j = a_j·B` to its coefficients, and shares `f(i)` for i = 1..n. Share i is
sealed to committee member i's box key: X25519 with an ephemeral key, HKDF-SHA256 (info
`intercom-dex/v1/sealed-share`, salt `sha256(ephemeralKey ‖ recipientKey)`) and XChaCha20-Poly1305 with associated
data `stableJSON({tradeId, signerIndex, recipientKey})`. `H = sha256(le32(s))`.

- **Group.** Baby Jubjub (twisted Edwards, `a = 168700`, `d = 168696` over the BN254 scalar field), generator `B` =
  `Base8`, prime subgroup order `l`. Points travel as 32 bytes: `y` little-endian with the sign of `x` in the top
  bit. Receivers accept only canonical encodings of points on the curve in the prime subgroup; `C_0` and the top
  commitment must not be the identity. Scalars travel as `le32`.
- **Statement.** For a private `s` with `0 <= s < l`: `s·B = C_0` and `sha256(le32(s)) = H`. Public signals are
  `[hashHi, hashLo, cx, cy]`: the first and last 16 bytes of `H` as big-endian integers, and the affine coordinates
  of `C_0`. The circuit is `circuits/lockkey.circom` (circom 2.2.3, circomlib 2.0.5).
- **Proof system.** PLONK on BN254 (snarkjs 0.7.6). Its only setup input is the public Hermez Powers of Tau file
  `powersOfTau28_hez_final_18.ptau`. PLONK adds no circuit-specific secret, so no party can make a certificate for a
  false statement. The proving key is derived from that file and the circuit deterministically.
- **Pinned files.** Every role checks the circuit files at start; traders also check their proving key.

| File | Hash |
| --- | --- |
| `circuits/lockkey.r1cs` | sha256 `bac722805fcc04a20de2789eb5c36dbb4525fdd0a8f3d52ce24a00f92e88dfc2` |
| `circuits/lockkey.wasm` | sha256 `7b4b3a43d9eb0f5158eb0e18ec21f7d86054f7939dcddf2639eccdfcb906e053` |
| `circuits/lockkey.vkey.json` | sha256 `0e35a7d80fec3fd76e84b8bdcf8e0a47be41883ef01a3e26f5e1a84f04e8242a` |
| proving key (`lockkey.zkey`) | sha256 `23c72437797a1796aca33c57765b97154657c8ee88624c177f5b9be03848e968` |
| `powersOfTau28_hez_final_18.ptau` | blake2b-512 `7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e` |

- **Who checks what.** The seller and every committee signer verify the certificate against `H` and `C_0` with the
  verification key. Each signer verifies its own share against the commitments. Shares that pass lie on a
  polynomial whose constant is the scalar behind `C_0`, and the certificate shows that scalar opens `H`, so any k
  checked shares rebuild the preimage of the escrow's hash. The seller and the venue check every published share
  against the commitments before using it.
- **Wire form.** `proof` has exactly the snarkjs PLONK keys (`protocol: "plonk"`, `curve: "bn128"`, nine G1 points
  and six evaluations), with canonical decimal values below their moduli.
- **Cost.** Making a certificate takes about a minute of CPU and up to 4 GB of memory, in a worker thread, one at a
  time. Certificates don't depend on the trade, so a trader keeps a pool (`proof.pool`, default 2) of ready ones,
  each used for exactly one trade; its assignment is saved before the deal is sent. With an empty pool the buyer
  proves on demand and sends `working` notes every 10 seconds meanwhile. Checking a certificate takes milliseconds.

## 7. Committee selection

`selectCommittee(registry, R, {n, k, quoteAmount, pair, exclude})` takes the registry signers that are `active`,
list the pair's base asset in `assets`, run software at or above `minSoftware`, have `limitUsdc >= quoteAmount`
and are neither trader. It sorts them by `dexKey` and draws n of them without replacement: for counter
c = 0, 1, 2, ... it computes `x = sha256(R ‖ uint32BE(c))` as a 256-bit integer, rejects `x` at or above the largest
multiple of the pool size below 2^256, and otherwise takes the member at `x mod size`. With fewer than n eligible
signers there is no committee. The signers and the venue recompute the selection and refuse terms with any other
committee.

## 8. Deadlines, budgets and liveness

The signed terms carry three absolute deadlines: `sendBy`, `sendBy + graceSec` and `refundAfter`. The registry's
`params` set their distance from the take.

| Deadline | Effect |
| --- | --- |
| `sendBy - 120` | The buyer starts no first lock attempt from here. |
| `sendBy` | The seller sends no transfer from here. The Solana adapter signs no new lock from here. |
| `sendBy + graceSec` | A transfer must be final before this for signers to publish. Signers still waiting for one expire. |
| `refundAfter` | The buyer may refund. Signers stop answering share requests; the venue counts shares received up to here. |

Before the buyer's first lock attempt nothing is committed, and each side leaves when a step stalls on its own
monotonic clock (`STEP_BUDGET_MS`):

| Step | Budget |
| --- | --- |
| `accept` | 40 s: the maker's wait in `awaitTake`, and the taker's wait for `accept` once the maker's peer is present on the offer channel |
| `connect` | 80 s for the taker in total, connecting included |
| `randomness` | 120 s for the deciding block, reveals included |
| `terms` | 30 s for terms and signatures |
| `deal` | 60 s (as long as the buyer waits for acks) for the seller and signers to receive the deal, plus 60 s per `working` note |
| `certificate` | 150 s for the buyer's deal step, and the cap for the extended deal wait |
| `working` | 10 s between the buyer's `working` notes |
| `acks` | 60 s for k acks |

Leaving sends a courtesy `abort` and releases the offer reservation. Once the seller has a valid-shaped deal it
waits for the escrow until `sendBy` even after its budget ran out, unless the buyer aborted before locking, because
a lock may still land. Step budgets never end a trade after a lock attempt or a transfer; only the absolute
deadlines apply then.

Online checks are a courtesy and never replace acks. Signers send `heartbeat` every 30 seconds. A trader counts a
signer online when its last heartbeat arrived at most 90 seconds ago (`SIGNER_ONLINE_SEC`) and its software meets
the registry minimum. Takes and admissions need n eligible signers and k+1 eligible signers online; both traders
need k+1 members of the selected committee online before they sign the terms.

## 9. Registry

The venue signs one registry per version and publishes it as a `registry` message on `intercom-dex` every 30
seconds. The message's envelope signature by the venue's dex key (`serviceKey`) is the registry's signature:

```json
{
  "version": 1, "issuedAt": 0, "minSoftware": "0.1.0", "serviceRelayKey": "<hex32, optional>",
  "pairs": [{ "pair": "TNK/USDC", "base": { "kind": "trac-native", "id": "TNK", "decimals": 18 }, "minBaseAmount": "<units>", "status": "open" }],
  "params": { "n": 5, "k": 3, "sendWindowSec": 900, "refundSec": 172800, "graceSec": 300 },
  "fee": { "platformFeeBps": 10, "tradeFeeBps": 50, "collector": "<sol>", "signerShareBps": 5000 },
  "signers": [{ "dexKey": "<hex32>", "boxKey": "<hex32>", "label": "<text>", "limitUsdc": "<units>", "status": "active",
    "assets": ["TNK", "RESET"], "software": "0.1.0", "relayKey": "<hex32, optional>" }],
  "removed": [{ "dexKey": "<hex32>", "removedAt": 0, "reason": "<text>" }]
}
```

- **Limits.** 1 to 64 pairs, at most 128 signers and 256 removals; `k <= n <= 16`; `sendWindowSec >= 300`;
  `refundSec - sendWindowSec - graceSec >= 600`; `platformFeeBps <= 500`, `tradeFeeBps <= 1000`, their sum at most
  1500, `signerShareBps <= 10000`; unique pairs, signers and box keys; one definition per asset ID; a removed
  signer can't be listed. The serialized registry is at most 150000 characters.
- **Acceptance.** A role accepts a registry only from the venue key it pins (`serviceKey`), dated at most 60 seconds
  in the future, with a higher version and a later or equal `issuedAt` than the current one. Every accepted
  version is stored, also across restarts. Two different registries under one version stop all new trades.
- **Use.** New trades use the newest registry. A trade keeps the snapshot its offer names for its committee, fees,
  windows and settlement. A signer accepts a summon only for the current version, or the previous one within 600
  seconds of the new version's `issuedAt`. Signers and the venue accept a summon only while `sendBy` is later than
  now and at most `sendWindowSec + 120` seconds ahead, and `refundAfter - sendBy = refundSec - sendWindowSec`. A
  signer holds at most 32 unfinished trades, and at most 8 per trader key (buyer or seller); it refuses further
  summons until one finishes, and the buyer's repeated summons then find it.
- **Pairs.** A pair whose base asset kind this software does not know shows as `needs a newer version`. `paused`
  stops new offers and takes. Known kinds are `trac-native` (TNK, 18 decimals) and `trac-contract-token` (RESET, 8
  decimals); the quote is always USDC (6 decimals) from the network profile, and the registry can't name a mint.
- **Versions.** Offers, takes, heartbeats, books, tickers, trade logs and the venue's status carry software or
  registry versions. A program below `minSoftware` reports `update required` and starts no new trades; signers
  below it are not selected. The venue's optional `status.latest` names the newest release (`version`, `commit`,
  `sha256`) as an announcement. Nothing downloads or runs because of it.
- **Removal.** Removing a signer is the venue operator's decision. The next version lists it under `removed`; it
  is no longer selected, running trades keep their committee, and it forfeits credits not yet paid.

## 10. Escrow and fees

The escrow holds `quoteAmount` plus `floor(quoteAmount × platformFeeBps / 10000)` plus
`floor(quoteAmount × tradeFeeBps / 10000)`. A claim with the preimage pays `quoteAmount` to the recipient, the
platform fee to the platform collector's vault and the trade fee to the collector's vault. A refund by the buyer
from `refundAfter` on returns the whole amount, fees included. The venue checks that the registry's fee equals the
finalized on-chain platform config and the collector's trade config before it publishes, and the buyer's lock and
the seller's escrow check compare both again with the terms. When the platform fee changed after the terms were
signed, the buyer's lock attempt fails with `platform fee changed, take again`.

Signers' share: for a logged trade, the signers whose published share verifies against the dealing's commitments,
whose commitments reconstruct a secret that hashes to the settled `H`, and whose share the venue received by
`refundAfter`, each get `floor(floor(quoteAmount × tradeFeeBps / 10000) × signerShareBps / 10000 / count)`. Credits
are computed from `refundAfter + 300`, stay provisional for 7 days after the trade was logged, are then final, and
are paid by the venue operator outside the protocol.

## 11. Settlement records and market data

A seller reports a finished trade with `settled` on `intercom-dex:offers`, every minute for two days and then
every half hour, until the venue's `tradeLog` for it appears. The venue keeps one durable record per report. It
logs the trade only after it has verified the claimed escrow at `finalized`, the final Trac transfer with the trade
nonce, and the claim transaction in the escrow's history; one escrow is logged for one trade only. The fill counts
against the offer named in the signed terms.

The venue watches each trade from its verified summon, so it knows which signer may publish which share. Watches made
from summons alone share a capacity of 20000. When it is full, a watch past `sendBy + graceSec` without any
settlement report is archived (its evidence is kept and restored if a settlement is later proven); if none qualifies,
the new watch waits. A logged settlement always gets its watch. Share messages for a trade without a watch are kept
only from signers listed in a registry, at most 16 distinct ones per sender and trade.

The venue publishes, all signed: a `book` per open pair with at most 50 aggregated levels per side, refreshed as a
full snapshot at least every 60 seconds and as cumulative `bookDelta` messages against it in between (checked every
5 seconds); a `ticker` every 30 seconds (last price, 24-hour volume, high, low and count); a `tradeLog` entry for
each logged trade, with the terms hash, escrow address, claim signature and Trac transaction hash, so anyone can
check volumes on both chains; and its `status`. Book levels are display data; a take always needs the maker's
signed offer, and the maker reserves its own inventory. Makers re-announce open offers every 45 seconds (120 seconds
before 0.1.14), and book observations expire after 300 seconds. A take at a price level goes first to a maker heard
recently (within 70 seconds for offers made by 0.1.14 or later, 150 seconds for older ones), oldest offer first. Full books also publish compact `remaining` rows (at most 200 unique
offer IDs and base-unit integer amount strings); deltas carry only level changes. Offer bodies come from the
makers' announcements. The market feed's individual `left` is null until known from a full book; offers missing
from a newer full book's `remaining` for their pair are removed. The venue leaves an offer out of its books while
the maker's wallet cannot fund the pair's smallest trade (it reads makers' wallets at most every 300 seconds; a
wallet it cannot read hides nothing), and keeps its book across restarts.

## 12. Transport limits, proof-of-work and relays

- Every message on `intercom-dex:offers`, `intercom-dex:signers`, `intercom-dex:chat` and every `intercom-dex:t:` channel carries a
  proof-of-work stamp `pow: {nonce, difficulty}`: `sha256(stableJSON({channel, from, id, message, nonce, origin,
  ts}))` must have at least 20 leading zero bits. Peers check it before relaying, also on open channels. Identical
  content reuses its stamp while the stamp is being computed and for 60 seconds after its timestamp.
- A peer computes stamps in order of urgency: post-lock safety messages (`transferSent`, `ack`, `sharePublish`,
  `shareRequest`, `deal`, `claimed`, `refunded`, `summon`), then negotiation with a trade's counterparty (`take`,
  `accept`, `reveal`, `terms`, `termsSig`, `working`, `abort`), then everything else, and `decline` last. A more
  urgent stamp interrupts a running one. A decline is dropped, not queued, while another decline waits.
- Chat is checked before delivery or relay: one message per 10 seconds and 20 per rolling hour per signing key,
  with no repeated text within 10 minutes. Trader and venue retain the last 100 accepted messages in memory only.
- A message is at most 200000 bytes. Each connection may send 64000 bytes per second with a burst of 256000 bytes;
  both are checked before a frame is decoded. A trade accepts at most 400 messages per sender and buffers at most
  100 messages or 4 MB per sender.
- Blind relays carry encrypted traffic between peers that can't connect directly. The registry's signer
  `relayKey` entries (active, not removed) and `serviceRelayKey` replace the dynamic relay list with every new
  version; static `relayKeys` in the peer config are added. Venue and signer peers serve as relays by default
  (`serveRelay`); trader peers never do. A new isolated peer needs a static relay key or a cached registry to find
  its first relay.

## 13. Guarantees and assumptions

- **Buyer.** The buyer is safe unless k signers of the committee release their shares without a matching final
  transfer. The escrow pays out only against the preimage of `H`; fewer than k shares reveal nothing about `s`; a
  signer publishes only after its own node shows the matching final transfer. Without a claim, the buyer refunds
  from `refundAfter` on.
- **Seller.** The seller is safe unless n-k+1 signers of the committee withhold or lose their shares until
  `refundAfter`, or the seller's program stays offline from the transfer until the buyer refunds. The seller sends
  only after the certificate verified, the escrow matched the terms on its RPC quorum, k signers acknowledged
  holding their shares until `refundAfter`, and the escrow was reserved for this trade.
- **Committee choice.** Neither trader picks the committee. `R` depends on both nonces and on a Solana block that
  is produced after both commitments. This rests on a timing assumption: at least one of a receiver's RPC endpoints
  trails the newest produced block by less than 25 slots, and the chain advances at most about 2.5 slots per second
  (about 15 slots in 6 seconds). Under it, the deciding block doesn't exist when a reveal is accepted. The committee
  choice affects which registered signers serve, never which funds move.
- **Certificates.** Soundness rests on PLONK on BN254 and on the Powers of Tau ceremony having at least one
  contribution whose secret was destroyed, plus the discrete logarithm assumption on Baby Jubjub.
- **Chains.** Solana finality at `finalized` commitment, and MSB's signed state and the RESET contract's applied
  result as seen by each party's own node. The venue and its gateways relay data but can't make a party accept a
  transfer, escrow or registry that fails these checks.
