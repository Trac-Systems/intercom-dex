# Changelog

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
