# Borrow, lend and options

Locks let two people agree to a loan or to a right to buy or sell RESET or TNK later. Amounts and deadlines are fixed
when the position opens. One maker posts and funds a position; one taker takes the whole position. There are no
partial fills. USDC uses 6 decimals, RESET 8 and TNK 18. All protocol amounts are integer base-unit strings.

Locks have their own venue, signed registry, signer processes, keys and channels. A spot trade uses the separate
DEX protocol in [SPEC.md](SPEC.md). Enabling locks does not change its messages, registry or deadlines.
A trader uses one peer with `locks: true`; signers use dedicated locks peers. Set `locks.venueKey` in the trader
configuration to pin the separate venue. The trader saves separate locks keys and journals in its encrypted store.

Spot address proofs activate at DEX registry minimum 0.1.34. Locks use a separate admission rule: a party's `trac`
field is a chosen receiving address, not evidence of wallet ownership or available funds. Signers verify finalized
funding at the committee-generated lock address; the venue and clients require the committee's matching posted
attestations. Put holders also fund their committee-generated asset lock before opening. Naming another wallet
cannot substitute its balance for either lock. Release shares are encrypted to the winning party's signed `boxKey`.
Locks offers do not establish address ownership for spot offers, chat identities or seller strikes.

## What each product does

| Product | Maker locks | Taker pays to open | Payment before the deadline | Winner if paid in time | Winner otherwise |
| --- | --- | --- | --- | --- | --- |
| Loan | `collateral` RESET or TNK, plus `tnkReserve` TNK | `principal` USDC total, opening fee deducted from borrower receipt | Borrower pays `repay` USDC to lender by `dueBlock` | Maker, the borrower | Taker, the lender |
| Covered call | `amount` RESET or TNK, plus `tnkReserve` TNK | `premium` USDC total, opening fee deducted from writer receipt | Holder pays `strikeTotal` USDC to writer by `expiryBlock` | Taker, the holder | Maker, the writer |
| Cash-secured put | `strikeTotal` USDC in escrow, plus escrow fees | `premium` USDC total, opening fee deducted from writer receipt | Holder sends a signed Solana exercise memo | E to holder; H follows finalized escrow settlement | E to writer, H to holder |

For a loan, `dueBlock = takeAnchor + termBlocks`. Each signer accepts the proposed `takeAnchor` only within
±2 of its own RESET counted height. Calls and puts have an absolute `expiryBlock` in the post. Opening pays the
maker directly. Repayment and exercise require one full payment: overpayment is accepted, separate partial
payments are never added together. Extra money is not returned automatically. An unused option's premium is
not returned. A position that is never taken returns to its maker after cancellation or `offerUntilBlock`.

“Protect against a drop” locks your RESET/TNK for the term. After reservation, the holder prepares a second
Trac lock H with the same committee, funds `amount` plus `tnkReserve`, then pays the premium. Both funding and
payment must finalize within the reservation. If it lapses after funding H but before opening, H returns to the
holder. Exercise is a small Solana message signed by the holder, with no asset transfer. On exercise the holder
gets the writer's USDC escrow lock E and claims it immediately. H stays locked until two finalized Solana readers agree on the escrow's terminal state: a claim releases H to the writer; a refund returns H to the holder. Without exercise, each gets their own lock back.

## Deadlines and recovery

The clock is the Bitcoin height `counted` by the RESET ledger, read through a signer's own peer. A displayed
approximate time is blocks × 10 minutes, rounded to `~N days` or `~N hours`; it is not a guaranteed wall-clock time.

For height N, RESET records `hash/N`. `T(N)` is the uint32 little-endian time at byte offset 68 of the 80-byte
Bitcoin header whose double-SHA256, reversed for display, equals that hash. Applied RESET header operations carry
raw bytes in `p.hx`; any other header source is acceptable only after the same hash check.

A Solana payment counts only if finalized, successful, and matched to the expected payment, with
`blockTime < T(N)`. Exactly at `T(N)` is too late, as is one second later. A signer waits until `counted >= N`
and scans the recipient token account's history for matching memos before deciding nonpayment. Sending a `paid`
message is useful but not required for the scan to find a payment. A signer returning after a deadline uses the
same chain history, not the time it returned.

For early release, `M(c)` is the median time of the 11 Bitcoin headers c−10 through counted height c. Every
header is checked against its RESET hash. A finalized repayment, call exercise, or put exercise memo with
`blockTime <= M(c)` is provably before any future deadline N > c. Release follows usually 1–2 hours after payment,
when this median catches up. A payment one second beyond the median waits. At the deadline the strict
`blockTime < T(N)` boundary still applies. No RESET/TNK transfer or local observation time decides a deadline.

RESET and TNK locks rely on enough signers surviving with their shares. Signers can be replaced by handover while at least k survive. They have no trustless refund: if fewer than k
shares survive, the coins can stay locked permanently. Registry exposure limits bound the amount at risk. A put
writer can refund USDC through the existing escrow after `refundAfter` if it remains unclaimed, even if every
signer disappears. Once that time arrives, a holder's claim and the writer's refund can race. The finalized outcome decides who receives H, so the writer cannot collect both the USDC and the holder's asset.

Keep the trader, peer and wallet journals available through collection. An offline conversational session is fine
if the trader process keeps running. If the trader itself is offline, automatic repayment and exercise cannot
run: a missed loan deadline gives the collateral to the lender; an unused call or put expires and loses the
premium. Restarting after the deadline can collect a valid outcome but cannot make a late payment timely.

## The lock and its committee

A lock is an ed25519 public key `A = a·B`. Nobody is meant to know the private scalar `a` while the position is
open. Signers hold Feldman shares with threshold k of n, always `k > n/2`. The Trac address encodes A as
`trac1` bech32m; the Solana address encodes the same 32 bytes as a public key.

When the active pool equals n, the committee is the whole pool. When it is larger, the maker names
`drawSlot` as its finalized Solana slot plus 32. Signers accept within ±150 slots. The first finalized block
at or after it supplies the seed for the DEX draw. `signers[].group` is `operator` or `external`;
`params.minOperatorSigners` defaults to k, and draws continue until that minimum is met.

Each signer i contributes a random degree k−1 polynomial over the ed25519 prime-order subgroup,
`L = 2^252 + 27742317777372353535851937790883648493`, with commitments `C_i[t] = f_i[t]·B`.
Its `dkgDeal` contains `positionId`, i, commitments and one sealed share for every recipient. Sealing uses
X25519, HKDF-SHA256 and XChaCha20-Poly1305, with info `intercom-locks/v1/dkg-share` and associated data
`stableJSON({positionId, from:i, to:j})`. Recipient j checks every share against its commitments.

The DKG uses a common qualified set Q of at least n−1 valid dealers. Every member sums only those dealers'
shares and commitments, stores its final share encrypted and durably with fsync, then sends `lockReady`.
The maker funds only after at least n−1 matching A, C and Q attestations. A failed attempt needs a fresh nonce
and position ID. The venue stores sealed shares for an offline member, who verifies and derives its share on
return. The aggregate public key is `A = sum(C_i[0])` over Q.

Every signer durably records its one decision before sending a release sealed to the winner's box key. It never
changes the decision or gives its share to both parties. The winner checks each share against C, reconstructs a
with Lagrange interpolation at zero from k distinct valid shares, and checks `a·B = A` before spending.
With `k > n/2`, two conflicting outcomes cannot both get k releases from signers that follow that rule.

Raw-scalar ed25519 signing derives
`prefix = sha512("intercom-locks/v1/nonce" || le32(a))[0:32]`,
`r = sha512(prefix || message) mod L`, `R = r·B`, and
`S = r + sha512(R || A || message)·a mod L`. The signature is ordinary ed25519 and is checked as such.

## Funding and payments

RESET and TNK funding use ordinary transfers to the Trac lock, each with nonce
`sha256("intercom-locks/v1/fund" || positionId || asset)`. Signers verify final balances at least as large as
the required asset and the registry's `tnkReserve`. A TNK lock receives `amount + tnkReserve` TNK and sweeps it in one transfer minus the MSB fee. On release, the winner sweeps RESET first and then TNK
minus its transfer fee. Keep a separate SOL balance for Solana fees.

A put uses the existing escrow program without changing it. The payer and refund address are the writer; the
recipient is the escrow lock address E. The writer draws a random 32-byte `escrowPreimage` p and publishes it
in the post. The payment hash is `sha256(p)`. Knowing p does not authorize a claim: the program also requires
E’s signature, which needs k released shares.
The minimum `refundAfter` is `now + (expiryBlock - counted) * 600 + recoveryMarginSec` at funding. The client
adds `reserveSec` so signer observations after finality still satisfy the minimum; the saved timestamp is shown
in status. The writer deposits the
strike amount plus the program's global platform fee. `escrowCollector` must have a zero-bps trade configuration. Signers check amount, recipient, refund
address, H, mint and unclaimed status. The winner claims using a, signs for E and uses its own Solana wallet
as fee payer. In the same transaction it moves USDC from E's token account to itself and closes E's token
account to itself. The writer's program refund remains available from `refundAfter` while unclaimed, using `dex_lock_pay` with `step: "refund"` or the control action `refund`. The client checks finalized Solana time and journals this transaction before broadcast.
If the platform fee changes after admission, funding waits instead of spending more than the reserved amount.

Every direct USDC payment is one Solana transaction containing:

1. SPL `transferChecked` from the payer's ATA to the recipient's ATA for the maker’s net receipt (opening) or the full repayment/exercise amount.
2. Only for opening, a second `transferChecked` to the registry fee collector when the fee is positive:
   the opening fee deducted from the maker’s receipt. The two transfers sum to the shown principal or premium.
3. The exact SPL Memo `intercom-locks:v1:<positionId>:<step>`, where step is `open:<takeId>`, `repay` or `exercise`.

Missing recipient ATAs are created idempotently in that transaction. The client then sends
`paid {positionId,step,signature}`. Each signer uses its own Solana RPC endpoints, at least two agreeing, to
check finality, no error, the expected payer, mint, transfers and exact memo. Repayment and exercise have no
opening fee. No wallet transfer made by hand substitutes for these checked payments.

## Opening fees

Fees are charged once and deducted from what the maker receives. A loan charges
`floor(principal * fee.loanBps / 10000)`. An option charges
`min(premium, max(fee.optionMin, floor(premium * fee.optionBps / 10000)))`.
At 50 loan bps, a lender pays exactly 100 USDC: borrower gets 99.50, collector gets 0.50; borrower still repays
103 in full if that is the agreement. At 1000 option bps with a 0.05 USDC minimum, a 5 USDC premium pays 4.50
to the writer and 0.50 to the collector. A 0.01 USDC premium is entirely the fee; writer receives zero.
Repayment, exercise, cancellation and sweep have no locks service fee. Ordinary network costs still apply.

`fee.signerShareBps` defaults to 4000: 40% of the fee is divided equally among committee members in Q that
deliver valid releases for the final decision; the venue keeps the rest. Credits stay provisional for 7 days
before becoming final. For puts, this window starts after both E and H have matching release quorums. A signer must be in both qualified dealer sets and have valid recipient receipts for both releases. Clients disclose receipt keys only after the corresponding sweep or claim is final; a verified refund and empty E also makes its receipt safe. Put escrow funding uses a zero-bps `escrowCollector`; only the global platform fee applies.

## Taking and cancelling

A taker sends signed `take {positionId,takeId,taker:{lockKey,boxKey,trac,sol},takeAnchor?}`. For a posted position
with k posted attestations, each signer reserves for the first taker it accepts and returns
`reserve {positionId,takeId,takerKey,expiresAt}` with `expiresAt = now + reserveSec`.

The client pays only after k distinct reservations for its take, with at least `payMarginSec` remaining on each.
It checks the margin again after preparing the transaction and before submission. The opening transaction's
`blockTime` must be at most the verifying signer's `expiresAt`; equality is accepted for this reservation rule.
Sending with less time is refused. A payment that lands late can still cost the taker its money without opening
the position, so do not manually bypass the reservation check. `already_taken` before payment costs nothing.

Unpaid reservations expire and the position becomes posted again. A signer accepts a maker's `cancel` only
without a live reservation, then releases to the maker. A cancellation request alone does not mean the funds
are back; wait for the ended outcome and collection.

## Registry and limits

The locks venue signs a separate registry under a pinned locks venue key. It has `version`, `issuedAt`,
`minSoftware`, `params`, `products`, `limits`, `fee`, `signers` and `removed`. Versions increase and dates cannot
regress; a registry dated more than 60 seconds into the future is refused. Conflicting content under one version
pauses new positions. An existing position keeps its original registry, committee, fees and limits until it ends.

| Field | Meaning and bound |
| --- | --- |
| `params.n`, `params.k` | `k > n/2`, `k <= n <= 16`. |
| `params.dkgTimeoutSec` | Maximum time for qualifying DKG contributions; example 120 seconds. |
| `params.reserveSec` | Reservation lifetime; example 600 seconds. |
| `params.payMarginSec` | Minimum reservation time left before payment; example 120 seconds. |
| `params.termBlocks.min` | Loan minimum, at least 6 blocks; example 144. |
| `params.termBlocks.max` | Loan maximum, no larger than `offerMaxBlocks`; example 12960. |
| `params.offerMaxBlocks` | Maximum offer duration in counted Bitcoin blocks; example 12960. |
| `params.recoveryMarginSec` | Extra put refund time after estimated expiry; example 604800 seconds. |
| `params.tnkReserve` | TNK deposited beside RESET or added to the TNK amount, in 18-decimal base units. |
| `products.loan`, `products.call`, `products.put` | Each product is open or paused for new positions. |
| `limits.RESET.min`, `limits.RESET.max` | Minimum and maximum RESET amount per position; min must not exceed max. |
| `limits.USDC.min`, `limits.USDC.max` | Minimum and maximum USDC amount per position; min must not exceed max. |
| `limits.totalLocked.RESET` | Aggregate RESET exposure cap. |
| `limits.totalLocked.USDC` | Aggregate USDC exposure cap. |
| `assets.RESET`, `assets.TNK` | Asset availability for new positions. |
| `limits.TNK.min`, `limits.TNK.max`, `limits.totalLocked.TNK` | TNK size and exposure bounds. |
| `fee.loanBps` | Loan opening fee, at most 1000; example 50. |
| `fee.optionBps`, `fee.optionMin` | Option opening rate and minimum in USDC units; example 1000 and "50000". |
| `fee.signerShareBps` | Portion owed to eligible signers; default 4000. |
| `params.minOperatorSigners` | Minimum operator members of a drawn committee; default k. |
| `fee.collector` | Direct opening-fee recipient on Solana. |
| `fee.escrowCollector` | Put escrow trade-fee collector. |
| `signers` | Each has `lockKey`, `boxKey`, `label`, `status`, `software`; only active, compatible signers participate. |
| `removed` | Signers removed from new committee selection. |
| Open positions per signer | At most 2000. A registry may lower this limit. |
| Open positions per maker key | At most 50. A registry may lower this limit. |

## Position records, states and events

A post is `{v:1,product,maker:{lockKey,boxKey,trac,sol},terms,registryVersion,createdAt,nonce}`.
`positionId = sha256(stableJSON(post))`, with sorted JSON keys. The maker signs the post. Loan terms are
`asset`, `collateral`, `principal`, `repay`, `termBlocks`, `offerUntilBlock`; call and put terms are `asset`, `amount`, `premium`,
`strikeTotal`, `expiryBlock`, `offerUntilBlock`. The nonce is fresh 32-byte lowercase hex; IDs and identity
keys are 32-byte lowercase hex too. Puts also include `escrowPreimage`; larger-pool draws include `drawSlot`. No extra term fields are accepted.

| State | Meaning |
| --- | --- |
| `creating` | Signers are jointly preparing the key; no funding yet. |
| `funding` | Funding is being sent or checked. |
| `posted` | The funded whole position is available. |
| `taking` | Reservation or opening payment is in progress. |
| `running` | A taker opened the position; its repayment or exercise deadline applies. |
| `ended:repaid` | The borrower paid in time; collateral returns to the borrower. |
| `ended:defaulted` | The loan was not repaid in time; the lender receives collateral. |
| `ended:exercised` | The holder exercised in time and receives the lock. |
| `ended:expired` | An option or untaken offer expired; the maker receives the lock. |
| `ended:cancelled` | Cancellation was accepted; the maker receives the lock. |
| `ended:unfunded` | The attempt ended before funding; do not send funds to it. |
| `released` | The winner's sweep has finalized. |

`now` and `ifMissed` explain the next step and the deadline consequence in English. Status also gives
`counterparty` as a short key, `nextAction`, `dueBlock`, `expiryBlock`, `blocksLeft` and put `refundAfter`.
Secrets, shares and signed transaction journals never appear in status or events. The event stream retains
1000 events: `creating`, `funding`, `posted`, `taking`, `running`, `paid`, `cancel_requested`, `ended`,
`released`, `settings`, `attention`. Each carries an increasing cursor; keep `next` for the next request.

## Network messages and traffic

On public `intercom-locks`: venue `registry` and signer `heartbeat` every 30 seconds, plus event-driven
`lockRequest`, `posted`, `book`, `bookRequest` and `releaseRequest`. Book pages have at most 100 rows.
On `intercom-locks:p:<positionId>`: `dkgDeal`, `dkgFail`, `lockReady`, `funded`, `take`, `reserve`, `paid`,
`opened`, `cancel`, `release`, `ended`. Envelopes are signed by their senders' locks identities.

Position channels are joined only for an active step and left afterwards. Restart does not rejoin every
position channel. Requests drive retransmission; there are no blanket retry timers over all positions.
A signer answers a `releaseRequest` at most once per 60 seconds per requester and position. The venue stores
status and opaque sealed releases for later pickup by offline parties; it does not choose winners.

## Automatic actions

`autoRepay` defaults to true, with `repayBlocksBefore: 6`: a borrower pays when the deadline is at most six
blocks away and sufficient free USDC is available. `autoExercise` defaults to true, with
`exerciseBlocksBefore: 6` and `exerciseMarginBps: 100`. It uses the DEX last RESET/USDC or TNK/USDC price for the position’s asset: a call exercises
only when the asset value after subtracting the margin exceeds `strikeTotal`; a put exercises only when
the asset value after adding the margin is below `strikeTotal`. A missing price triggers no exercise. The
margin is a price allowance, not a guarantee of a sale at that price. Available USDC and network fees
are still required. `autoSweep` is always true and cannot be disabled.

Offsets accept 1 to 12960 counted blocks and the margin accepts 0 to 10000 bps. Increase offsets when chain
reads or finality are slow. Increase the margin to avoid exercising near the strike. Switch automatic repayment
or exercise off only with a plan to make the payment yourself through the locks tools before the deadline.

The tool reference, failure reasons and practical response to each are in [SKILL.md](../SKILL.md#locks-tools).
The dashboard and MCP list pages contain 50 rows, with `asset`, exact opening total, maker receipt and fee.
A protocol mismatch returns `protocol_unavailable` before put funding; use compatible signer and peer software.

The authenticated HTTP and runtime interfaces are in [the API reference](../src/core/API.md#locks).
