# RESET gateway health

RESET/USDC pauses unless the configured `trac.resetGatewayUrl` reports an integer
`validators.eligible >= 3` from `GET /v1/state`. Missing, null, invalid, stale,
timed-out and failed reads all pause it. TNK/USDC keeps its existing checks.

The exact refusal and pause text is:

> RESET transfers are paused: the RESET gateway can't reach enough validators right now. Try again in a few minutes.

One reader in `src/trac/gateway-health.js` is shared by each process's Trac
adapter. It enforces the existing gateway origin rules and 30-second timeout,
refuses redirects, shares in-flight reads, and caches results for less than
15 seconds. `checkedAt` is Unix milliseconds. Diagnostic `reason` explains the
particular failed reading; `ok` is never inferred from connected or v1Ready.

Trader admission checks the gateway after funds checks and before saving a new
offer or trade. Both buy and sell offers need RESET delivery, so posting,
reposting, taking and maker acceptance all check it. Makers decline with
`reset-gateway`; updated takers translate that code to the exact text above.
The regular announcement of an existing signed offer continues to keep that
offer listed. It does not post a new offer or create a new reservation. A repost
that creates a new offer goes through `makeOffer` and the health check.

The seller's adapter forces another read before preparing a new RESET transfer.
Slow preparation triggers another read if the result has expired, and the send
deadline is checked before signing. Refused transfers have no signature, intent
or submission. The seller retries after ten seconds. A saved `gatewayPaused`
flag means the preceding attempt definitely left no intent; it is cleared and
saved before another attempt starts. At `sendBy`, a seller still in that state
uses `Transfer not sent before the deadline: ` followed by the pause text and
releases its trade reservation through the existing abort path. Restarting after
the deadline uses the same abort path. Signed intents continue their existing
reconciliation; they must not be treated as unsent during an outage.

The venue computes the public pause using its configured gateway and publishes
it at startup and every ten seconds through the existing signed `status`
message. An outage uses `status: degraded` and the pause text; health uses
`RESET transfers are available.`. No new status wire fields, registry versions
or book removals are needed. Market-feed accepts only the authenticated venue
message, derives `status`, `paused` and `reason` on pairs and `paused` and `reason`
on offers, and fails closed when that message is missing or 15 seconds old.
Offers and depth remain visible during this temporary pause.

Each trader also samples its own configured gateway every ten seconds, sharing
the admission reader. Its local `/status`, dashboard, and MCP therefore reflect
the gateway that trader actually uses. Pair `status`/`availability` become
`paused` with the reason, and listed offers get `paused`/`reason`. The dashboard
uses its existing pause note, pair status, offer badge and alerts; depth stays
visible but has no take target. MCP `dex_book` also returns the pair entry.

For release, restart the venue, market-feed and trader processes with the new
code; restart connected MCP servers and reload dashboards. The gateway must
first serve the GW1 validator field. There is no config or journal migration.
The existing signed status format lets older apps receive the plain warning
in `serviceStatus.message`; their dashboard cannot acquire the new pair badge
or local admission/send checks without updating. An old taker may time out
instead of understanding the new decline code, but an updated maker admits
no trade during the outage. Changing registry pair status would hide existing
offers in old apps, so temporary gateway health does not change that registry.

Health is a recent observation, not a delivery guarantee. Validators can
disconnect after a successful check. A buyer whose USDC was already locked
still follows the existing refund deadline if the seller never sends. This
change does not unlock an existing escrow early or repair old incident trades.
