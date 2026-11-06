# RESET stake, delivery and rewards

The local custody path can deposit exact RESET principal into independent 3-of-4
stake addresses, certify it, freeze withdrawals, wait the signed delay, and return
principal through sealed shares to the original wallet. The local-chain
`stake-withdraw` case exercises a completed price-seed trade, funding, the wait,
and trader restart before collection. The `stake-free-expiry` local-chain case
also verifies that finalized chain time passes the original expiry and that a
trader restart returns the exact principal without a renewal or extra wait.

Release 0.1.48 includes bonded terms, ack-round reservations, position-based
penalty adjudication, original-piece buyer collection, live-offer rewards, reward
forfeiture, exact surplus replacement, deferred and mixed-epoch returns,
late-funding refunds and history reconciliation. The full local acceptance pass
(every named penalty, withdrawal, funding, handoff, reward and released-0.1.47
case) passed twice in a row on the release revision, followed by the timing-load
run. Release 0.1.49 pages large reward checkpoint bodies between the venue,
stake members and payout service. Every signed wire message remains at most
180000 bytes, under the unchanged 200000-byte sidechannel limit. Release all
required roles together before arming an enforcing production registry.

Small RPCs retain the v0.1.48 format. Larger bodies use a signed manifest and
signed pages containing at most 90000 binary bytes each, encoded as base64.
Brotli compression removes repeated certificate bodies; the signed manifest
binds the SHA-256 of the exact canonical, uncompressed UTF-8 body, original
request/reply kind, byte lengths, page count and transfer identity. The receiver
checks all pages and the digest before invoking a handler. Neither compression
nor paging grants funding slots. Reward verification is bounded at 5000 pieces;
the existing signed funding-capacity maximum remains 2000 pieces. Per-account
limits, ownership, duplicate detection and reward weight calculations are unchanged.

Paging is enabled only between configured venue, payout and current or retained
stake member identities. A body is at most 8 MiB before and after compression.
Each receiver reserves at most 32 MiB across 16 incomplete transfers, at most four
per sender, with a 30-second absolute reassembly deadline. Duplicate pages do not
advance progress, foreign or unsolicited reply pages allocate nothing, and a
bounded replay cache suppresses completed transfers. Stopping the transport or
expiring a request releases its partial replies. Individual pages carry the same
PoW difficulty and priority as stake RPCs.

The venue learns expiring routes from signed DEX identities inside signed peer
messages, including unchanged trader requests and signer heartbeats. Addressed
stake traffic goes to its recipient's route. Server checkpoint pages bypass the
venue's public send queue; ordinary leaf replies and relayed leaf traffic retain
that queue's budget. Unknown recipients are never flooded to trader or market-feed
leaves. While a signer starts or reconnects, the venue holds up to 64 addressed
frames and 8 MiB for at most 30 seconds, then sends them only when a signed route
arrives. Relayed strangers can reserve only ordinary requests of at most 4096
bytes; larger held frames must come from the authenticated local server app. Payout pages are paced at 24000 bytes/s, charging before the first page,
to leave room for the public queue's 32000 bytes/s within the existing 64000-byte
receive rate. No sidechannel size or rate limit changes.

0.1.49 raises the stake cap and lets the venue move enforcement earlier; 0.1.48 apps refuse both registry
changes, so every trader updates to 0.1.49. Paging itself needs no trader update: It rejects unknown
page kinds silently, and unrelated checkpoint pages never reach its connection.
Servers may roll forward one at a time: RPCs that fit remain interoperable;
oversized exchanges with old servers time out. Three matching updated original
members suffice for a large checkpoint once the venue and payout service are
updated. The collector proceeds as soon as three matching votes arrive instead
of waiting for an old or unavailable fourth member. Without that quorum the
checkpoint remains unavailable; no partial body or partial certificate is used.
The payout's rewardBlock request allows 60 seconds for the nested rounds and
paced archive; proposal freshness remains 60 seconds and capture agreement
remains within 15 seconds.

Local validation on 2026-11-03 passed free expiry with exact principal return and
a nonempty reward checkpoint: 25000 active stake atoms received 2x weight and
accrued 100 unpaid atoms. Updated buyers completed bonded delivery; no-show paid
the original 25000-atom piece once, forfeited the 100 unpaid atoms, and survived
buyer restart without another collection. Delivery inside grace closed without
penalty. Untouched released v0.1.47 buyer code displayed `Peer aborted: update the
app` against an armed maker, with all balances and signer admission unchanged.
A changed-member A→B handoff also passed with an open A reservation: original
delivery settled, 25000 stake atoms returned under B, and venue/signer/trader
restarts did not repeat the return or capacity retirement. That acceptance run
covered the draining transition; the separate resume path requires its own validation.
Delivery during a certified outage also closed without penalty. A buyer who
never locked, or locked after the strict cutoff while the seller withheld
delivery, received no penalty; both reservations closed unfunded. Delivery
released after a certified penalty decision transferred the original 50000 atoms
and still paid the buyer the original 25000-atom stake award. All nine named
penalty rows now have local-chain passes across the retained acceptance runs.

## Stake policy

The stake policy requires sellers on every USDC-quoted spot pair to lock RESET.
Buying needs no stake, but buyers must update too. Once the policy is armed, a
buyer without `stakeVersion: 1` and its receiving box key is refused with exactly
`update the app`. This check does not raise `registry.minSoftware` or exclude
otherwise eligible signers. The ledger supports reward-only buyer stake, which cannot
be reserved or penalized; the current deposit action creates seller-purpose
pieces and does not yet expose that choice. One account address shares a stake cap across all trading identities
and pairs. The default cap is $10,000 at admission (signed setting, at most $1,000,000). Rising value stops new exposure,
not existing recovery. There is no minimum deposit beyond one RESET base unit.

The deposit calculation divides the exact requested amount into internal lock
pieces near $0.50, $5, $50 and $500, plus an exact residual. At $20 per RESET, a 1 RESET
deposit creates thirteen pieces. Principals add up exactly to the requested
amount. Allocation chooses the smallest sufficient whole-piece sum, then fewer
pieces, earliest expiry and unit identity. An exhausted search budget refuses
admission; it never silently increases a penalty with an approximate selection.

Only free pieces can back another sale. Reserved stake remains locked but is a
subset of the locked total, not another debit. Withdrawal freezes stop new
reservations and earn no rewards. The default withdrawal wait is 86400 seconds,
measured from the certified freeze. A reserved piece cannot return before the
trade resolves. Verified delivery closes the reservation by advancing its public
generation; no private key is released. A terminal return or buyer award retires
that address permanently. Loan and option configuration does not enable spot
stake custody.

Deposit fees are separate from RESET principal. For N pieces, TNK transfer fee F
and collection reserve R, initial TNK debit is `N * (2F + R)`: two funding transfers
and one reserve per piece. A complete return normally adds two transfers per
piece and leaves `R - 2F` TNK for the winner. At F = 0.03 and R = 0.09 TNK, thirteen
pieces need 1.95 TNK initially, spend 1.56 TNK over the complete lifetime and
return 0.39 TNK. Fee changes require a fresh check; promised RESET is not sold or
deducted to buy TNK. New deposits retain an additional maintenance allowance of
`N * (2F + R)` without debiting it up front. Exact withdrawals collect the certified
source once and fund the surplus into fresh independent locks, preserving original
expiry and source lineage. Exhausted allowance, unavailable TNK, or a closed
original epoch leaves replacement pending; it never renews the source lifetime.
Legacy deposits without a retained allowance cannot silently gain one.

Withdraw-all records the selected inventory, including reserved pieces. A reserved
piece stays locked until its original closure; only then can its withdrawal delay
start. The durable return intent excludes it from new reservations. Mixed-epoch
requests freeze and collect each piece through its own retained committee. Late
unadmitted funding is reconciled and returned by an original refund quorum;
members with competing funded votes refuse the refund. A TNK-only lock returns
its residue without sending new RESET after the funding window.

A draining signer handoff is available through the venue's authenticated local
`POST /stake/quiesce` and `POST /stake/handoff {nextPolicy}` routes. The old epoch
must stop admissions first, and any pending funding must finish before it freezes
its capacity vote. Three old members certify the complete capacity map; three
successor members adopt it before publication. Original pieces keep their original
custody committee, reservations, withdrawal delay and collection certificates.
Keep those signers and their full encrypted stores available until recovery ends.
Certified collections that finish during adoption are propagated to the successor
without releasing the same count token or USD range twice. Retrying the identical
handoff resumes its journal and cannot replace later successor state.

The successor initially remains `acceptNew:false`, with state `draining`.
`POST /stake/resume {}` requires a certified original price-history head, the complete
paged prefix with unchanged times and signatures, and successor adoption/readiness
quorums. The unchanged payout authority freezes and signs its complete liabilities,
counted-chain cursor and payout sequence; pending transfers must finish first.
The same ledger survives adoption. Each successor reward checkpoint merges new
inventory with contemporaneous original-committee inventory certificates. Missing
original captures stop accrual. Only after reconciliation does the venue publish
`acceptNew:true` and release the payout journal. Replays preserve adopted history
and cannot reset paid, unpaid or forfeited balances.
Oversized capacity snapshots refuse before freezing and require future pagination.

## Penalties and delivery

The default penalty is 3%, with a $0.50 minimum. For a non-RESET sale, percentage
uses the buyer's USDC payment including both independently floored fees. A net
$300 sale with 10 bps platform fee and 50 bps venue fee locks $301.80; its 3%
target is $9.054. A RESET sale instead uses 3% of the RESET sold, subject to the
same USD minimum. The final penalty is the fixed sum of selected whole pieces;
preview any overshoot and the exact RESET amount.

Price evidence must certify the latest completed RESET/USDC trade capped at that
trade's UTC-day median. If the current day has no certified completion, the latest
certified trading day supplies both the last price and its median. Signed
`priceLookbackSec` defaults to 604800 seconds (seven days), with app bounds 0–2592000;
zero disables the fallback. The last completion's age must be within that inclusive
limit. Policies omitting the setting keep the current-day-only rule. A ticker or
unfinished offer cannot substitute, and empty or older history still refuses.
An unavailable price blocks new coverage, but cannot block an owed fixed return.

The default overdue trigger is 1800 seconds after `sendBy`. The seller then gets
86400 seconds of certified healthy proof time. Infrastructure outages pause the
clock. Unknown gaps cannot later become healthy time, and corrections can only
extend the deadline. A late-observed trigger gives no credit for an unobserved
interval. A buyer must have locked exact funds strictly before the agreed lock
cutoff; a late lock or no lock cannot earn a seller penalty.

The signed `proofClock` settings allow bounded slow rounds: `sampleGapSec`
defaults to 60 (bounds 15–120), `sampleFreshSec` to 90 (15–180), and
`checkpointFreshSec` to 180 (30–300). They require the same one-hour publication
notice and stay frozen through each trade's original policy. Historical policies
retain 15/15/30 seconds. Only consecutive healthy signed observations from an
original quorum count; skipped samples, failures and longer gaps stay paused.
Probe duration beyond the freshness bound is recorded as `sample-slow`, separately
from `service-unavailable`. A present healthy sample cannot fill an earlier gap.

At the cutoff, three original signers certify the same signed MSB view position:
bootstrap, core key, indexed length and Merkle root. An exact finalized transfer
whose signed operation exists in that historical checkout is in time. An operation
present only in a later prefix is late and still owes the penalty. RESET additionally
requires its independently verified signed applied result. An exact pre-cutoff
operation with a pending result defers judgment; a proven later operation stays
late. An unrelated hash cannot pause the clock.

Certified outage intervals retain their before/after positions. A delivery
provably included during such an interval excuses the penalty. Missing prefixes,
reader failures and unknown gaps pause or defer; local observation time never
substitutes for the historical proof. Original signer receipts and proof outboxes
are durable. After the certified proof window closes, new hashes are retained as
incidents; already received candidates still require final resolution. Partial
terminal votes retain one decision and recheck fresh health/history on recovery. Retrying uses the original pre-deadline signed bytes through grace;
it cannot originate a replacement payment. Terminal quorum authorization cannot
be reversed by later evidence.

Both traders sign the selected pieces, generations, original epoch, price/policy
and fixed payout. The existing signer ack carries the exact reservation identity
and piece digest after durable reservation. Missing or mismatching reservation acks
prevent the buyer lock. Delivery/spot-share publication and penalty votes share a
durable exclusion barrier, including saved-outbox replay. Finalized Solana history
must prove the exact timely buyer lock and exclude a claim before an award.

The status projection uses exactly these delivery states:

| State | Meaning |
| --- | --- |
| `delivery_sending` | The funded trade is waiting for its send. |
| `delivery_failed` | A send failure was recorded; inspect `reason`. |
| `delivery_overdue` | Delivery is not verified at the displayed deadline. |
| `delivery_confirming` | An original transfer hash or uncertain send is awaiting confirmation. |
| `delivered` | Delivery or the supported settled-trade path is verified. |
| `penalty_paid` | A recorded penalty payment is confirmed. |

Every delivery carries ISO `deadline`, integer `deadlineUnix`, `atRiskUsd`,
`atRiskReset` and optional `tx`. Failed/overdue warnings include the same amounts
and deadline. Amounts are integer strings with separate decimal `formatted`
fields. Legacy trades show zero collateral at risk. A warning cannot authorize
an award, clear a strike or move funds. Current strike settings remain separate.

## Rewards and the payout service

The pool is a separate ordinary RESET wallet. Stake principal and penalties never
enter it. The default budget is 5 RESET/day, spread across 144 Bitcoin blocks.
Integer atom rounding distributes the exact daily total over 144 consecutive
heights. Within a block, fractional share dust goes to the largest remainder,
then canonical account address. These rules make replay deterministic.

Live sell-offer backing earns weight 2x by default; other free/reserved stake,
including buyer stake, earns 1x. Withdrawals earn zero. Above-cap stake earns zero;
the capped inventory is selected in unit-id order per account. Inventory, book
and price certificates must name the same block. Three distinct epoch signatures
on identical facts are required; aliases do not create additional account caps.

Accrual requires confirmed pool RESET minus all unpaid accruals to cover the full
block budget. An empty block accrues nothing and creates no debt. Refilling resumes
at the next block, without back-pay. Each block has a signed audit summary and
retained source certificates. A gap or chain reorganization stops processing
until facts are reconciled.

Payout is due at 0.1 RESET unpaid, or weekly for a positive balance. The payout
service writes an intent, stores signed transfer bytes, then broadcasts. It keeps
only one outstanding transfer and reconciles that exact transaction after restart.
Unknown confirmation cannot create a second payment. TNK fee funds are checked
before every send. A certified seller penalty forfeits that seller's unpaid
rewards. An award is saved even when a signed payout remains unresolved; it
blocks further sends until confirmation determines the remaining unpaid amount.
Rewards earned after that award remain separate. No pool transfer is needed to
release the forfeited liability. Buyer-only stake cannot cause a
forfeit.

`bin/dex.mjs` accepts `role: "payout"` beside its own peer with the same role.
Use a separate private `dataDir`, `trac.walletFile`, local bridge/control endpoints,
network pins, `serviceKey`, `servicePeerKey` and `trac.resetGatewayUrl`. Setup creates
an ordinary RESET wallet without a Solana wallet. The venue's signed
`sellerBond.rewardService` pins `{dexKey,tracAddr}` to that role and pool address.
It never receives a stake key or collection capability. Run it with the existing
`node bin/dex.mjs --config /absolute/payout.json` entrypoint.

The role watches the signed RESET counted-height reader every five seconds and
starts at the next block after its initial baseline. Original signers capture
inventory as each next height appears, only while their read gap stays within
15 seconds. The venue captures its book; three original signers certify inventory,
book and price, bound together by a `reward-head` certificate and effective policy.
Missing historical captures, gaps, reorganization or an epoch change stop accrual.
No current inventory is backfilled into a missed historical height.

Non-empty books use the venue's published funded offers and each signer's own
contemporaneous authenticated maker announcements. Signers reject unobserved or
enlarged offers and independently check balances and non-overlapping piece backing.
The payout role imports the venue's paginated certified-award archive before
payments, binding each forfeiture to original funded-piece ownership. Unavailable
award synchronization stops new sends. Missing historical captures and complete
epoch inventory reconciliation remain release work; transport paging does not reconstruct missed captures.

Authenticated `rewardStatus` and `rewardAudit` reads expose account totals and
per-block summaries with source certificates. Traders poll the signed service
identity; stale or disconnected data reports an unknown pool, while retaining
known account totals. `GET /status` on the payout role exposes its ordinary pool
address, cursor, summary and public payment progress, never prepared bytes.

## Tools and status

```text
dex_stake {"action":"status"}
dex_stake {"action":"deposit","amount":"1"}
dex_stake {"action":"withdraw","amount":"all"}
dex_rewards {"action":"status"}
```

Deposit requires a positive decimal RESET amount with at most eight fractional
places. Withdrawal defaults to all when amount is omitted. Status rejects amount
and all requests reject unknown fields. CLI uses the same inputs:

```sh
node bin/dex.mjs stake status --config /absolute/trader.json
node bin/dex.mjs stake deposit 1 --config /absolute/trader.json
node bin/dex.mjs stake withdraw all --config /absolute/trader.json
node bin/dex.mjs rewards status --config /absolute/trader.json
```

The complete [status contract](../src/core/API.md#stake-and-reward-status-contract)
adds `stake`, `rewards`, offer `pause`, trade `delivery`, and `warnings`. Own offers
remain in `mine`. Unknown coverage or pool amounts are null. Keep machine amounts
as strings; never round them through a JavaScript number. Reads move no funds.
Deposit requires a signed custody policy and a certified completed RESET trade
for the current UTC day. An accepted deposit returns its `operationId`; pending
work resumes automatically. Poll status after acceptance. Never retry a possibly
submitted deposit as a fresh operation. Concurrent identical calls share the
existing operation; a new call after completion is a new deposit.

The venue must explicitly sign `sellerBond.custody`: `lifetimeSec` (86400–2592000),
`fundingWindowSec` (300–3600), `dkgTimeoutSec` (30–120), and `tnkReserve` (positive
base units, at most 10 TNK, also at least three current transfer fees). The policy
values recommended by the custody specification are 2592000, 3600, 120 and
`90000000000000000`. Missing custody settings disable creation. New funding holds
liquid RESET/TNK in ordinary wallet accounting, including pending network fees;
funds cannot simultaneously back a new offer or wallet withdrawal.

`role.stakePreview(units)` sends no funds and returns the split count, funding fee,
collection reserve, total TNK debit, USD amount/cap and fixed expiry. Capacity is
still subject to the independent signer grant. The direct role deposit/withdraw
methods take base-unit strings; HTTP/MCP/CLI amounts remain decimal RESET strings.
Certified free expired pieces return automatically without renewal. Original
signers and policy are retained for returns after an epoch changes; a new epoch
still needs an explicit capacity handoff before new funding can use its slots.

## Fixed error codes

Each result preserves `{ok,code,error,message,details,money,operationId?,tradeId?}`.
`money` contains per-leg asset, amount, direction, transaction and
`none|submitted|confirmed|unknown` state. A rejected new request has `ok:false`;
accepted pending work has `ok:true,state:'pending'`. Unknown submission means
money may have moved. Only a proven unsent request says no money moved.

| Code | Detail fields |
| --- | --- |
| `bond_insufficient` | `need,free,addReset` |
| `bond_in_use` | `freeAt?,addReset` |
| `bond_pending` | `etaSec` |
| `bond_stale` | `retrySec` |
| `bond_required` | none |
| `bond_price_unavailable` | `retrySec` |
| `bond_fee_tnk` | `need,have` |
| `bond_setup_unavailable` | `retrySec` |
| `bond_cooldown` | `availableAt` |
| `bond_reserved` | `reserved,tradeIds` |
| `bond_expiring` | `expiresAt` |
| `bond_not_reserved` | none |
| `bond_evidence_pending` | `checkUntil` |
| `update_required` | `minVersion` |

RESET amounts in details use eight decimals; `bond_fee_tnk` amounts use eighteen.
All detail times are integer Unix seconds. `checkUntil` is the next check, not a
permission to penalize. Ordinary validation/authentication errors are separate.
Pause codes are exactly `stake_short`, `stake_stale`, `coin_short`, `tnk_short`, `offline`, and
`price_unavailable`. Failure reason codes are `coin_short`, `tnk_short`,
`gateway_paused`, `offline`, `send_failed`, and `confirmation_pending`.

The completion-log library retains venue signatures and three-member certificates
for each ordered entry and checkpoint. It computes exact rational medians from
the complete latest trading day's prefix and checks the latest known completion.
The bounded historical fallback never truncates that day's median, re-dates an
entry or extends checkpoint freshness. A still-fresh checkpoint may cross midnight
only with the signed fallback enabled. With a lookback the latest certified day stays the price however old it is,
until a newer completion replaces it; staking never waits for a new trade.
`priceReference.utcDay` identifies the source trading day; `cutoffAt` remains the
certified head's actual cutoff. A new day's first certified completion supersedes
the historical day in the next snapshot. Admission uses the venue-signed
`admissionFreshSec` setting (default 180 seconds, bounds 60–600) for both the
price cutoff and inventory certificate through the first reservation acks.
This includes the deciding-block wait and terms exchange; expired evidence
still refuses before payment. Policies without the setting retain 60 seconds.
Other price consumers retain their 60-second bound. A replay cannot move a
completion into a later day. The venue publishes a completion only after
independently verifying both finalized settlement legs and the original signed
terms. Original signers verify those same facts. Bounded certified pages let
restarting clients recover the prefix without retimestamping past trades.

Bonded deciding-block waits use signed `randomnessWaitSec` (default 240 seconds,
bounds 120–600). Legacy policies and unbonded trades retain 120 seconds. Reveal
cutoffs, independent finality checks and payment deadlines remain enforced.
The seller uses background-prepared certificates when the block arrives; it
does not start another synchronous price/inventory round in that trade queue.

The stake DKG coordinator uses the existing lock cryptography with the fixed
4/3 epoch and original member indices. It requires a capacity certificate,
journals shares before readiness, and can recover an offline member from the
original sealed dealer messages. A share is sealed to the fixed winner only
after the stake ledger accepts a terminal certificate. Replays return the same
sealed release; a released address cannot become fundable again. The isolated
authenticated stake channel connects this coordinator to the live local roles
and exact lock-nonce funding verifier.

Capacity grants use numbered global/address piece tokens and exact integer USD
ranges. A signer writes the entire grant before returning its signature. A
certified principal collection advances token and range generations; a timeout
or falling market price cannot free them. The capacity library refuses an epoch
change until the original committee's certified handoff is adopted. It also
requires signed-policy limits and already-verified price inputs from its caller.

Seller wallet admission also checks the fresh TNK fee against existing wallet
holds. When a stake policy is present, the venue requires the entire remaining
sell amount and one fee per offer, sharing budgets across identities with the
same account address and subtracting pending sales. Missing, malformed or
60-second-old seller balances pause visibility. A new successful balance read
allows the offer to appear again; it does not waive the stake requirement.

The authenticated local `POST /retry-delivery` route accepts only `{tradeId}` and
resumes an existing own seller trade, with a ten-second throttle saved on disk.
It reports the current delivery state. Current trades retain their send deadline;
a retry after it checks the original transfer without sending again. The adapter
has a separate original-intent grace retry entry point. The bonded trader runner
schedules it durably every ten seconds through the frozen policy's grace, reusing
only an existing pre-deadline signed intent. It never prepares replacement bytes.

`auditRewardBlock` checks a published reward summary with the public payout key
and the original inventory, book and price certificates. It reproduces weights,
caps, atom rounding, pool-empty behavior and every allocation. The auditor must
independently supply the block, effective signed settings, confirmed pool balance
and unpaid liabilities, including completed payouts and forfeitures. A valid
publisher signature alone does not establish those inputs. The authenticated
`rewardAudit` RPC retains the original head and component certificates with each
published block; a complete public payout/forfeit history is still release work.

### Historical delivery position and observation helper

The installed Trac signed transaction index proves the exact finalized transfer,
including sender, receiver, asset, amount and nonce. Its `tx/<hash>` result stores
`val`, `err`, `tx`, `ipk` and `wp`; it does not expose a consensus finalization
height/time. The MSB operation does not supply one either. The adapter's
`finalizedAt` is a local observation and must never establish lateness.

The isolated `deliveryObserve` signer RPC validates both parties' original signed
terms, independently verifies the exact final transfer, then signs a conservative
observation upper bound (wall time rounded up, never earlier than the finalized
Solana clock). This is a quorum attestation, not a historical Trac timestamp.
The older `deliveryPenaltyEvidence` helper conservatively returns `unresolved`
for a first observation after the cutoff: the actual transfer may have happened
earlier. Its local timestamp is insufficient to establish lateness.

The penalty runner instead verifies inclusion in the quorum-certified signed MSB
prefix using a historical checkout, as described above. It combines that proof
with durable receipts and quorum health checkpoints. The older observation helper
is retained for diagnostics; its timestamp alone never authorizes a penalty.

`stake.reason` is limited to `price_unavailable`, `over_cap`, and `tnk_short`.
The first two describe missing current pricing and a marked stake value above
the signed cap. `tnk_short` is reserved for a confirmed fee shortage. RPC action
errors use the separate `bond_*` codes above. A status reason never moves funds.

### Bounded historical Solana reader

`solana.stakeEscrowHistory({terms,hashHex,fromSlot,throughSlot})` is a separate
read-only penalty evidence boundary. It scans up to 20 pages of 100 signatures
per independent reader, checks that the whole requested range is finalized and
not pruned, verifies signed original transactions and exact init instruction
accounts/data, and checks historical block time. A fresh finalized escrow read
also binds the original collector and retained state. It returns exact lock
receipts and claim/refund receipts, plus a digest of the scanned history.

A missing transaction, unsupported transaction encoding, unavailable timestamp,
pruned range, repeated page, page limit, read failure or reader disagreement
returns unknown. An empty complete range is distinct from an unavailable range.
Both parties sign the common accept slot as the lower history bound before the
lock opportunity. Original signers require it finalized when reserving, and the
penalty coordinator checks fresh upper bounds and claim/refund races.
The reader alone does not authorize closing a reservation or awarding a penalty.
