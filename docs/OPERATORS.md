# Running a signer, the venue or a relay

Every role runs as two processes on one machine: the peer (`peer/scripts/pear-runner.mjs`), which connects to the
network, and the role program (`bin/dex.mjs`), which holds the keys and does the work. Each has its own JSON config.
The protocol is in [SPEC.md](SPEC.md); the network profile fields are in [NETWORKS.md](NETWORKS.md).

Desktop traders use `node bin/dex.mjs start --config /path/to/dex-data/trader.json` to run both processes in the
background. Servers keep systemd (or their existing service supervisor) and the separate foreground commands below.
Do not wrap systemd roles in the desktop launcher. Keep the role's shutdown ordered before its peer's shutdown.

## Installing and upgrading

Install from a tagged release, never from `main`. Download `intercom-dex-vX.Y.Z.tar.gz` from the
[releases page](https://github.com/Trac-Systems/intercom-dex/releases), compare its sha256 with the release page,
unpack it into a new folder, and run `npm ci` and `npm ci --prefix peer` there. `npm ci --prefix peer` also applies the peer's
patches to its installed dependencies (`peer/scripts/apply-patches.mjs`); after an install with `--ignore-scripts`,
run `node peer/scripts/apply-patches.mjs` yourself. Keep configs and data folders
outside the release folder, so that an upgrade only replaces the program.

To upgrade, install the new release the same way next to the old one. Stop the role program, then its peer, start
the new peer and then the new role with the same config files. Each role resumes its saved work at start. A program
below the registry's `minSoftware` keeps running its existing trades but refuses new ones and reports
`update required`.

The venue announces a release by setting `latest` in its config (`version`, `commit` and the archive's `sha256`).
It goes out in the venue's signed `status` message, and traders see it as `serviceStatus.latest`. This is an
announcement only: nothing downloads or installs by itself. When a release must be installed, the venue raises
`minSoftware` in the registry.

## Ports and processes

All local ports bind to 127.0.0.1. Each process on one machine needs its own:

| Setting | Used by | Purpose |
| --- | --- | --- |
| peer `bridge.port` | peer | WebSocket bridge the role connects to, authenticated with `bridge.tokenFile` |
| role `bridge.url` | role | the peer's bridge, `ws://127.0.0.1:<port>` |
| role `control.port` | role | local control API (`/status`, wallets, fee commands), authenticated with `control.tokenFile` |
| role `dashboard.port` | role | local dashboard |

The peer reaches other peers through Hyperswarm and the DHT bootstrap nodes pinned in the network profile.

Public channels (offers, the book, signer heartbeats) travel through the venue. Traders and market feeds connect to
the venue for them and forward nothing; the venue sends each public message once to every connected peer, with a
per-peer send budget. Trade channels still connect maker and taker directly, or through a relay. Peers from 0.1.5 on
keep working with this.

To see what a peer's traffic is made of, send `{ "id": 1, "type": "bandwidth.stats" }` on its authenticated bridge.
The reply lists cumulative bytes and events per layer (`protocol`, `blocks`, `streams`, `udp`), subsystem and
direction (`received`, `sent`, `originated`, `relayed`). Take two replies a minute apart and subtract them for a rate.

Create the bridge token before the first start; the role creates its control token itself:

```sh
(umask 077 && openssl rand -hex 32 > /path/to/signer-data/bridge.token)
```

Start the peer first and the role second, each in its own terminal or under a process supervisor:

```sh
node peer/scripts/pear-runner.mjs --config /path/to/signer-data/peer.json
DEX_KEY_PASSWORD='your-password' node bin/dex.mjs --config /path/to/signer-data/signer.json
```

The peer prints `DEX_PEER_READY` with its `peerPubkey` when it is connected. The role prints
`DEX_ROLE_READY` with its `dexKey` (and `boxKey` for signers) when it runs. The role exits with code 75 when its
peer goes away, so a supervisor can restart it; its state is on disk.

## Logs

The role writes one line per event to standard output, starting with an ISO time and the role name: registry
versions, trades changing phase, aborts and retries. Set `DEX_DEBUG=1` to add every message received or refused
and every chain call. Desktop traders started through the background launcher, including MCP auto-starts, write
`peer.log` and `trader.log` in the trader data folder, rotating at 5 MiB with three older copies each. Server logs
remain with systemd or the existing supervisor.

## The dashboard

Add `"dashboard": {"port": <port>}` to a role config. The role prints the private link at start
(`Dashboard (private link, do not share)`) and writes its token to `dataDir/dashboard.token`; a new token is made at
every start. A signer's dashboard shows the trades it holds, when each piece is released and its credits. The
venue's dashboard shows the registry, signers, trades, fees and the credits owed, and lets the operator record a
signer payment and withdraw USDC. Every action shows what it will do and asks for confirmation.

## Running a signer

A signer holds one sealed share per trade it serves, checks the seller's transfer on its own node and then
publishes its share. Its peer runs its own MSB client and RESET reader for that check.

Peer config (`peer.json`):

```json
{
  "network": "mainnet",
  "role": "signer",
  "servicePeerKey": "<venue peer key from the release page>",
  "storeDirectory": "/path/to/signer-data/peer",
  "bridge": { "port": 47300, "tokenFile": "/path/to/signer-data/bridge.token" }
}
```

Role config (`signer.json`):

```json
{
  "network": "mainnet",
  "role": "signer",
  "dataDir": "/path/to/signer-data/signer",
  "serviceKey": "<venue key from the release page>",
  "servicePeerKey": "<venue peer key from the release page>",
  "bridge": { "url": "ws://127.0.0.1:47300", "tokenFile": "/path/to/signer-data/bridge.token" },
  "control": { "port": 47301, "tokenFile": "/path/to/signer-data/control.token" },
  "dashboard": { "port": 47302 }
}
```

### Keys

The first start creates `dataDir/keyring.json` with the signer's dex identity, its box key and its store key,
encrypted with the password from `DEX_KEY_PASSWORD` (or the variable named by `keyPasswordEnv`), at least 12
characters long. A signer has no Solana or Trac wallet. Never copy a signer's data folder to a second running
machine; one identity runs in one place.

### Joining the registry

The venue signs the list of signers, so joining means sending the venue operator these values:

- `dexKey` and `boxKey` from the `DEX_ROLE_READY` line;
- `relayKey`: the peer's `peerPubkey` from `DEX_PEER_READY`, if the peer should serve as a relay;
- `assets`: the base assets it verifies, `TNK`, `RESET` or both;
- `limitUsdc`: the largest trade it accepts, in USDC base units;
- `label`: a short public name;
- `software`: the version it runs.

The venue adds the entry with `status: "active"` and publishes a new registry version. From then on the signer can
be drawn into committees for trades in its assets up to its limit. It refuses summons for other registries, for
trades above its limit, and while its own version is below `minSoftware`.

### What to keep online, and for how long

Keep the peer and the role running all the time. Heartbeats go out every 30 seconds, and traders count a signer
online only when its last heartbeat is at most 90 seconds old. A trade starts only when enough of its drawn
signers are online.

While waiting for a trade's deal, a signer repeats its presence every 30 seconds. It stops those repeats when the
deal arrives or at `sendBy`.

Once a signer has acknowledged a trade, it promised to hold its share until that trade's `refundAfter`, which is 48
hours after the take with the venue's registry. It has to be online when the seller's transfer becomes final (within
`sendBy + graceSec`) to check it, and it keeps re-sending its share until `refundAfter`. A signer that is offline in
that window can cost the seller the payment if enough others are offline too, and the venue's records show which
signers published. Restarting is safe: the signer resumes every trade from its data folder and publishes again.

The venue's local `/status` output includes `alerts`. A known trade appears there when the venue has verified the
seller's transfer as final for ten minutes but still has fewer than the required number of valid shares, before
`refundAfter`. The log says `ALERT shares missing <tradeId> have/needed` once, then every two hours while it lasts,
including across restarts. Check that the named trade's committee is online and retains its data. An alert clears
when enough valid shares arrive or the refund time passes; it does not change the trade or authorize a payment.

### What a signer earns

For every logged trade, the venue owes a part of its trade fee to the signers whose published share it received by
the trade's `refundAfter` and belongs to the dealing that opened the escrow. With the configuration below,
that is 50 % of the 0.5 % trade fee, split equally among those signers. Credits are final 7 days after the trade
was logged, and the venue operator pays them outside the protocol and records the payment. A removed signer
forfeits every credit not yet paid.

### Storage and backups

`dataDir` holds the keyring and the encrypted records: shares, used transactions and the trade states. The peer's
`storeDirectory` holds its network identity and the MSB and RESET data. Back up `dataDir` while the role is
stopped, and keep the password separately. Without the data folder, a restored signer can't publish the shares of
trades that were running.

## Running the venue

The venue publishes the registry, the order book, tickers and the trade log, checks every reported trade on both
chains and collects the trade fee. Its dex key is the `serviceKey` and its peer key is the `servicePeerKey` that
every trader and signer pins, so publish both with each release.

The venue's own peer config uses `"role": "service"` and its own peer key as `servicePeerKey`. Start the peer once
with any 64-hex placeholder in `servicePeerKey`, read `peerPubkey` from `DEX_PEER_READY`, stop it, and put that key
into both venue configs. The key is kept in `storeDirectory` and stays the same afterwards.

Role config (`service.json`):

```json
{
  "network": "mainnet",
  "role": "service",
  "dataDir": "/path/to/venue-data/service",
  "serviceKey": "<this venue's dex key>",
  "servicePeerKey": "<this venue's peer key>",
  "bridge": { "url": "ws://127.0.0.1:47400", "tokenFile": "/path/to/venue-data/bridge.token" },
  "control": { "port": 47401, "tokenFile": "/path/to/venue-data/control.token" },
  "dashboard": { "port": 47402 },
  "solana": {
    "endpoints": ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com", "https://public.rpc.solanavibestation.com"],
    "sendEndpoint": "https://api.mainnet-beta.solana.com"
  },
  "payout": { "solana": "<operator's Solana address>" },
  "latest": { "version": "0.1.0", "commit": "<40 hex release commit>", "sha256": "<64 hex archive hash>" },
  "registry": {
    "minSoftware": "0.1.0",
    "pairs": [
      { "pair": "TNK/USDC", "base": { "kind": "trac-native", "id": "TNK", "decimals": 18 }, "minBaseAmount": "10000000000000000", "status": "open" },
      { "pair": "RESET/USDC", "base": { "kind": "trac-contract-token", "id": "RESET", "decimals": 8 }, "minBaseAmount": "10000", "status": "open" }
    ],
    "params": { "n": 5, "k": 3, "sendWindowSec": 900, "refundSec": 172800, "graceSec": 300 },
    "fee": { "platformFeeBps": 10, "tradeFeeBps": 50, "collector": "<venue main Solana address>", "signerShareBps": 5000 },
    "signers": [
      { "dexKey": "<signer dex key>", "boxKey": "<signer box key>", "label": "<public name>", "limitUsdc": "1000000000",
        "status": "active", "assets": ["TNK", "RESET"], "software": "0.1.0", "relayKey": "<signer peer key>" }
    ],
    "removed": []
  }
}
```

### Before the first start

- The first start creates the keyring with the venue's dex identity, box key, store key and main Solana key. Run
  `node bin/dex.mjs setup --config /path/to/venue-data/service.json` first to see the Solana address without
  starting the venue, or import a key with `--import-solana`.
- `registry.fee.collector` must be that main Solana address, and it must already have a finalized trade-fee config
  in the escrow program at `tradeFeeBps`. The venue checks this at start and refuses to run otherwise. Creating
  that first config is not part of this program.
- `registry.fee.platformFeeBps` must equal the escrow program's finalized platform config. The venue checks it
  before every registry it publishes.
- The main Solana wallet pays Solana fees and the rent for fee collector configs, so keep SOL on it.
- `payout.solana` must be a wallet address, not a token account. The venue checks it at start.
- Start a brand-new venue the first time with `--first-launch`:
  `node bin/dex.mjs --config /path/to/venue-data/service.json --first-launch`. It then signs registry version 1.
  Without the flag the venue refuses to start when its data folder has no stored registry. Every later start, and
  every start after a restore, runs without it.

### Publishing the registry

The venue builds the registry from `config.registry` and publishes it every 30 seconds. It creates a new version
only when the content changed, and keeps every version. To add, pause or remove a pair, add or change a signer, or
raise `minSoftware`, edit `registry` and restart the venue. To remove a signer, delete its entry from `signers` and
add `{"dexKey": "...", "removedAt": <unix seconds>, "reason": "..."}` to `removed`. Running trades keep the
registry version they started with. Never sign two different registries under one version: every role that sees
both stops trading, and it stays stopped until each of them clears its data. A new version is always numbered above
every version stored in the data folder. A venue that lost its data folder must get its registry history back (from
the export or the old `records/` folder) instead of starting again with `--first-launch`, which would sign a second
version 1.

Fee changes after the start go through the running venue (`node bin/dex.mjs fee set` and
`node bin/dex.mjs fee platform`), and they override the fee in the config file from then on. They are described in
[FEES.md](FEES.md).

### Settlements, credits and payouts

Sellers report finished trades; the venue logs each one only after it verified the escrow, the Trac transfer and
the claim on its own reads, then publishes it in the trade log. Signer credits come from those records. Pay the
signers from the venue's funds and record each payment in the venue dashboard; the venue doesn't pay them itself.
`node bin/dex.mjs balances --config /path/to/venue-data/service.json` shows the collected fees;
`node bin/dex.mjs withdraw --config /path/to/venue-data/service.json --asset USDC --amount all` sends them to
`payout.solana`.

### Backups and key checks

Back up the whole data folder while the venue is stopped, and keep the password separately. The data folder holds
the registry history, settlements, credits and the signed transaction journals, and the venue can't rebuild them
from keys alone. Losing the dex identity breaks every trader's pin. The plain export carries the venue's keys and
its registry history, fee policy and book sequence; restoring it lets the venue start again under its next version.
Credits, settlements and journals are only in the data folder. The export, the restore and the key audit are
described in [WALLETS.md](WALLETS.md#venue-backup-and-recovery):

```sh
node bin/dex.mjs export --config /path/to/venue-data/service.json --out /path/to/new-venue-export
node bin/dex.mjs restore --config /path/to/new-service.json --from /path/to/new-venue-export
node bin/dex.mjs keys check --config /path/to/venue-data/service.json
```

The platform fee withdrawal for the holder of the escrow program's platform authority is
`node bin/dex.mjs fee withdraw-platform`, also described in [WALLETS.md](WALLETS.md#platform-fee-withdrawal).

## Running a relay

Some peers can't reach each other directly. A blind relay forwards their encrypted traffic without being able to
read it. Every venue and signer peer serves as a relay unless its peer config sets `"serveRelay": false`; trader
peers never do. Peers use a relay when its key is listed in the registry, as a signer's `relayKey` or as the venue's
`serviceRelayKey`, or in their own peer config:

```json
{ "relayKeys": ["<relay peer key>"] }
```

Registry relay keys replace the list with every new registry version, and static `relayKeys` are added to it. A new
peer that can't connect to anyone needs a static relay key, because it can't receive the registry before it has a
path.
## Running lock signers and a locks venue

Lock signers run as separate processes with separate locks identities, box keys, data folders and peer
connections. Do not reuse a spot DEX signer's process or signing identity. A locks venue likewise publishes
its own signed registry under a key that locks clients pin. It stores position status and opaque sealed releases
for offline parties; it never decides which party receives a lock.

Before accepting positions, check the registry's strict majority `k > n/2`, active committee, supported software,
per-position sizes, aggregate `totalLocked` limits and reserve settings. A signer holds at most 2000 open
positions and at most 50 for one maker key, or less if its registry lowers those limits. Limits and the exact
protocol are in [LOCKS.md](LOCKS.md#registry-and-limits).

Run each signer's own RESET reader and use its counted Bitcoin height and recorded hashes. Verify Bitcoin
header bytes against those hashes before using the header time. Give each signer reliable Solana RPC
endpoints. An operator's own paid endpoint is trusted on its own (`solana.need: 1`), as for DEX roles; with only
public endpoints, payment checks require two agreeing reads. Do not rely on the public shared servers' capacity for a busy signer. An RPC outage
must leave a payment undecided, never be treated as proof that no payment exists.

Back up the complete encrypted data directory and keep its password or store key separately. The backup must
include DKG state, final shares, registry snapshots, reservations, verified payments and durable decisions.
Store a share durably before `lockReady`, and a decision durably before release. Restore exactly that decision
after a crash; never reset a decided position to undecided or run two copies of one signer's identity. A backup
from before a release may lack its decision, so restore the latest journal and reconcile before serving.

Keep shares until the position is collected. Test that backups can be decrypted without exposing them in logs.
RESET/TNK locks have no trustless recovery if enough signer shares are lost. A put writer can refund unclaimed
USDC through the escrow after `refundAfter`; a holder should collect before that refund can race its claim.
An unavailable signer may return after a deadline and check the chain history to reach the same decision.

Only registry and heartbeat broadcasts run every 30 seconds. Do not create retry timers over all positions or
join all position channels at startup. Answer active requests, page books in at most 100 rows, and limit release
answers to once per 60 seconds per requester and position. Keep the DEX registry and its traffic separate.

Traders enable locks on their existing peer with `locks: true` and pin `locks.venueKey` in the trader config.
The client uses separate encrypted locks keys, registry snapshots and transaction journals. Without this
configuration the trader starts only the existing spot services. Signer peers remain dedicated to locks.
Advertise `assets.RESET` and `assets.TNK`, per-asset bounds, `loanBps`, `optionBps`, `optionMin`, and
`signerShareBps`. The put `escrowCollector` configuration must charge zero trade bps.

A put needs two locks: writer USDC in E, holder RESET/TNK plus reserve in H before premium payment. The writer
publishes a random escrow preimage; recipient authorization still requires the E scalar signature. A signed
Solana memo exercises the put. Validate median time past from 11 verified headers for release usually 1–2 hours
after payment; do not use Trac transfer timing in deadline decisions.

DKG uses a common qualified set Q with at least n−1 dealers and at least n−1 matching readiness attestations.
Store sealed shares for offline members at the venue. Signers can be replaced by handover while at least k
survive. Put writers retain the program refund after `refundAfter`; RESET/TNK have no trustless fallback.
