# Changelog

## 0.1.58

- A stake deposit is cut into pieces sized in dollars at the stake price (the smallest $0.50, the smallest penalty a
  bond can need), and the app funded those pieces one after another. With RESET at $47, a 0.2 RESET deposit became 19
  pieces and took about an hour, and a deposit of more than about 17 pieces could run past its one-hour funding window
  for the last ones. The app now funds up to eight pieces side by side: one piece waiting for its transfers no longer
  holds up the others.
- Every 15-second check re-sent the confirmation of every piece already funded, to all four stake signers and the
  venue, until the whole deposit was done. Each further piece took longer (from under a minute to about four) and the
  stake servers got the extra work. A funded piece is now confirmed once.
- App update; servers need nothing.

## 0.1.57

- A stake deposit whose key setup failed no longer stays pending forever. Before any RESET or TNK is sent, the four
  stake signers build the deposit's lock address together; if the app relays their messages too late (as with the
  stake backlog fixed in 0.1.56), the setup fails for good. The app then waited for it without end, kept the amount
  held in the wallet and blocked any new stake action. Now the app asks the signers to release the place held for
  that deposit, ends it, and reports the amount as not deposited (`notDeposited`). Nothing was sent, so nothing needs
  to come back; the wallet's RESET and TNK are free again and a new deposit works at once.
- The stake price no longer blinks out between two checks. Since 0.1.56 an app without a sell offer renews it once a
  minute, but the status showed it for only 60 seconds, so it read "price unavailable" for part of every minute. The
  status now shows the last certified price (and reward status) for up to three minutes; bonds still use a fresh one.
- Signers accept a price or stake check from the venue whose time is up to five seconds ahead of their own. Each side
  reads Solana's time from its own servers, which can be a second or two apart; the signers turned down about one
  check in thirty for that alone ("Price head is stale or omits a completion").
- A seller's offers no longer drop out of the book for a few seconds at a time. When one signer had missed a note on
  a stake piece already on its way out, the seller's stake check needed all three other signers at once, and when one
  was slow the check expired and all the seller's offers were hidden together. Such notes no longer count, and offers
  that come back are shown at once instead of being hidden once more until the seller's wallet is read again.
- Servers (venue, signers) and apps. Update the servers first; apps on 0.1.56 keep working.

## 0.1.56

- A maker that does not answer a take at all is passed over, with all its offers, for ten minutes. One maker whose app
  had stalled kept several offers at the best price, so every take went to it and timed out ("the other side took too
  long to answer"); the next take now goes to another maker. A maker that declines still only loses that one offer.
- Apps stamp stake messages in their own lane, apart from trade messages, and drop the ones nobody waits for any more.
  An app on a slow or low-priority machine queued stake requests faster than it could stamp them; the queue kept
  growing and every stake call timed out ("Stake response timed out", no stake price, a deposit stuck at
  "Stake quorum unavailable"). Restarting the app clears an existing queue.
- Apps ask for their stake and reward status once a minute instead of every 15 seconds, unless they have a sell offer
  open (sellers keep the 15-second check their bonds need). About a quarter of the stake messages, so of the work.
- App update; servers need nothing.

## 0.1.55

- Staking answers again. Every stake message from the venue, signers and payout needs a proof-of-work stamp; 0.1.52
  gave those servers eight stamping threads, but stake messages still waited for each other, so one thread did all the
  work. With more traders the queue grew past the 30-second stake timeout and stayed there, and prices, deposits and
  reward checks timed out. Servers now stamp stake messages side by side, one per thread (trade messages keep their
  order), and drop a stake message whose sender has already given up instead of stamping it.
- A signer now serves up to 16 stake requests at once from the venue, the other signers and the payout server (others
  keep 4 each, 32 together). The venue's routine seller stake checks held three of four slots at every signer, so its
  price votes were dropped unanswered.
- The venue's price vote finishes as soon as three signers agree instead of waiting for the slowest of four.
- Server update only (venue, signers, payout); apps need nothing.

## 0.1.54

- The weekly reward payout skips balances below the payout role's new `rewards.minWeeklyReset` setting (RESET base
  units, default 0; mainnet 0.0025 RESET, about one transfer fee). A tiny stake no longer costs the pool a 0.03 TNK
  fee every week to send a few millionths of a RESET; its rewards keep accruing and are paid once they reach that
  amount or 0.1 RESET. Payout update only.

## 0.1.53

- Rewards are counted again. The venue asks the signers to certify a block's reward checkpoint right when it captures
  it (they sign only within 60 s) and keeps the result; the payout takes the newest certified block after its cursor.
  Before, the venue asked only when the payout had counted exactly that block, usually too late, so no block was ever
  certified. Venue and payout update; signers and apps need nothing.

## 0.1.52

- Venue, signers and payout stamp their messages on eight proof-of-work threads instead of one. Every stake request
  and reply carries a 20-bit stamp; one thread queued replies past the 30 s stake timeout, which slowed deposits
  and stake checks to minutes. Traders keep one thread. Server update only.

## 0.1.51

- The venue checks sellers' stake three at a time, well inside the transport's limit of open requests, renews only
  checks older than a minute (sellers never checked first) and renews the price part of every check each round.
  0.1.50 asked about eight sellers at once and ran into that limit, so bonded offers could stay unlisted.
- Wallets show the yearly yield (APY) of the stake at its current share of the reward pool, next to the RESET it
  earns a day.

## 0.1.50

- The venue checks every seller's stake in small parallel batches with a fresh clock reading, instead of at most 20
  sellers one after another; sellers late in the book were left unchecked and their offers silently unlisted. The venue
  logs when stake stops or starts covering an offer.
- The balance warning shows only when a refresh is really late, not every 30 s while the next read runs.
- RESET transfers no longer flicker to paused: a momentary unknown validator count from the RESET gateway keeps the
  last healthy reading from the last minute, and the venue's status counts for 45 s instead of 15 s. A reported count
  below three still pauses at once.
- Works with 0.1.49; no update is forced.

## 0.1.49

- Large stake reward requests and replies travel in signed, verified pages within the existing message and rate
  limits. The venue routes them away from unrelated traders and market feeds. Update venue, stake signers and
  payout servers; released 0.1.48 trader apps keep working unchanged.
- Reward checkpoints proceed when three original members agree, without waiting for a slow or older fourth member.
- Stake limits: the per-address cap is a signed setting up to $1,000,000 (default $10,000). The fixed $200
  per-deposit and $4,000 venue-wide limits are gone (venue-wide now $10,000,000); signers raise their existing
  capacity records in place. Deposits add $500 pieces, so a $10,000 stake needs about 60 pieces instead of 200+.
- A deposit short of TNK says how much TNK it needs, how much the wallet has free, and why (two network fees and a
  return reserve per piece), and how much comes back on withdrawal.
- The stake clock takes the oldest two agreeing Solana readers instead of failing when any one public reader lags,
  rate-limits or answers badly. A dead public reader was removed from the defaults.
- The RESET price no longer expires: past the lookback the latest certified trading day stays the price until a
  newer trade replaces it. A completion the signers could not confirm within 15 minutes is dropped instead of
  blocking every later price.
- Rewards skip a Bitcoin height that has no checkpoint instead of stopping for good; the pool balance stays known
  between blocks.
- The venue may move stake enforcement earlier with one send window of notice. Every role must run 0.1.49:
  0.1.48 apps refuse the raised cap and the earlier activation and must update.

## 0.1.48

- Sellers stake RESET to list on every pair. A deposit is split into small pieces; one stake per account address
  covers all pairs and identities, up to $400 when it is admitted. A withdrawal waits 24 hours, and a piece backing
  an open sale returns only after that sale is settled.
- A seller who does not deliver in time pays the buyer 3% of the trade (at least $0.50) from the stake reserved for
  that trade. Delivery inside the 30-minute grace period, or during a certified outage of our services, pays nothing.
- Stakers share a reward pool of 5 RESET a day, counted per Bitcoin block. Stake that backs live sell offers counts
  double. Rewards are paid at 0.1 RESET or weekly; an empty pool pauses rewards without creating debt. A seller who
  does not deliver forfeits unpaid rewards.
- The app shows stake, rewards, the reserved stake on each sale, delivery deadlines and warnings before a deadline.
- Buyers and sellers must update. Once the stake rule is switched on (announced one hour ahead), older apps can
  still finish their existing trades, but sellers cannot list and older buyers are told to update the app.
- A funded seller no longer reads an empty balance while signed Trac data catches up.

## 0.1.47

- Peers keep reading when a Trac network replica is slow (bounded reads, automatic reconnect, stalled-reader recovery). Update recommended for all peer operators.

## 0.1.46

- Completed trade reports now retry less often, with at most three attempts a minute across all trades. After seven
  days they stop retrying and keep their saved records. This reduces peer CPU use and bridge timeouts after trading.
- The venue repeats a trade confirmation when a seller missed it and reports again, with limits on repeat replies.
  This part needs the venue updated; older trader apps also benefit once it is.
- Works together with 0.1.32 and later. No minimum-version change.

## 0.1.45

- RESET and TNK sellers now close trades whose transfer never landed, six hours after the buyer's refund window.
  A fresh transfer check and escrow check must succeed before the trade reservation is released. Unavailable reads
  keep the trade open and retry once a minute. Transfers that did land keep their existing settlement path.
- Older stuck trades recover automatically on startup. Closed trades show the reason in trade history and notices,
  and stop retrying. The original transfer records are kept so a restart cannot send a replacement payment.
- Works together with 0.1.32 and later. No minimum-version change.

## 0.1.44

- When the app is reconnecting, the notice now shows as one line above the chart. Before, it covered the chart and order book with a large red panel.
- Works together with 0.1.32 and later. No minimum-version change.

## 0.1.43

- If the app stops hearing the network it now reconnects by itself instead of showing an empty market.
- While reconnecting, the order book says “Not connected to the DEX network, reconnecting…”.
  Running trades keep their saved progress; reconnecting does not send a second payment or lock.
- Peers recover missing market connections and log which recovery step they take.
- Buy orders show only what the buyer's wallet can pay, including fees, other bids and purchases already in progress.
  A balance is shared across pairs, with higher prices first, then older orders. Orders below the smallest trade are hidden.
  Unavailable balance reads keep the existing behavior.
- When strike checking is enabled, buyers who accept two trades in seven days but never pay have their bids hidden
  and new trades refused for seven days. The seller must have been ready; signer, venue and chain failures exempt the trade.
  Later payment evidence cancels a strike. The same operator command can clear a buyer with `strikes clear --buyer`.
- Updated traders explain buyer pauses in plain words. Existing 0.1.32+ traders can keep trading without an update;
  an older app may show a timeout when a paused buyer is refused. No minimum-version change.

## 0.1.42

- Offers and takes keep working while existing trades or withdrawal status update during a balance read.
  Available funds use the larger reservation from before or after the read, including loan and option funds.
- Missing Trac balance blocks trigger replica recovery before the five-second read deadline. Read timing and
  failures are recorded in the peer's `[trac-read]` logs.
- Seller strikes are disabled by default. When enabled, transfer infrastructure failures exempt the affected
  trade. Settlement still requires verified payment.
- Works with 0.1.34 and later; no minimum-version change.

## 0.1.41

- Balance reads recover on their own when the Trac or RESET connection stalls. Before, a stalled read could keep
  failing with "MSB balance unavailable: read timed out" or "RESET balance unavailable" until the app was restarted.
  The app now re-dials known replicas (at most every 30 seconds per chain), and logs each step as `[trac-read]`.
- Repeated balance polls during a stall no longer pile up open snapshots.
- Works with 0.1.34 and later; no minimum-version change.

## 0.1.40

- RESET trades no longer start when the RESET gateway can't deliver transfers. Before an offer is posted, an offer
  is taken or a take is accepted, the app asks the gateway how many validators it can reach and refuses with
  "RESET transfers are paused…" when it is fewer than three. Nothing is locked or reserved.
- A seller checks again right before sending. If the gateway stays unavailable until the send deadline, the trade is
  called off and the seller's RESET reservation is released at once instead of waiting for the refund time.
- The RESET/USDC pair shows as paused in the app, `status`, the agent API and MCP while transfers are paused.
  TNK/USDC trades are not affected.
- Needs the RESET gateway's validator report (live since 2026-10-27). Works with 0.1.32 and later.

## 0.1.39

- Sellers need a little SOL to claim their USDC on Solana. Before a sell offer is posted, a buy offer is taken or a
  take is accepted, the app now checks the seller's Solana wallet holds enough SOL for the claim (plus the USDC
  account if the wallet never held USDC) and otherwise says exactly how much SOL to add and where.
- A claim that fails is shown on the trade row, in the alerts and in `status`, with the reason and what to do, and
  logged once per reason instead of failing silently. The claim keeps retrying every 15 seconds and succeeds as soon
  as the wallet is funded.
- Works with 0.1.32 and later; no minimum-version change.

## 0.1.38

- Signers find the seller's transfer themselves: if a trade has waited 30 seconds without the seller's "transfer
  sent" message, each signer looks up the seller's newest transactions on the Trac explorer every 15 seconds and
  checks any match on its own peer. The explorer only suggests transaction ids; nothing is trusted from it.
- The seller's app repeats its "transfer sent" message until the signers respond (after 10 s, 20 s, 40 s, at most
  every 2 minutes, only inside the transfer window).
- A seller trade whose USDC lock was refunded ends as lost instead of waiting for shares forever, also for trades
  saved by older versions; a claimed lock ends as complete.
- Works with 0.1.32 and later; no minimum-version change.

## 0.1.37

- Balances no longer hang for 30 seconds when the RESET chain data a balance needs has not arrived yet: each read
  gives up after five seconds with a clear message, and the peer reconnects to the RESET data by itself.
- A failed balance read never shows as zero. The dashboard keeps the last good balances with the time they were
  read and a visible warning, and leaves them out of trade amounts until a fresh read succeeds.
- A pair whose trade list was empty when opened now keeps checking and shows new trades as they happen. Order book,
  chart and trade history show when a refresh fails instead of silently showing old data.
- Busy RESET catch-up no longer holds up the peer: chain entries are applied in short slices and the per-entry
  log lines are summarized every 30 seconds.
- The peer re-opens its connection to the venue by itself if that connection stops answering.
- The "maker not heard" warning names the offer it refers to.
- Works with 0.1.32 and later; no minimum-version change.

## 0.1.36

- When a buyer refunds and the seller never sent tokens, the amount returns to the seller's open offer,
  including after a restart. Recorded or uncertain transfers still count as consumed.
- Wallet commitments, dashboard offer sizes and trade history follow the same rule.
- Restored offers are announced once immediately, then on the normal schedule. Cancelled and expired offers
  stay closed.
- A buyer lock that never landed on Solana no longer holds the buyer's USDC for 48 hours: once the lock
  transaction has provably expired without an escrow, the trade ends and the USDC is free again, including for
  trades already stuck in that state.
- Works with 0.1.32 and later; no minimum-version change.

## 0.1.35

- Trades waiting for a refund no longer repeat old messages, so their proof-of-work no longer slows new trades
  ("Reveal arrived too late", "Accept slot outside the freshness window").
- New trade negotiations are stamped before repeated trade dealings.
- Sellers stop repeating transfer messages once the verification window has closed.
- Reconnect recovery, missing-share requests and automatic refunds are unchanged. Works with 0.1.32 and later;
  no minimum-version change.

## 0.1.34

- Traders prove control of their Trac addresses before new trades are admitted.
- Signers check seller funds and pause sellers who repeatedly leave funded trades unsent. Changing DEX identity
  does not clear a proven wallet's strikes.
- Updated apps explain refused trades immediately. Makers reject takes that cannot cover the trade and fees.
- Offers under still-valid older fee or registry terms remain visible.

Upgrade signers, then the venue and market feeds, then traders. Raise the registry minimum to 0.1.34 last to
activate proofs. Traders must update and repost open offers; committed trades retain settlement and recovery.
See the [rollout instructions](docs/OPERATORS.md#activating-trac-address-proofs-0134). No collateral or trading
deposit is required.
