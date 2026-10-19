# Network profiles

Every role and Pear peer must choose `network: "mainnet"` or `network: "local"`.
They resolve the JSON source profile in `networks/`. Mainnet refuses any config
field that changes a pin, including the old `mint` / `platformCollector` fields,
`solana` aliases, and peer settings. Refusal happens before keys or connections.

The checked-in mainnet profile is complete: it pins USDC, the escrow program and
platform collector, MSB network 918 and its 32-character discovery channel,
RESET's subnet and discovery endpoints, and the vendored RESET release. Local
keeps `REQUIRED:` only for values supplied by the local stack; the fully resolved
profile must contain none. No private key, wallet or seed is a profile field.

The shared fields are:

- `mint`, `programId`, `platformCollector`: Solana addresses.
- `chatRelays`: at most 128 distinct lowercase 64-hex DEX signing public keys for viewer chat relays.
  Mainnet pins the array (initially empty); local configurations may override it. Put the same list in the
  resolved role and peer profiles. Every receiver grants these keys one message per second and 600 per rolling
  hour, rejects duplicate `(name,text)` pairs for 600 seconds, and marks accepted lines `viewer: true`.
  A market feed can serve reads with an empty list; viewer posting requires its identity in this list.
- `peer.environment`, `peer.msbNetworkId`, `peer.msbBootstrap`, `peer.msbChannel`.
- `peer.msbDhtBootstrap`, `peer.peerDhtBootstrap`.
- `peer.trac.reset.bootstrap`, `channel`, `dhtBootstrap`, and
  `source: {commit, manifestSha256}`. `peer/vendor/reset/SOURCE.json` records the
  public repository, full commit and SHA256 of each of the ten vendored files.
  Its canonical bytes are recursively key-sorted compact JSON plus a newline.
  The peer verifies the manifest hash/commit and every file before importing the
  protocol or contract. Relative imports stay within the vendored tree; bare
  imports resolve through `peer/node_modules` (the RESET-compatible trac-peer
  commit `2e6f458cb1baa075bc52230c6eb9a3a349d91421`).
- Only local tests may override `peer.trac.reset.source.directory` with an
  absolute vendored fixture directory (and its commit/manifest hash).
- Local alone allows `peer.trac.reset.beaconOptions` for the existing test chain.

Put the same resolved fields in a role config and its peer config. For local,
`peer: {...}` overrides the peer part of the source profile. Operational fields
(`dataDir`, `storeDirectory`, bridge/control ports and token-file paths, wallets,
proof paths, RPC endpoints, RESET gateway URL, relays) stay outside this object.
Each peer has its own subnet with `bootstrap: null`. Its top-level operational
`subnetChannel` may be set explicitly; otherwise the peer generates
`dex-<24 random hex>` once and saves it exclusively to `storeDirectory/dex-channel` for
reuse. It is not a network pin and never appears under `peer` in the profile.
A local peer may also set its test `validatorKey`. Mainnet refuses that override.
The role compares the peer's resolved profile returned by bridge `info` before
using it. RESET contract identity is the pinned subnet bootstrap and the pinned
public protocol/contract sources; the gateway cannot supply another identity.

Traders construct mint/platform collector from this profile. Signers and the
service reject summoned/settled terms with another mint or platform collector.
The Solana adapter and service escrow derivation use the profile's program ID.
Only local config can change these values. The registry cannot name a quote mint.

`src/net/profile.js` exports:

```js
resolveNetwork(config) -> {network, mint, programId, platformCollector, chatRelays, peer}
checkProfileTerms(terms, profile) -> void
checkPeerProfile(info, profile) -> void
checkContractFiles(profile) -> void
```

Every verification function throws on a mismatch. `checkContractFiles` returns the verified
vendored protocol/contract paths. There is no automatic profile discovery or
network download. RESET is vendored from public commit
`b9747f1517bdb7508c329ef6e80aebfe47e092e8` without changing any source bytes.

## Operational transport configuration

Every peer config now supplies `role` (`service`, `signer`, `trader`, or `market-feed`) and
`servicePeerKey`, the service's **peer wallet/swarm public key**. Every role config
pins the same `servicePeerKey` next to its existing `serviceKey` (the distinct DEX
signing identity). The role checks its peer's advertised role and owner key before
opening its keyring. The service additionally checks that its peer owns that key.
The `intercom-dex` sidechannel accepts and relays only owner-signed content.

`serveRelay` defaults to true for service/signer peers and false for traders and market feeds;
these roles cannot enable it. Optional static `relayKeys` live at the top level of the
peer config. Registry `relayKey` and `serviceRelayKey` fields update the dynamic
list through the authenticated local bridge. Neither relay keys nor
`servicePeerKey` belongs in `peer` network pins or `networks/*.json`.

A completely isolated new peer needs a static fallback or an already trusted
cached registry to discover its first relay. A registry cannot arrive over a path
that has not yet been established. The forced-isolation tests seed a cached,
verified public registry before starting the isolated trader role.

PoW is fixed at 20 bits for all dex offers/signers/trade channels. It is enforced
before relay, including on open channels. The sidechannel connection allowance is
64,000 bytes/s with a 256,000-byte burst. Main service publications bypass the
nonce queue; their owner signature provides admission control.

Network validation:

```sh
node --test tests/integration/net/blind-relay.test.mjs
DEX_PROOF_ZKEY=/absolute/lockkey.zkey node tests/e2e/stack.mjs relay
DEX_PROOF_ZKEY=/absolute/lockkey.zkey node tests/e2e/stack.mjs relay-none
```

Run each stack option with fresh peers. The positive option rejects all direct
connections to Bob and uses a signer's registry relay. It asserts completion,
exact balances, zero direct connections and ciphertext-only raw forwarding. The
negative option has the same isolation and no registry/static relays; an attempted
take fails before lock, with no trade state or balance changes. The integration
uses real transport with stubbed chain/proof adapters; the stack uses real local
chains and the proof worker. Test hooks are separate entrypoints, never loaded by
the production peer entrypoint.
