# Protocol core API and runner contract

All times are integer Unix seconds. Amounts are decimal integer base-unit strings;
USDC limits use USDC base units. Keys and hashes are lowercase hex. Wire scalars
are 32-byte little-endian hex; VSS functions use `bigint`. Signer indices are
**one-based**. Core modules perform no network or filesystem I/O.
The async proof adapter in `src/proof/` loads pinned files and uses worker threads.
Random generation accepts `rng(length) -> Uint8Array`.

Functions throw on invalid inputs unless their documented result is a boolean,
`{ok, ...}`, or a state-machine result. Each role's `step` ignores invalid,
unrelated, duplicate or out-of-phase input by returning the original state and
no actions, without advancing its clock. A dealing that fails local validation aborts
the seller and makes a signer refuse; a failed certificate does the same.
Caller objects are not mutated. Replay
caches and random generators explicitly own their bounded/cache or stream state.

## Public signatures

```js
// canonical.js
stableJSON(value) -> string
bytesToHex(bytes) -> string
hexToBytes(hex, length?) -> Uint8Array
utf8(text) -> Uint8Array
concatBytes(...parts) -> Uint8Array
le32(scalarBigInt) -> Uint8Array
fromLe32(bytes) -> bigint
sha256Hex(bytesOrText) -> string

// keys.js: secrets accept bytes or 64-char hex; generated keys are byte arrays.
generateIdentity(rng?) -> {secretKey, publicKey}
identityPublic(secret) -> Uint8Array
generateBox(rng?) -> {secretKey, publicKey}
boxPublic(secret) -> Uint8Array
encodeKey(key) -> string

// addresses.js
isTracAddress(text) -> boolean
isSolanaAddress(text) -> boolean

// schemas.js
parseBody(kind, body) -> validatedClone
// Zod schemas exported: hexKey, amount, price, tracAddress, solanaAddress,
// feesSchema, termsSchema, registrySchema, sealedBoxSchema, dealSchema.
// bodySchemas also includes present, summon and settled.

// envelope.js
seal({kind, ch, body}, identitySecret, {ts, nonce}) -> envelope
open(envelope, {now, seen, maxAgeSec = 120, maxFutureSec = 120}) -> verifiedEnvelope
createReplayCache({maxEntries = 4096}?) -> {consume(key, expiresAt, now), size}
new EnvelopeError(code, message)
// open throws EnvelopeError: schema, unknown-kind, stale, bad-signature,
// replay, capacity. Invalid local clock/cache arguments throw TypeError.

// vss.js
FIELD_ORDER // BN254 scalar field (Baby Jubjub coordinate field)
SCALAR_ORDER // Baby Jubjub prime subgroup order l
randomScalar(rng?) -> bigint // 1 <= s < l
evaluatePolynomial(coefficients, id) -> bigint
polynomialCommitments(coefficients) -> string[]
validateCommitments(commitments) -> boolean // canonical subgroup points, nonidentity C_0 and top
commitmentAffine(encoded) -> {x: bigint, y: bigint}
split(secret, k, ids, rng?) -> {coefficients, commitments, shares: [{id, share}]}
verifyShare(id, share, commitments) -> boolean
reconstruct([{id, share}], k) -> bigint

// seal.js: plaintext must be exactly 32 bytes.
sealTo(plaintext, recipientKeyHex, {tradeId, signerIndex}, rng?) -> sealedBox
openSealed(sealedBox, recipientSecret, {tradeId, signerIndex}) -> Uint8Array
// sealedBox = {ephemeralKey, nonce, ciphertext}; HKDF-SHA256 info is
// "intercom-dex/v1/sealed-share", salt is SHA256(ephemeralKey || recipientKey).
// AAD is stableJSON({tradeId, signerIndex, recipientKey}).

// dealing.js
prepareDeal({k, committeeBoxKeys, tradeId, secretHex?, rng?}) -> {privateState, deal}
// privateState = {secretHex, coefficients: le32Hex[]}; deal.proof starts as null.
lockStatement(deal) -> [hashHi, hashLo, cx, cy] // canonical decimal strings
checkDealShape(deal, terms) -> boolean
signerShareCheck(deal, mySignerIndex, myBoxSecret)
  -> {ok: true, share: bigint} | {ok: false}

// lock-certificate.js: strict Zod schemas shared by wire and proof adapters
lockProofSchema; lockStatementSchema; BN254_BASE; BN254_SCALAR;

// src/proof/lockproof.js (async; outside core)
proveLock({secretHex, statement}, {zkeyPath}) -> Promise<proof>
makeLockCertificate({zkeyPath}) -> Promise<{secretHex,H,C0,proof} | null>
// Background generation returns null while the prover is busy; secrets are generated in its worker.
verifyLock(statement, proof) -> Promise<boolean> // never throws for invalid input
checkProofFiles({zkeyPath?} = {}) -> Promise<void> // throws on missing/mismatched files

// committee.js: SHA256(R bytes || uint32BE(counter)), rejection sampling.
selectCommittee(registry, R, {n, k, quoteAmount, pair, exclude = []}) -> signer[]

// terms.js: returned objects exclude tradeId; the terms message wraps both.
buildTerms(input) -> terms
validateTerms(terms) -> validatedClone
tradeId(terms) -> hex
transferNonce(tradeId) -> hex
tradeRandomness({makerNonce, takerNonce, blockhash, slot, acceptSlot, finalized}) -> hex
// blockhash is decoded 32-byte hex, not the RPC's base58 representation.

// registry.js: detached signatures use "intercom-dex/v1/registry\n" + stableJSON.
buildRegistry(input) -> registry
signRegistry(registry, identitySecret) -> {registry, from, sig}
verifyRegistry(signed, serviceKey, {now}) -> boolean
newestRegistry(versions, serviceKey, {now, minVersion = 1}) -> signedRegistry
removeSigner(registry, dexKey, {now, reason}) -> unsignedNextVersion

// trade-buyer.js / trade-seller.js
createBuyer(config) -> state
createSeller(config) -> state
step(state, event) -> {state, actions} // exported separately by each role module
// trade-buyer.js also exports LOCK_START_MARGIN_SEC = 120.

// trade-signer.js
createSigner({terms, signerIndex, boxSecret, now, usedTx = {}}) -> state
step(state, event) -> {state, actions}

// trade-common.js: exported implementation helpers, also tested.
seededRng(seedHex, domain) -> rng // HMAC-SHA256 counter stream
createTrader(role, config) -> state
sendAction(state, kind, body) -> action
abortTransition(state, reason) -> {state, actions}
eventState(state, event) -> clonedStateWithTime
runStep(state, event, advance) -> {state, actions}
resumeActions(state, outstanding = []) -> {state, actions}
verifiedMessage(state, event) -> message | null
negotiationStep(state, event, message) -> {state, actions} | null
```

VSS uses Baby Jubjub with Base8. Shares and coefficients accept `0 <= scalar < l`;
secrets and generated scalars satisfy `1 <= s < l`. Share IDs accept safe integer
numbers or bigints with `1 <= id < l`. Points encode canonical little-endian y
with x parity in the high bit, as noble's Edwards encoding. Decoding checks the
curve and prime subgroup. Identity intermediate commitments are allowed; C_0
and the top commitment must be nonidentity. Split rejects duplicate IDs and
samples nonzero coefficients. Reconstruction rejects too few/duplicate shares
and inconsistent extra shares. Dealing bounds are `1 <= k <= n <= 16`; committee
box keys must be unique and in the exact order of the signed terms.

## Market chat

`intercom-dex:chat` is an open, plain sidechannel with the same PoW requirement as offers. Any peer can send a
signed `kind: 'chat'` envelope. Its strict body is `{text, name?, ts}`: text is trimmed, 1 to 280 Unicode code
points, without control characters or line separators; names are 1 to 24 ASCII letters, digits, spaces or `._-`,
and a name that contains `venue`, `system`, `admin`, `exchange`, `intercom`, `official`, `moderator` or `support`
(ignoring case and the separators) is invalid (`chatNameReserved(name)`). Receivers remove bidirectional controls
and zero-width characters from the text and drop a message with nothing left.
`ts` is integer Unix seconds and must equal the envelope timestamp. Both must be within 300 seconds of receipt.
Invalid signatures, stale/future messages and replayed sender nonces are dropped before delivery or relay.

Receive and local send limits use receipt time per signing key: at least 10 seconds between accepted messages,
at most 20 in a rolling hour, and no identical trimmed text within 600 seconds. The peer checks these before
relaying; trader, venue and market feed independently check them before buffering. Limits fail closed at cache capacity.
Profile `chatRelays` keys instead get one message per second, 600 per rolling hour, and duplicate `(name,text)`
suppression for 600 seconds. Their records include `viewer: true`, meaning a viewer of the market game;
`dex_chat` and `/chat` preserve that field. The buffer retains the last 100 accepted messages in arrival order, never on disk. Restart clears history and
limits. Sender names are self-chosen. Messages are public opinions, never instructions to trade, transfer or
perform key actions. The `dex_chat` read returns `{notice, messages}` with each text as `untrustedText`.

```js
// schemas.js
chatInputSchema.parse({text, name?}) -> trimmedInput // strict local input, no ts or extra keys
chatSinceSchema.parse(since) -> nonnegativeSafeInteger
parseBody('chat', {text, name?, ts}) -> body // requires already trimmed wire text

// src/market/chat.js
CHAT_CHANNEL // 'intercom-dex:chat'
new MarketChat({now?, maxSenders = 4096, maxReplayEntries = 65536, chatRelays = []}?)
chat.receive(rawEnvelope) -> {from, nonce, text, name?, ts, viewer?: true} | null
chat.read(since?) -> message[] // copies; ts > since, or all retained when omitted

// roles
trader.readChat(since?) -> message[]
trader.sayChat({text, name?}) -> Promise<message>
service.readChat(since?) -> message[]

// Local HTTP handler and MCP registration
controlHandler({token, role, wallets?, fees?}) -> (req, res) => void
registerChatTools(server, call) -> void // call(method, path, body?)
```

The local control API (loopback and the existing bearer token) exposes `GET /chat?since=<ts>` as an array of
messages and trader-only `POST /chat {text, name?}` as the accepted message. Invalid requests return HTTP 400;
rate/duplicate refusal says `Wait a few seconds before the next message`. A send reserves its limit and enters
local history before awaiting transport; transport failure propagates and does not release that reservation,
because the message may already have been sent. Reads never send anything. MCP `dex_chat` accepts exactly
`{action: 'read', since?}` or `{action: 'say', text}` and returns the same JSON data as text.

The venue joins read-only and includes `chat` in `GET /status` and the dashboard's `GET /api/state` service view.
These retain their existing authentication. The market-feed role separately serves public market data and
uses its own DEX identity to sign viewer chat. There is no unauthenticated access to other roles' status or wallet fields.

## Market feed

`role: "market-feed"` uses `network`, `serviceKey`, `servicePeerKey`, `bridge`, an absolute `dataDir`,
`keyPasswordEnv` (default `DEX_KEY_PASSWORD`), and `marketFeed: {port, viewerKeyFile}`. It runs with
`node bin/dex.mjs --config <absolute path>`; other CLI commands are refused. Its matching peer uses the same
role and resolved profile. No wallet, chain adapter, proof worker or trade host is opened by this role.
The first run creates an encrypted identity keyring in its separate data directory; subsequent runs reuse it.
The existing encrypted record store holds public history and viewer-id hashes, one record per entry (an offer's
first-seen time, a trade, a party association, pending terms, a pair's inventory), so an accepted message writes only
what it changed. The role joins only
`intercom-dex`, `intercom-dex:offers` and `intercom-dex:chat`, checks signatures/replays, venue identity,
registry versions, profile pins, pair definitions and software requirements before accepting market data.

`marketFeed.viewerKeyFile` names an absolute, user-owned regular file, mode 0600, containing a 32 to 256
character bearer key (visible ASCII, without spaces), optionally followed by a newline. Symlinks are refused.
Authentication compares SHA256 digests in constant time. `marketFeed.port` is an integer TCP port; 0 is useful
for unit tests. HTTP binds only to `127.0.0.1`. There are exactly five routes:

- `GET /v1/market/view`: `{v:1,ts,pairs,offers,trades}`. `pairs` entries are
  `{pair,base,last,change24h,volume24h,bestBuy,bestSell,trades24h}`. `offers` entries are
  `{offerId,pair,side,price,amount,left,maker:{trac,sol},postedAt}`; `trades` entries are
  `{id,pair,price,amount,usdc,seller:{trac,sol},buyer:{trac,sol},settledAt}`.
  Amounts and prices are decimal whole-unit strings, computed with integers; USDC uses six decimals,
  base assets use the registry definition. Unknown statistics and unknown `left` are null. Times are Unix seconds.
  `postedAt` is this listener's first observation of an offer ID and survives restart. Offers are newest first,
  at most 200; trades are newest first, at most 100. First-observation records are bounded at 10,000 and kept
  until offer expiry; live entries are not evicted to admit new IDs. Announcements expire after 300 seconds
  without a refresh. Maker-signed announcements on `intercom-dex:offers` supply offer bodies; full venue books
  supply `left` through compact `remaining: [{offerId,amount}]` rows in base units. Until a full book supplies
  an amount, `left` is null. An offer absent from a newer full book's `remaining` for its pair is removed;
  level-only books and deltas do not change individual remaining amounts. Full-book inventory survives restart.
  Cancellation tombstones prevent reannouncements from reviving cancelled offers until expiry. A cancel applies
  locally at once; if its announcement fails, the maker repeats it every 10 s up to six times (0.1.18).
  Bounded pending public settlement terms survive restart until matched to a log or aged out after 24 hours.
  A persisted history retains the last 100 trades and trades in `(now - 86400, now]`, at most 10,000.
  `change24h` is `(last - first price in the window) / first`, truncated to 12 fractional digits; a missing or
  zero first price, truncated window, or a venue count showing missing history gives null. Venue ticker
  values are preferred for 300 seconds when their last price agrees and their count/volume cover observed
  history. Otherwise statistics use this listener's observed trades, which can be incomplete after downtime.
  Best bid/ask come from the venue book, also with a 300-second freshness limit.
  The complete response is at most 60,000 UTF-8 bytes: oldest `postedAt` offers are dropped first, then oldest
  trades, until it fits. Pairs stay whole and statistics still use the retained history, including omitted rows.
  Serialized bytes and their strong SHA256 ETag are cached until content changes or expires; `ts` is build time.
  Responses set `cache-control: max-age=10`; matching `If-None-Match` yields 304.
- `GET /v1/market/candles?pair=<pair>&interval=<interval>[&limit=<n>][&before=<t>]`:
  `{pair,interval,candles:[{t,o,h,l,c,v}]}`. `interval` is one of `1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 2d 3d 1w 1mo 1y`;
  buckets are UTC, `1w` starts on Monday, `1mo` and `1y` are calendar months and years. `t` is the bucket start in
  Unix seconds; `o h l c` are decimal price strings and `v` is the USDC volume as a decimal string. Only buckets
  with trades are returned, oldest first. `limit` is 1 to 500 (default 500); `before` is an exclusive bucket start
  for older pages.
- `GET /v1/market/trades?pair=<pair>[&limit=<n>][&before=<cursor>]`: `{rows:[{id,t,side,price,amount,usdc}],next}`,
  newest first. `limit` is 1 to 200 (default 100); `next` is an opaque cursor for the following page, or null.
  `side` is null because the trade log does not name the taker.
  Both history routes read a permanent trade archive: every accepted venue trade log is appended to per-pair
  JSONL segments under `dataDir/market-history/` (fsynced, duplicates ignored, a damaged last line is reported and
  skipped), held under an exclusive lock while the role runs. Unknown or repeated parameters and unknown pairs give
  400. Responses carry a strong ETag and `cache-control: max-age=5`. `node bin/feed-import-venue.mjs --venue-data
  <dir> --feed-data <dir>` seeds the archive once from a venue's logged settlements, read-only, with the feed
  stopped.
- `GET /v1/market/chat?after=<seq>`: `{ok:true,epoch,now,next,oldest,more,messages}`.
  The last 100 accepted lines live only in memory; no cursor returns the last 20. `after` is a nonnegative
  safe integer and filters by sequence, not time. The complete response is at most 60,000 UTF-8 bytes;
  oldest selected messages are dropped until it fits, setting `more: true` when any are omitted for size.
  `next` is the newest returned sequence and `oldest` is the oldest retained sequence. Size-truncated older
  lines are skipped by that cursor; the retained 100-line history itself is unchanged.
  An agent line is `{seq,kind:"agent",addr,text,ts}`; a viewer line is
  `{seq,kind:"viewer",name,text,ts}`. Clients can distinguish trading identities from viewers by `kind`.
  A sender with an open offer maps to its Trac address;
  settlement terms bound by a venue trade log also map both trading identities, persisted with the log.
  Otherwise `addr` is the DEX public key. `epoch` changes on restart so consumers can reset their cursor; a cursor beyond the new sequence head
  returns the current head instead of keeping an unreachable cursor.
- `POST /v1/market/chat/viewer`: requires `Authorization: Bearer <key>` and JSON `{id,name,text}`,
  with no extra fields. IDs use 1 to 128 ASCII letters, digits, `_` or `-`; names are sanitized to the
  chat charset and 24 characters, with `Viewer` for an empty result. Text follows the normal chat schema.
  Success is `{ok:true,seq}` or `{ok:true,duplicate:true}`. Hashes of IDs and sanitized payloads are reserved
  durably before transport, for 24 hours and at most 10,000 entries. A reused ID with different content gives
  409; an ambiguous transport failure keeps its reservation to avoid reposting. The relay identity must be
  listed in the resolved profile's `chatRelays`; mainnet deployments must update that pinned list first.
  Errors are plain JSON `{ok:false,error}`: 400 for malformed input, 401 for auth, 413 for a body above 4096
  bytes, 415 for content type, 429 for chat limits, 502 for transport, and 503 for relay configuration/capacity.
  Other paths or methods return 404. There are no wallet or control routes on this server.

```js
// src/roles/market-feed.js
new MarketFeed({bridge,identity,store,serviceKey,profile,now?,log?})
feed.start() -> Promise<void>
feed.stop() -> void
feed.receive(channel, rawEnvelope) -> Promise<boolean>
feed.view() -> {json,etag}
feed.readChat(after = null) -> {ok,epoch,now,next,oldest,more,messages}
feed.postViewer({id,name,text}) -> Promise<{ok,seq?,duplicate?,error?}>

// src/market-feed/view.js: receives authenticated, registry-admitted bodies
new MarketView({store,now?})
view.offer(body, from); view.cancel(body, from); view.book(body)
view.ticker(body); view.trade(body); view.settlement(body) // -> boolean; invalid schemas throw
view.address(dexKey) -> string
view.snapshot(registry) -> {json,etag}

// src/market-feed/http.js
startMarketFeedHttp({feed,port,viewerKeyFile}) -> Promise<http.Server>

// src/market-feed/runtime.js
startMarketFeed({config,profile,bridge,password,log?}) -> Promise<{feed,server,close}>
// close() -> Promise<void>; stops the feed/HTTP and clears the store key from memory.
```

`tradeLog` requires `price` plus strict `seller:{tracAddr,solAddr}` and `buyer:{tracAddr,solAddr}`.
The venue fills these only after settlement verification, from terms' `seller.solRecipient` and
`buyer.solPayer`; price is the settled quote/base ratio as a decimal price string.

## Terms and signed messages

`core/address-proof.js` exports `createAddressProof(wallet, {networkId,dexKey,expiresAt})`,
`validAddressProof(party, {networkId,now,validUntil?,required?})`, `validTermsAddressProofs(terms, policy)` and
`addressProofRequired(registry)`. `createTracAdapter().proveAddress({dexKey,expiresAt})` uses the unlocked Trac
wallet and pinned network without making a transaction. A participant's `tracProof` is `{expiresAt,signature}`;
the signature binds its Trac address and DEX key to that network and expiry. It is omitted before the current
registry minimum reaches `0.1.34` and required for both traders on new admissions afterwards. See
[the protocol](../../docs/SPEC.md#terms) and [rollout order](../../docs/OPERATORS.md#activating-trac-address-proofs-0134).

`createBuyer`, `createSeller` and `createSigner` accept `networkId` and `requireAddressProof` in their configuration.
Trader reducers derive the default requirement from their registry; the live signer and trader runners additionally
apply the current registry minimum when admitting trades on older snapshots. `TradeHost` rechecks its
`addressProofRequired()` callback before the seller balance lookup and before accepting its result. Committed
signer shares bypass these admission checks on recovery. `MakerFunds` takes an `addressProof()` policy callback;
an invalid or missing required proof always hides an offer, including while balances are unknown.

`schemas.js` is the authoritative, exact wire field specification. Terms include:

```js
{
  offerId, pair, base: {kind, id, decimals}, baseAmount, quoteAmount, mint,
  seller: {dexKey, tracAddr, solRecipient},
  buyer: {dexKey, tracAddr, solPayer},
  registryVersion, committee: [{dexKey, boxKey}], k,
  fees: {platformFeeBps, tradeFeeBps, signerShareBps, collector, platformCollector},
  sendBy, refundAfter, graceSec, R
}
```

`offerId` is required lowercase 32-byte hex (`hexKey`), included by `buildTerms`
and covered by `tradeId` and both traders' signatures. Changing it changes the
trade ID. `createTrader`, `createBuyer` and `createSeller` require
`config.terms.offerId === config.offerId`; the peer's take must name that offer.
Existing terms without this field fail validation.

`mint` and both collectors are explicit so the Solana adapter can verify local
test mints and fee configuration. `quoteAmount` is the agreed net amount for the
seller; the escrow adapter computes the required gross deposit. Registry `fee`
maps directly to `terms.fees`, with the fixed platform fee and profile-pinned platform collector. `n` is the committee length. Committee members exclude both traders
and have unique identity and box keys. The total fee cap is 1500 bps, venue cap
1000 bps. Terms require `refundAfter - sendBy - graceSec >= 600`; the registry
requires `refundSec - sendWindowSec - graceSec >= 600` for the same claim buffer.
Registry `sendWindowSec` must be at least 300 seconds. The configured refund
window has no 24-hour cap; DESIGN defaults to 172800 seconds (48 hours).

A `termsSig` body is `{tradeId}`: the signed envelope authenticates the canonical
terms hash and serves as that trader's signature. Both traders send a `terms`
message and require the peer's matching terms and signed hash before proceeding.
Signers require both traders' verified `termsSig` messages. Nonce commitments are
inside `take` and `accept`; sealed shares are inside `deal`. The standalone
`commit` schema does not add an alternate state-machine path.
`take` includes both agreed absolute deadlines. `accept` is
`{offerId, takeCommitment, commitment, slot}`; `reveal` is
`{offerId, takeCommitment, nonce}` with no slot field. `takeCommitment` is the
taker's commitment from `take`; it separates simultaneous negotiations by the
same parties on one offer. `decline` is `{offerId,takeNonce,reason}`, where
`takeNonce` is the take envelope's nonce; reasons are `busy`, `insufficient`,
`signers`, `expired`, `invalid`, or `version`. Pre-terms `abort` can carry the
commitment; after terms, its `tradeId` identifies the negotiation.
`working:{tradeId,step:'certificate'}` is sent only by the buyer during on-demand proving.

The buyer sends one `deal` body:

```js
{tradeId, k, committeeBoxKeys: hex32[], H: hex32,
 commitments: pointHex32[], sealedShares: [{ephemeralKey: hex32, nonce: hex24, ciphertext: hex48}], proof}
```

The wire proof is required (never null). There are exactly k commitments and n
sealed shares. `checkDealShape` checks the strict schema, canonical commitments,
trade ID, threshold and committee order. `signerShareCheck` decrypts the signer's
one sealed share with AAD binding tradeId, recipient key and one-based index, then
verifies it against the saved commitments. It returns no share on failure.
Neither function performs the asynchronous certificate verification.

`proof` has exactly the snarkjs 0.7.6 PLONK keys: `protocol:'plonk'`,
`curve:'bn128'`, nine G1 points `A,B,C,Z,T1,T2,T3,Wxi,Wxiw` and six evaluations
`eval_a,eval_b,eval_c,eval_s1,eval_s2,eval_zw`. Each point is `[x,y,'1']` with
canonical decimal coordinates below the BN254 base modulus; evaluations are
canonical decimals below the BN254 scalar modulus. No extra keys, signs,
leading zeroes, exponents or oversized values are accepted. At most 17 keys,
33 numeric strings and 77 characters per numeric string bound verification input.
The public statement is `[hashHi,hashLo,cx,cy]`, all canonical decimal strings:
the two 16-byte big-endian halves of H followed by C_0's affine coordinates.
The first two are below 2^128; coordinates are below the BN254 scalar modulus.

An `ack` is `{tradeId,H,holdUntil}`. A `sharePublish` is
`{tradeId,H,signerIndex,share,commitments}`. Published commitments are exactly
the deal's k commitments, carried on both trade and signer channels and on resume.
The seller checks equality with its saved commitments, verifies each share,
reconstructs any k valid distinct shares and requires `sha256(le32(s)) === H`
before claiming. The service groups publications by commitments, validates
shares, and awards credit only to a group that reconstructs the settled H.
Registry params are `{n,k,sendWindowSec,refundSec,graceSec}`. Old stored layouts
and messages are unsupported; there is no migration or compatibility path.

## Runner integration

Trader config is `{mode:'maker'|'taker', offerId, terms, registry, nonce, entropy,
now}`. `terms` supplies the locally approved amounts, addresses, fees and absolute
deadlines, plus a well-formed committee/R placeholder. Negotiation recomputes R
and the committee from a pinned, already-verified registry. Initialize with the
newest registry, persist the highest accepted version, and keep the selected
snapshot for an existing trade. No service-key trust or registry fetching is
implicit in the constructors.

`nonce` and `entropy` are separate fresh 32-byte CSPRNG values. `nonce` is revealed
in negotiation. A pool certificate has an independent random secret. `entropy`
stays private and generates coefficients and sealing randomness via
`seededRng(entropy, 'dealing:' + tradeId)` (also the secret on an empty-pool fallback);
never derive it from a public value or reveal nonce. The two
values must differ. Keep private states/records encrypted at rest and out of logs.

The runner signs `send`/`publishShare` actions with the role identity key. For
incoming messages it calls `envelope.open` using one replay cache per receiver
across all channels, then delivers:

```js
{type: 'message', message: verifiedEnvelope, now, observedSlot?, observedSlotAt?, tipSlot?, tipSlotAt?}
{type: 'tick', now, chain?}
{type: 'resume', now}
```

`now` must not regress. Deliver the appropriate verified messages in protocol
order; buffering belongs to the runner. Handshake traffic uses
`intercom-dex:t:<offerId>` until the terms hash exists, then
`intercom-dex:t:<tradeId>`. The runner manages the corresponding channel joins.
Published shares also accept `intercom-dex:signers` and tolerate the same valid
share arriving on both channels. Replay-cache exhaustion fails closed; it never
evicts still-valid nonces. Persist or restore replay state across receiver
restarts as needed by the runner. Authenticate and authorize sender/channel
membership before allowing unrelated traffic to consume a trade replay budget.

The runner supplies its finalized-slot observation as `event.observedSlot` and
its age in milliseconds as `event.finalizedAgeMs` when delivering `take`,
`accept` or `reveal`. The slot must be a nonnegative safe integer; the age must
be finite and `0 <= finalizedAgeMs < 15000`. Missing, stale or negative observations
leave the original state and clock unchanged, with no actions; the runner must
deliver a fresh retransmission. Other message kinds do not require these fields.
The maker signs its tip observation (`tipSlot`, below) in `accept.slot` before sending its reveal; finalization
trails the tip by about 32 slots on mainnet, and a finalized accept slot would leave the reveal only seconds.
The taker accepts only `observedSlot - 50 <= accept.slot <= observedSlot + 150` (`ACCEPT_SLOT_BEHIND`, about 20 s;
36 from 0.1.20, 12 before), and refuses an accept whose reveal cutoff its tip already passed.
Both traders store this fixed value as `state.acceptSlot`. The runner also supplies `tipSlot` and `tipAgeMs`, a highest-processed-slot
view with `0 <= tipAgeMs < 6000`. Ages use a monotonic clock and include request
time, preserving R7's freshness rules. Both maker and taker
abort a precommit negotiation on a valid peer reveal when
`tipSlot >= acceptSlot + 56`, with reason `Reveal arrived too late`.
A reveal cannot replace the slot. After both reveals, request the first finalized slot at least
`state.acceptSlot + 96` and deliver
`chain:{acceptSlot,slot,blockhash,finalized:true,firstFinalized:true}` on a tick.
The core checks the bound and nonce commitments and computes R. The adapter
establishes finality and the first eligible slot. Create committee signer states
once terms exist, before routing both traders' `termsSig` messages to them.

Every message is checked for trade/offer ID, signed channel, exact body schema,
kind-specific sender authority, and current phase. Only the buyer can send
`deal` or `refunded`; only the seller can send `transferSent` or `claimed`. An ack must come from a committee identity (its
index is inferred from `from`; the ack body has no index). A `sharePublish` must
come from the member at its explicit one-based `signerIndex`. Negotiation
messages come from the peer trader; signers accept `termsSig` from either trader.
The envelope layer drops malformed wire messages. Invalid shares and logical
duplicates are ignored; a correctly routed dealing that fails local checks is refused.

A peer trader's valid `abort` may end a precommit negotiation. The commit points
are buyer `locking` with `lockAttempted:true`, seller `transferring`,
and signer `holding`. After these points network traffic cannot terminate the
trade. Precommit definite adapter failures and timer deadlines can end it; the
stale `accept.slot` rule above is the explicit additional negotiation rejection.
Timers, rather than unrelated messages, drive deadline transitions. Late
negotiation messages cannot start new funding or payment.

Actions are plain objects: `send`, `prove`, `checkProof`, `persist`, `lockEscrow`, `checkEscrow`, `reserveEscrow`,
`sendTransfer`, `verifyTransfer`, `publishShare`, `claim`, `refund`, `abort`.
Buyers also emit `acquireCertificate` and `prepareDeal`, both carrying `tradeId`.
The host returns `certificateAssigned:{tradeId,now,certificate}` (entry or null),
then `prepareDeal:{tradeId,now}` after the assignment was saved and the pool entry
deleted. These are internal adapter events, never wire messages.
Every adapter result carries `type`, `now`, and its `tradeId`:

| Result | Required additional fields / meaning |
| --- | --- |
| `proved` | `ok:true, proof` attaches the certificate; `ok:false, reason?` aborts before locking |
| `proofChecked` | `ok:boolean` completes a pending certificate check |
| `escrowLocked` | `ok:true, hashHex`; confirms the lock transaction |
| Ambiguous lock | `ok:false, unknown:true, hashHex?`; sets `locked:true` and preserves refund recovery |
| Definite lock failure | `ok:false` without `unknown:true`; proves nothing was sent, clears `lockAttempted` and aborts |
| `escrowReserved` | `hashHex, ok, reservedFor?`; see the reservation contract below |
| `escrowChecked` | `ok:true, hashHex, status:'active'`; adapter verified the full terms on an independent RPC quorum |
| Pending escrow check | `ok:false, hashHex, status:'missing'|'pending'`; seller retries on later ticks before sendBy |
| Settlement check | `purpose:'settlement', hashHex, ok, status`; `ok:true` with `claimed` or `refunded` resolves the trade; `active` or failures keep recovery running |
| `transferSent` | `ok:true, txHash, sentAt`; submission must precede sendBy |
| Ambiguous transfer | `ok:false, unknown:true, txHash`; posts the known hash and waits for shares; sentAt is not required |
| `transferVerified` | `ok:true, final:true, txHash, amount, from, to, asset, nonce, finalizedAt, usedBy?` |
| `claimed` | `ok:true, claimSignature` confirms this seller's claim; `ok:false,status:'refunded'` definitively ends recovery in phase `lost` |
| `refunded` | `ok:true, refundSignature` |
| `error` | `reason, definite?, purpose?`; a settlement check error uses `purpose:'settlement'`; adapter errors after an attempted lock cannot abort it |

`checkEscrow` passes `{terms,hashHex}` to the Solana adapter. A positive result
means all account/vault/fee/recipient/mint/refund invariants and RPC quorum
checks passed. An absent escrow while the buyer is still locking is pending;
an actual mismatch aborts. The core waits for both a positive verdict and at
least k distinct committee acks with the right hash and sufficient hold time.

Before sending, a ready seller (`escrowOk && acks.length >= k && now < sendBy`)
enters the new phase `reservingEscrow` and emits exactly:

```js
{type:'reserveEscrow', tradeId, hashHex}
// Runner completion:
{type:'escrowReserved', now, tradeId, hashHex, ok, reservedFor?}
```

The runner atomically and durably reserves the escrow for one trade, across all
seller states. It resolves the hash using the trade's configured network/program
and escrow identity. Reservation is idempotent for the same `tradeId` and must
remain reserved across restarts and completed trades. Only `ok:true` with
`reservedFor === tradeId` before `sendBy` moves to `transferring`, records
`transferStartedAt`, and emits the existing action:

```js
{type:'sendTransfer', tradeId, asset, from, to, amount, nonce, sendBy}
```

`ok:false` with a different valid trade ID in `reservedFor` aborts with reason
`escrow already used by another trade`; no transfer has been authorized.
Other boolean-result failures or adapter errors set `reserveRetryAt = now + 10`;
a tick at/after that time reissues `reserveEscrow` and clears the timer.
Wrong trade/hash or malformed callbacks are ignored. Ticks, reservation callbacks,
errors and resume at/after `sendBy` abort without sending. A reservation resume
before the deadline reissues the same action and clears its retry timer.

`verifyTransfer` passes the Trac verifier's `{asset,txHash,from,to,minAmount,
nonce}`, plus `tradeId` and `finalBefore`. Normalize its result to the richer
event above, including independently established finalization time. An adapter
that only returns `{ok,reason,amount,final}` does not yet satisfy the deadline
contract. Exact amount matching is required by the core. `finalizedAt` must be
strictly before `sendBy + graceSec` and cannot lie in the future. A verification
already in flight may return after that cutoff with an eligible finalizedAt.
The accepted finalizedAt is stored in state; reservation and publication remain
eligible afterward. The cutoff expires signers still waiting for a transfer
notice, and stops new transfer notices from starting verification. It never
discards an in-flight verification or an eligible pending reservation. Invalid
results release no shares. RESET application proof and TNK signed-state proof
remain the peer adapter's responsibility.

Persistence uses an explicit completion event:

```js
{type:'persisted', now, tradeId, scope, ok, txHash?, reservedFor?}
```

For `scope:'signerShare'`, confirm only after encrypted share storage is durable;
the signer emits no ack before that confirmation. For `scope:'verifiedTransfer'`,
atomically reserve `{txHash -> tradeId}` in the signer's shared durable used-tx
store, honoring `record.ifUnused`. Confirm with `txHash` and `reservedFor` only
if unused or already reserved for this same trade. The signer publishes no share
before this confirmation. A failure (`ok:false`, this trade and scope; `txHash`
may be omitted but cannot name another transaction) or adapter error in
`persistingTransfer` sets `reserveRetryAt = now + 10`. A tick at/after it reissues
`{type:'persist',scope:'verifiedTransfer',tradeId,record:{txHash,reservedFor:tradeId,ifUnused:true}}`
and clears the timer. This phase never expires: final transfer eligibility was
already established. Resume also reissues the reservation and clears its timer.
A copied in-memory used-tx snapshot alone cannot
prevent races across separate concurrent trade states. Other persist scopes
(`reveals`, `locked`) record recovery metadata.

Once `lockAttempted` is set, peer aborts and generic adapter errors cannot abort
the buyer, even when an error carries `definite:true`. In `locking`, errors set
`lockRetryAt = now + 30`; a due tick reissues the same
`{type:'lockEscrow',tradeId,terms,hashHex}` and clears the timer. The adapter must
resume its journaled transaction. At `refundAfter`, a tick or resume while still
`locking` sets `locked:true`, `lockUnknown:true`, clears the lock timer, enters
`refunding` and emits `{type:'refund',tradeId,terms,hashHex}`. Existing funded
locks enter refunding at the same deadline. Definite `escrowLocked` failure is
the explicit exception: it proves no submission and clears `lockAttempted`
before aborting. A settlement check reporting `ok:false,status:'missing'`
without `unknown:true` at/after `refundAfter` also clears `locked` and
`lockAttempted` and aborts, but only if `lockUnknown` was true. An uncertain read
or a confirmed lock is never written off this way. Consequently new transitions
cannot produce `aborted && lockAttempted && !locked`; no migration of old
abandoned states is performed by this core.

Buyer phase `locked` polls settlement after seeing `transferSent` (saved in
`txHash`) or `claimed` (saved as `sellerClaimed:true`), or once
`now >= sendBy + graceSec`. Notices seen during `locking` are remembered for
the lock result. Each check emits
`{type:'checkEscrow',purpose:'settlement',tradeId,terms,hashHex}`, sets
`settlementPending:true`, and sets `nextSettlementCheck = now + 30`.
Ticks, notices and refund failures honor both the timer and pending flag.
Phase `refunding` uses the same polling cadence. `ok:true,status:'claimed'`
enters `complete`; `ok:true,status:'refunded'` enters `refunded` in either phase.
An active escrow or failed check clears the pending flag and allows the next
scheduled check. No seller notification suppresses refund recovery on its own.
Failed refunds still schedule `refundRetryAt = now + 15`.

Sellers in `awaitShares` or `claiming` start settlement polling on ticks at/after
`refundAfter`, using the same action/result shapes and pending flag, with
`nextSettlementCheck = now + 60`. A verified claimed result enters `complete`
and emits no new claim; a verified refunded result enters `lost`. `lost` is
terminal for every event, including resume. Active escrows and failed checks
keep recovery running; late valid shares can still trigger a claim, and failed
claims still retry every 15 seconds. A buyer's network `refunded` notification
cannot substitute for adapter settlement evidence.

The runner must complete each settlement check with its matching
`escrowChecked` event (including `ok:false` on failure), or
`{type:'error',now,tradeId,purpose:'settlement',reason}`. This clears
`settlementPending` without confusing concurrent refund/claim errors. An
unlabelled error also clears it in buyer `locked` or seller `awaitShares`, where
there is no concurrent mutation. In `refunding`/`claiming`, an unlabelled error
belongs to the mutation and preserves a pending check. Correlate results and
serialize each operation in the runner; never synthesize a missing/claimed/
refunded verdict from transport failure.

Persist the optional state fields: buyer `lockRetryAt`, `sellerClaimed`,
`nextSettlementCheck`; seller `reserveRetryAt`, `settlementPending`,
`nextSettlementCheck`; signer `reserveRetryAt`. Buyer `settlementPending`,
`lockAttempted` and `lockUnknown` retain the recovery meanings above. Retry timers
are integer Unix seconds, cleared to `null` after retry/resume; omitted polling
timers mean a first check is eligible. Pending certificate state also includes `deal`; buyers keep `privateState` and
`H`, and signers keep their checked share before confirming the certificate.

## Restart and resumption

Persist the whole returned state before executing actions, including its
`lastMessages`, preimage, original transfer intent and eligible finalization time.
After restoring it, deliver `{type:'resume',now}`. It re-emits the outstanding
action below and the last batch of `send` actions, where the peer may be waiting.
The maker's accept/reveal batch preserves their order. The runner preserves the original signed take envelope and its nonce on restart
and retransmission, so declines remain correlated. Other resumed actions can get
fresh envelope nonces; duplicate protocol messages leave receivers unchanged.

| Role and phase | Re-emitted action |
| --- | --- |
| Buyer `awaitCertificate` | `acquireCertificate` |
| Buyer `preparingDeal` | `prepareDeal`, using the saved certificate assignment |
| Buyer `proving` | `prove` with the same private scalar and statement before sendBy; otherwise abort |
| Buyer `awaitAcks` | Last deal; preserve acks and evaluate the lock/cutoff on the next tick |
| Seller or signer `checkingProof` | `checkProof` with the saved statement and proof, subject to their deadlines |
| Buyer `locking` | `lockEscrow` before sendBy (the adapter signs new bytes only before `sendBy - LOCK_START_MARGIN_SEC`); wait afterward, and enter `refunding` at refundAfter |
| Buyer `refunding` | `refund`, plus any pending settlement check |
| Buyer with pending settlement check | `checkEscrow` with `purpose:'settlement'` |
| Seller `awaitReady` | `checkEscrow`; reset the cached positive verdict and rebuild the in-flight flag |
| Seller `reservingEscrow` | `reserveEscrow` before sendBy; otherwise abort |
| Seller `transferring` | `sendTransfer` with `resume:true` and the original trade-bound nonce/sendBy |
| Seller `claiming` | `claim` with the saved preimage, plus any pending settlement check |
| Seller `awaitShares` with pending settlement check | `checkEscrow` with `purpose:'settlement'` |
| Signer `persistingShare` | `persist`, scope `signerShare` |
| Signer `verifyingTransfer` | `verifyTransfer` for the same txHash |
| Signer `persistingTransfer` | `persist`, scope `verifiedTransfer` |
| Signer `published` | `publishShare` again on both channels |

Waiting negotiation/ack/share phases re-send their last protocol message; a signer
repeats its ack only before sendBy and afterwards answers `present`. Buyer
`refunded` and seller `complete` can re-send the settlement notification; `lost`,
`aborted` and `expired` are not restarted. `published` means release is authorized,
not that delivery was acknowledged; the runner must retain it and invoke resume
when publication needs retrying. A resume uses the same dealing and transfer nonce.
A regenerated PLONK certificate may differ in bytes, but proves the same statement. Deadline transitions for attempted locks and pending
escrow reservations are listed above. Resumed settlement checks set their next
check time to resume time +30 seconds (buyer) or +60 seconds (seller).

The core's replayed action is an intent, not permission to duplicate a payment.
Adapters must reconcile/journal the exact original submission. In particular,
`sendTransfer` with `resume:true` must recover the original signed payload/hash
and its chain outcome; it must not build or broadcast a new payment merely
because its prior response was lost. Lock, claim and refund adapters must also
be idempotent by trade/hash. Preserve `unknown`, `txHash` and refunded settlement
status in callback normalization rather than collapsing them into generic errors.

The runner owns scheduling/resume delivery, encrypted storage, atomic used-tx
and escrow reservations, transport buffering and independent chain reads. Only
restart recovery should reissue an operation marked pending; the runner prevents
two live copies. `src/roles/host.js` persists transitions before executing these
actions and delivers asynchronous results outside the trade queue.

## Certificate phases and role setup

After `new`, negotiation runs through `awaitTake` (maker) or `awaitAccept` (taker),
`awaitReveal`, `awaitRandomness`, `awaitTerms`, `awaitTermsSig`, and the internal
`negotiated` transition. The buyer enters `awaitCertificate`, then `preparingDeal`;
the seller
enters `awaitDeal`. A signer starts in `awaitTermsSignatures`, then `awaitDeal`.

The trader's `CertificatePool` stores verified entries `{secretHex,H,C0,proof}`
under `certpool-<H>` in the encrypted role store. `proof.pool` is a nonnegative
integer (default 2; zero disables refill). Refills generate one fresh random
secret and proof at a time in the worker, only while the prover is idle; the
pool checks the secret/commitments and calls `verifyLock` before storing.
On assignment, state `certificate` holds the full entry and `H` names its hash.
The host saves this state before removing the entry and building the deal.
Reserved entries are excluded in memory; startup scans all durable trade
assignments so a crash before deletion cannot cause reuse. Resume rebuilds the
same polynomial and sealed shares using the saved secret and dealing entropy.
An empty pool logs a generic notice and enters `proving` to generate a certificate.

```js
// Buyer after negotiation:
{type:'prove', tradeId, secretHex, statement}
// Completion from the host:
{type:'proved', tradeId, now, ok, proof?, reason?}
// Seller/signer after a valid local deal check:
{type:'checkProof', tradeId, statement, proof}
{type:'proofChecked', tradeId, now, ok}
```

With a ready certificate or successful proving, the buyer sends the `deal` and
enters `awaitAcks`. It records distinct committee identities in committee order,
requiring this trade's `H` and `holdUntil >= refundAfter`. At k acks, only while
`now < sendBy - LOCK_START_MARGIN_SEC`, it enters `locking`, records
`lockAttempted:true`, and issues `{type:'lockEscrow',tradeId,terms,hashHex:H}`.
At the cutoff without a first lock it aborts with `Signers did not confirm`.
Failed proving aborts without a lock. Existing attempted-lock recovery is unchanged.
At `draft.sendBy`, ticks, resume and proof completion while proving abort with
`Negotiation deadline expired`; a later completion cannot revive that trade.

A seller/signer in `awaitDeal` validates the dealing (signers also check their
own share) and enters `checkingProof` with `checkProof`. Shape/share failure
uses `Invalid dealing`. A false `proofChecked` uses `Invalid lock certificate`.
The seller aborts before escrow/payment actions; signers emit no ack. A positive
seller check enters `awaitReady` and checks the escrow; only a valid escrow,
k acks and a durable reservation lead to `transferring`. A positive signer check
enters `persistingShare` and emits
`{type:'persist',scope:'signerShare',tradeId,record:{terms,signerIndex,share,H,commitments,holdUntil}}`.
Durable completion enters `holding` and sends the ack. Certificate checks that
complete/resume at or after sendBy (seller), or sendBy + graceSec (signer), abort.

Remaining buyer phases are `locked`, `refunding`, `complete`, `refunded`, `aborted`.
Seller phases are `reservingEscrow`, `transferring`, `awaitShares`, `claiming`,
`complete`, `lost`, `aborted`. Signer phases are `holding`, `verifyingTransfer`,
`persistingTransfer`, `published`, `expired`, `aborted`.

Every `bin/dex.mjs` role calls `checkProofFiles` before connecting or opening keys.
Traders require `proof:{zkey:'/absolute/path/lockkey.zkey'}`; their zkey hash is
checked too. Pins live in `src/proof/files.js`. Verification caches the validated
verification key and returns false for malformed or invalid proofs. Proving is
queued once per process, runs `snarkjs.plonk.fullProve` in a native worker thread,
and verifies the result before returning it. The worker uses the installed
web-worker bootstrap and ffjavascript's single-thread mode because its web-worker
adapter cannot create nested workers. All curve workers are terminated; the main
role stays responsive while a certificate is built.

## Liveness in the trader runner

`Trader.onlineSigners(registry?)` returns active, nonremoved identities from the newest
usable registry whose authenticated heartbeat was received within 90 seconds
(`SIGNER_ONLINE_SEC`), with software meeting the required registry minimum.
Receipt times use `performance.now()` and stay in memory. Existing trades pass
their original registry snapshot so a new minimum does not cancel their work.
`eligibleOnline(quoteAmount,pair,registry?)` also checks the limit and base asset.
New admission requires n deterministically eligible signers and k+1 online eligible
signers, excluding both traders. Missing capacity throws `Not enough signers online`
on take or sends `decline:signers` on the maker. The host supplies counts and
identities on trader events. Committee construction and terms signing still require
k+1 of the selected committee online. These checks never replace acks.

Maker admissions run in arrival order, reserve size before admitting the next
take, and allow `MAX_TRADES_PER_OFFER = 3` before the lock per offer and
`MAX_NEGOTIATIONS_PER_TAKER = 3` per taker. A take whose sender is not the named taker
gets no answer; one whose pair, registry version, minimum amount or deadlines do not
match is declined `invalid` (0.1.18; earlier makers did not answer those). Since 0.1.31 every authenticated take a
maker refuses gets an answer: a maker without a usable registry declines `busy`; a pair the registry cannot resolve,
or terms the maker's network profile rejects, is declined `invalid`; a take that reaches the maker's negotiation but
does not match its terms ends that negotiation with an `abort` whose reason is `Invalid take`; and a maker whose
Solana view stays older than the negotiation limits for `MAKER_CHAIN_WAIT_MS = 10000` after a take arrives ends it with
an `abort` reason `Maker could not read Solana`. Each declined envelope nonce receives at most one decline, recorded
for 300 seconds; a sender gets at most `DECLINES_PER_TAKER = 6` declines per minute and all senders together
`DECLINES_PER_MINUTE = 30`. A decline the transport refuses while its stamp queue is busy is sent again up to three
times, 2 s apart. Malformed and unrelated takes are ignored.
Aborted trades release reservations. Accept/reveal routing checks the commitment;
decline routing checks the saved take envelope nonce before buffering.

`STEP_BUDGET_MS` in `terms.js` exports `accept:40000`, `connect:80000`,
`randomness:120000`, `terms:30000` (signers), `termsExchange:60000` (traders; 30000 before 0.1.20), `deal:60000`, `certificate:150000`,
`working:10000`, `acks:60000`. The host supplies `stepElapsedMs` from its monotonic
step entry observation on ticks/messages. A taker gets 80 seconds total including
connecting, and 40 seconds after the maker peer is present on the offer channel.
Offers sign `peerKey` (the maker's swarm public key). The bridge's authenticated
`dex_presence` query reports whether that peer's channel protocol is open. The host
polls on ticks; an authenticated maker message also proves a usable channel path.
`dex_warm {peerKeys}` (peer 0.1.15+, at most four keys) replaces the makers a client keeps connected before any
take; it shares pins with trade routes and returns the keys kept. Traders warm the best offer's maker on each side of
markets the dashboard shows (makers on 0.1.14+, heard within 70 s); older peers refuse it and nothing is warmed.
Channel joins and randomness requests cannot suppress timeout ticks. A silent
taker is abandoned when a fresh chain tip reaches the existing reveal cutoff.

The deciding-block budget includes waiting for reveals. Seller and signer deal
waits start at 30 seconds; each authenticated working note adds 30 seconds, capped
at 150 total. Late notes cannot revive a wait. Buyer proving emits notes every
10 seconds. Restart resets elapsed step clocks and connection observations while
retaining any already granted deal-budget extension. Absolute chain deadlines
still apply. After receiving a valid-shaped deal, the seller waits through proof
and escrow checks until sendBy, or the buyer's pre-lock abort. Step budgets never
end recovery after an attempted lock or seller transfer.

## Registry assets, software and network profiles

Registry `pairs` is a strict bounded list (1–64 entries) of
`{pair,base:{kind,id,decimals},minBaseAmount,status:'open'|'paused'}`; IDs are plain
ASCII. Signers list unique `assets` and `software`. The latter is part of the
signed snapshot so committee version filtering stays deterministic, independently
of heartbeat arrival order. The whole registry is capped at 1,800,000 serialized
ASCII bytes to fit the transport envelope. Registry `minSoftware`, offers, takes,
heartbeats and service status use strict semver; `SOFTWARE` comes from package.json.
`meetsVersion(version,minimum)` applies semver precedence, including prereleases.

Offers, takes, books, tickers and trade logs carry `registryVersion`; terms already
did. Admission checks the named snapshot and the newest registry's pair pause and
software minimum. Existing trades and settlement evidence use their original
snapshot. Unsupported base kinds appear as `needs a newer version` in status.
Below-minimum programs show `update required` in status/MCP and start no new trades.
An optional service `latest:{version,commit,sha256}` announcement is displayed as
data; it causes no download, execution or other action.

`src/market/assets.js` keeps `ASSET_KINDS` and adapter pins, not a pair list:
TNK (`trac-native`, MSB, 18 decimals), RESET (`trac-contract-token`, profile-pinned
subnet/contract, 8 decimals), and quote USDC (`usdc-solana`, 6 decimals).
`registryPair(registry,pair,{open=true}?)`, `supportedBase(base)` and
`pairStatus(registry)` expose supported entries/status. `quoteAmount(pairEntry,
baseAmount,price)` and `tradePrice(pairEntry,baseAmount,quote)` use the registry
entry's checked decimals. Signed terms carry `base` for adapter dispatch; adapters
never infer it from the pair's display name.

`networks/mainnet.json` and `networks/local.json` supply mint, escrow program,
platform collector, and exact peer MSB/RESET identities. `bin/dex.mjs` requires
`network:'mainnet'|'local'`, rejects mainnet overrides before connecting or opening
keys, and matches the peer's resolved profile before creating adapters. Unknown
mainnet pins are explicit required source fields; config cannot fill them.
See `docs/NETWORKS.md` for configuration and public profile helper signatures.

Build the key with `node bin/proof-setup.mjs --out /absolute/lockkey.zkey
--ptau /absolute/powersOfTau28_hez_final_18.ptau`. Omitting `--ptau` downloads the
pinned public file to the output directory, validates its blake2b-512 and only
then publishes it. Setup validates the r1cs/wasm/vkey pins, generated zkey SHA256,
and exported verification key, and refuses to overwrite an existing output.
Temporary files are cleaned on failure; caller-supplied files are preserved.

## Validation

```sh
source ~/.nvm/nvm.sh && nvm use 23.11.0
node --test 'tests/unit/**/*.test.mjs'
DEX_PROOF_ZKEY=/absolute/lockkey.zkey node --test tests/proof/
```

Fast unit tests stub `proved` and `proofChecked` results and never make a real
proof. They cover VSS encodings/subgroup rejection, deterministic dealing,
share checks, machine proof phases/deadlines/resume, settlement and recovery.
The separate proof suite proves at most twice, verifies public-statement binding,
checks malformed proof rejection and modified file copies, and derives a key
from a local ptau. E2e receives the key path from `DEX_PROOF_ZKEY`; its injected
buyer attacks check refusal before payment and unchanged TNK, RESET and USDC
balances after either no lock or a refund.

## Traffic and relay APIs

- `shareRequest:{tradeId}` is strict. A published signer accepts it only from the
  seller or configured service identity, once per requester/trade/30 s, until
  refundAfter. The service asks for a logged trade's missing shares at most
  three times (`SHARE_REQUESTS`), 600 s apart. Seller requests use the trade channel; service requests use
  `intercom-dex:signers`. Published signers resend only their publication at
  10/20/40/80/160/320/640-second delays, then only answer requests. `present` retains its
  separate 3-second requester limit. Waiting outboxes repeat every 10 seconds (every
  2 seconds in `awaitReveal`), only before sendBy for buyers/signers and before
  sendBy + graceSec for sellers, whose transfer evidence can still reach signers
  during grace. Later settlement/refund waits send no automatic outbox repeats;
  explicit `present` replies and missing-share requests keep working.
- Only the buyer sends summons containing both terms signatures, every 20 seconds
  while waiting for k acks. This avoids two public copies of the same summons.
- `verifySummon(body, registry, now)` (roles/common.js) also requires
  `now < sendBy <= now + sendWindowSec + SUMMON_SKEW_SEC` (120) and
  `refundAfter - sendBy = refundSec - sendWindowSec`; signers and the venue use it.
  Signers hold at most `MAX_HELD_TRADES = 32` unfinished trades and
  `MAX_HELD_PER_TRADER = 8` per buyer or seller key (roles/signer.js).
- The venue's watches from summons without a logged settlement share
  `MAX_UNPROVEN_WATCHES = 20000`; a full capacity archives one past
  `sendBy + graceSec` with no settlement report. Logged settlements always get a
  watch. Unmatched share messages are kept only from registry signers, at most
  `UNMATCHED_PER_SENDER = 16` per sender and trade (roles/service.js).
- `publicReceiver(now?)` (roles/common.js) checks public-channel envelopes with a
  per-sender replay cache of `PUBLIC_PER_SENDER = 512` entries in front of the
  shared 65,536-entry cache.
- Full `book:{pair,registryVersion,ts,seq,levels,remaining?}` uses at most 50 aggregated levels
  per side. Levels are `{side,price,baseAmount,offers}`; `offers` is a count.
  Only full books accept optional `remaining: [{offerId,amount}]`, at most 200 unique IDs with base-unit
  integer strings. The venue includes the first 200 open offers in its existing book order, leaving out offers
  whose maker's wallet cannot fund the pair's smallest trade (seller: the base asset and the 0.03 TNK transfer
  fee; buyer: the USDC and 0.01 SOL; read at most every 300 s, an unreadable wallet hides nothing). Neither books
  nor deltas contain offer bodies; listeners obtain these from maker-signed `intercom-dex:offers` announcements.
  `bookDelta:{pair,seq,upserts,removes}` is cumulative against that full snapshot;
  removes are `{side,price}`. The envelope timestamp orders deltas within one seq.
  Unknown seq, older deltas and older full snapshots are ignored. A full snapshot
  repairs gaps every 60 seconds. There are no market-data fetch requests.
- `priceLevels(offers)`, `BookFeed.next(pair,registryVersion,offers,now,nextSeq)` and
  `BookView.full(body)/delta(body,ts)` implement this feed. `BookView.books` is the
  reconstructed map used by trader status and MCP. Reconstructed deltas omit `remaining`; the original
  full snapshot remains in `BookView.bases`. Display levels never admit or
  reject a trade; takers require the maker's signed offer and the maker reserves
  its own inventory.
- Offer announcements are every 45 seconds (120 before 0.1.14). Venue books, dashboards, status and takes leave out
  an offer not heard for 70 s (150 s for offers made before 0.1.14); observations are kept for 300 seconds. Dashboard
  takes at a price level go to the oldest offer. Display includes the oldest 20 live offers per maker across pairs.
  `MAX_TRADES_PER_OFFER=3`, `MAX_NEGOTIATIONS_PER_TAKER=3`; busy admissions get a `decline`
  with reason `busy`, like other capacity declines.
- Registry signer entries optionally include `relayKey`; the registry optionally
  includes `serviceRelayKey`. Both are strict lowercase 32-byte hex peer keys.
  Active, nonremoved signer keys and the service key replace the dynamic list on
  every new valid registry version. Static config relay keys are merged.
- `RegistryRelays(bridge).update(registry)` serializes bridge updates and retries a
  failed update on the next registry receipt. `Bridge.setRelays(keys)` sends the
  authenticated strict command `relays.set`; `Bridge.relayStats()` sends
  `relays.stats`. `BlindRelay.setRelays(keys)` changes future dials without closing
  running sessions. Self keys are excluded from outgoing relay candidates.
- Sidechannel `broadcast(...)` returns `Promise<boolean>`; bridge and command
  callers await it. `powRequiredPrefixes` complements exact `powRequiredChannels`.
  Open channels retain welcome/invite exemptions but honor PoW and owner rules.
  Nonce search serializes fixed fields once, yields in roughly 8 ms chunks and
  caches identical stamped content while it is pending and for less than 60 seconds
  after its stamp (5,000 entries/16 MB; pending entries are never dropped).
  `powClasses` lists kind groups from most urgent; unlisted kinds follow, then
  `powLowKinds`, refused with `Stamp queue busy` while `powLowPending` (default 4) of them are pending. A stamp
  yields to any pending more urgent stamp at its next chunk, for at most `powYieldMs` (default 2,000 ms) in total;
  after that it shares the worker with them, so a stream of urgent stamps cannot starve offers. The dex uses
  `DEX_POW_CLASSES` and `DEX_POW_LOW` (`['decline']`) from dex-transport.js: heartbeats
  and safety messages first, negotiation next, dealings after negotiation, then
  unlisted kinds and declines. Deal stamps yield to pending accept/reveal stamps.
  The dex uses one difficulty, 20 bits, on offers, signers and trade channels.
## Locks

Locks use separate identities, channels and registry snapshots. A trader uses its existing peer with
`locks: true`; lock signers use dedicated peers. Set `locks.venueKey` in the trader configuration to enable
`createTraderLocks` from `src/wallets/locks.js`. Without it, no locks keys, client or routes are created.
The complete protocol is in [LOCKS.md](../../docs/LOCKS.md).

```js
createPost({product,maker,terms,registryVersion,createdAt?,nonce?,escrowPreimage?,drawSlot?}, registry?, context?)
validatePost(post, registry?, {counted?,totalLocked?,openPositions?,makerPositions?}?)
positionId(post) // sha256(stableJSON(post))
selectCommittee(registry, positionId, finalizedDrawSeed?)
products[product].decide(position, facts) // {winner,outcome}; puts also give winners:{E,H}
// facts = {counted,T,M,payments:[{step,blockTime,ok,amount?}],cancelAccepted,reservation?,scanned?}
// T: verified timestamp, height->timestamp map, or synchronous function T(height).
// M: verified median time past at counted, or synchronous M(counted).
// Before deadline: blockTime <= M(counted). At deadline: blockTime < T(deadline).
// No RESET/TNK transfer is a deadline fact. Put exercise is a holder-signed finalized Solana memo.
// A nonpayment decision needs the complete finalized history scan; scanned:false defers it.

new LocksClient({venueKey,identity,box,me,store,registry,transport,clock,adapters,now?,settings?,software?})
client.start(); client.stop()
client.post({product,terms})
client.take(positionId)
client.pay(positionId, 'repay'|'exercise')
client.refund(positionId) // Put writer; existing unclaimed escrow after refundAfter.
client.cancel(positionId)
client.receive(channel, envelope)
client.onClock()
client.requestRelease(positionId)
client.refreshBook({product?,asset?,page?})
client.list({product?,asset?,page?,minSize?,maxSize?,minTerm?,maxTerm?})
client.status(positionId?)
client.preview({action,product?,terms?,positionId?})
client.getSettings(); client.setSettings(partial)
client.readEvents(since=0)
```

Every new post names `terms.asset`: RESET (8 decimals) or TNK (18 decimals). USDC has 6 decimals. A put also
publishes a random 32-byte `escrowPreimage`; its hash is the escrow hash and its lock recipient must still sign
the claim. Take reserves first, prepares/funds holder lock H, then pays the premium. Exercise releases E to
holder; H waits for finalized escrow settlement. Claimed sends H to writer, refunded returns H to holder; expiry returns E to writer and H to holder. A lapsed reservation returns funded H to its holder.

Opening fees come from the maker receipt: loan `floor(principal * loanBps / 10000)`; option
`min(premium,max(optionMin,floor(premium * optionBps / 10000)))`. `openingTotal` is exactly the shown principal
or premium; `makerReceives + openingFee = openingTotal`. Repayment stays the full `repay`. Put escrow funding
adds only the program platform fee and requires zero collector trade bps. Example: 100 USDC at 50 bps pays
99.50 to the borrower and 0.50 to the collector; 5 USDC at 1000 bps pays 4.50 and 0.50.

The encrypted durable store supplies synchronous `get/put/list`. Position writes and signed transaction bytes
precede effects. `WalletManager` applies `accountLockBalances` and serializes locks admission with spot trading
and withdrawals. Confirmed external locks are separate from pending wallet reservations. Runtime ports:

| Port | Contract |
| --- | --- |
| `exclusive(work)` | Run through the wallet admission queue. |
| `admit({registry})` | Require the matching locks protocol and a free SOL allowance before new funding. |
| `fundingFee()` | Current TNK fee for each pending funding transfer. |
| `freeBalance(asset,{positionId?})` | Free base units, excluding the current position's own reservation when rechecking it. |
| `lastPrice(asset)` | Last DEX RESET/USDC or TNK/USDC decimal price, or null. |
| `solanaPay.build({payer,payee,amount,fee,collector,mint,memo})` | Net maker transfer plus fee in one transaction. |
| `solanaPay.verify/scan({endpoints,need,...expected})` | At least two finalized readers; scan also needs `fromSlot`. |
| `submit({id,transaction,position,step,beforeSend?,scalar?,sendBefore?})` | Durable signed bytes, callback before signing and sending, winner fee payer, optional raw-scalar signature. |
| `transfer({id,asset,amount,to,nonce,position})` | Journal and send the ordinary transfer with its exact locks funding nonce. |
| `reconcile({id,step,position,input})` | Reconcile original bytes; never sign a replacement payment. |
| `hasIntent(id)` | Whether signed Solana or Trac bytes exist; an unsigned client intent may resume preparation. |
| `escrowCosts({registry,amount})`, `fundEscrow({id,position})` | Read finalized platform/collector configs, reserve full cost and fund E. |
| `tracFor(scalarWallet)` | Adapter bound to `{...scalarSigner(a),address}`. |
| `tracLock.sweep({a,to,adapter,positionId,journal,asset})` | Journaled RESET then TNK, or one TNK sweep, minus MSB fee. |
| `edvss.verifyShare(j,share,C)`, `reconstruct(shares,k,C)`, `publicOf(a)` | Validate every share and the reconstructed public key. |
| `escrowLock.claimAndSweep({a,escrowPreimage,winnerSol,mint,amount,tradeFeeCollector,programId})` | Atomic claim, transfer and close; caller signs after setting blockhash. |

Successful operations return `{ok:true,finalized:true,signature?,txHash?}`. Everything else stays pending until
reconciliation proves its outcome. Neither a submission acknowledgement nor wallet balance changes establish
finality. Early release is usually 1–2 hours after payment, once the verified Bitcoin median covers it.

`src/locks/transport.js` is the wire schema. A `lockRequest` contains `{positionId,post}`; its envelope signs the
post. Venue book messages contain `{positions,page,pageSize,total,requester}`. Each row contains original
`posted` attestations that authenticate the post, registry version and lock commitments; no detached signature
or duplicated readiness list is required. `opened` quorum comparison omits the member-specific j field.

Holder DKG, funding and release messages carry `takeId` with the same `positionId`; absence of `takeId` means E
or the maker's asset lock. Readiness binds A, C, Q, chain and address, with at least n−1 matching members.
`opened.holderLock` binds the holder lock for the writer. Release sealing context is
`{positionId,from:j,to:winner.lockKey}` plus `takeId` for H, scope `release`. Use `openShare` and `fromLe32`,
then verify against C before reconstruction. Historical venue pickup verifies original signer envelopes.
Valid release receipts for fee credits are sent only after the winner's sweep finalizes.

The configured control server composes the locks routes under the existing bearer authentication. Dashboard
routes retain cookie/host/origin checks and exact one-use confirmations. All relevant routes accept `asset`.

| Route | Response/input |
| --- | --- |
| `GET /api/locks?product=&asset=&page=` | `{rows,total,page,next}`, 50 rows; size/term filters remain available. |
| `GET /api/locks/mine?positionId=&asset=` | `{rows,counted,prices}`; each row has role, state, asset, now, ifMissed, nextAction, deadlines and fee amounts. |
| `GET /api/locks/events?since=&asset=` | `{rows,next,events,oldest,truncated}`; rows have id, at (milliseconds), text, asset. |
| `POST /api/locks/preview` | `{sentence,input,confirm?,amounts,...status}`; `input` is canonical and can be passed unchanged to act. |
| `POST /api/locks/act` | `{ok:true,result:{positionId,...status}}`. |
| `GET /api/locks/settings` | Automatic settings, including UI alias `autoRepayBlocks`. |
| `POST /api/locks/settings` | Partial automatic settings; returns the full settings. |

Dashboard post inputs are flat decimal strings: loan `{action:'post',product,asset,principal,collateral,fee,repay,termBlocks}`;
options `{action:'post',product,asset,amount,strikeTotal,premium,expiryBlock}`. The service sets a bounded offer
window unless given. The base-unit form `{action,input:{product,terms}}` remains available for MCP. Other actions
take `{action,positionId,asset?}`. Dashboard act also needs `confirm`; the control bearer token authorizes tool
actions directly. Formatted row amounts are `{units,text,unit}`. Unknown fields and duplicate query parameters
are refused. Errors return `{ok:false,reason,whatToDo}`. `already_taken` before payment costs nothing.

RESET/TNK locks require enough surviving signers; handover can replace signers while at least k survive.
Put writers can refund unclaimed USDC after `refundAfter`. See [SKILL.md](../../SKILL.md#locks-tools) for
all seven tools, settings, states and actionable failures.
