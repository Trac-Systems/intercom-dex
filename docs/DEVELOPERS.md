# intercom-dex developer notes

The protocol is in [SPEC.md](SPEC.md). Operating the roles is in [OPERATORS.md](OPERATORS.md), and the network
profiles are in [NETWORKS.md](NETWORKS.md).

Use Node.js 23.11.0:

```sh
source ~/.nvm/nvm.sh
nvm use 23.11.0
npm ci
npm ci --prefix peer
```

## Source layout

There is one program. `bin/dex.mjs --config <file>` runs the role named in the config (`service`, `signer` or
`trader`), its subcommands (`setup`, `balances`, `withdraw`, `export`, `restore`, `keys check`, `fee set`,
`fee platform`, `fee withdraw-platform`) and the local control API. The peer under `peer/` is a separate process on
the Pear runtime.

| Path | Contents |
| --- | --- |
| `src/core/` | The protocol without I/O: canonical JSON, keys, envelopes, schemas, Feldman VSS on Baby Jubjub, share sealing, dealing, committee selection, terms, registry, and the buyer, seller and signer state machines. Its contract is in [`src/core/API.md`](../src/core/API.md). |
| `src/proof/` | Lock certificate proving and verification in a worker thread, and the pinned circuit file hashes. |
| `src/roles/` | The trade host (routing, buffering, persistence, adapter calls), the trader, signer and venue roles, the encrypted record store, the keyring and the certificate pool. |
| `src/solana/` | Escrow instructions, RPC quorum reads, escrow checks and the Solana adapter ([`README`](../src/solana/README.md)). |
| `src/trac/` | Trac wallet, transfer builders, the transfer journal and the Trac adapter ([`README`](../src/trac/README.md), [`ADAPTER`](../src/trac/ADAPTER.md)). |
| `src/market/` | Asset kinds and amounts, the order book, the book feed and tickers. |
| `src/net/` | The bridge client, network profiles and registry relays. |
| `src/wallets/`, `src/fees/` | Wallet setup, balance accounting, withdrawals, venue backup, fee changes, the key audit and the platform fee withdrawal. |
| `src/dashboard/` | The local dashboard. |
| `src/mcp/` | The trader's MCP server. |
| `peer/` | The peer: MSB client, private subnet, dex sidechannels with proof-of-work, the blind relay, the bridge, the Trac transfer verifier and the vendored RESET contract (`peer/vendor/reset`). |
| `circuits/` | The lock certificate circuit and its compiled files. |
| `networks/` | The `mainnet` and `local` network profiles. |
| `vendor/` | The deployed escrow program binary, for the local validator. |

## Building the proving key

Traders need the PLONK proving key. It is built from the public Hermez Powers of Tau file and the circuit:

```sh
node bin/proof-setup.mjs --out /absolute/lockkey.zkey
node bin/proof-setup.mjs --out /absolute/lockkey.zkey --ptau /absolute/powersOfTau28_hez_final_18.ptau
```

Without `--ptau` the script downloads the file into the output folder and checks its blake2b-512 before it uses
it. It checks the circuit files and the resulting key against the hashes in `src/proof/files.js`, and it refuses to
overwrite an existing output.

## Running the tests

The fast suite needs no network and no chain. Run it from a Git checkout; it stubs proofs and chain adapters:

```sh
node --test 'tests/unit/**/*.test.mjs' tests/docs/
```

`tests/docs/` checks that the documents match the code: tool names and arguments, commands and flags, config keys,
the numbers stated for fees, deadlines, step budgets and timeouts, wording, relative links, and the files included
in a release. The publication check lists tracked files and new files that Git does not ignore.

The proof suite makes real certificates (at most two) and needs the proving key:

```sh
DEX_PROOF_ZKEY=/absolute/lockkey.zkey node --test tests/proof/
```

Integration tests use real local components:

```sh
node --test tests/integration/net/blind-relay.test.mjs
node --test tests/integration/solana/
node --test tests/integration/trac/
```

The Solana tests start `solana-test-validator` (it must be on the `PATH`) with the deployed escrow binary from
`vendor/` at the program's address, bound to 127.0.0.1 on ports 18899, 19900, 18001 and 18010 to 18060.
`DEX_SOLANA_TEST_DIR` chooses where its ledgers go. The Trac tests and the local stack below use the RESET devnet
modules and contract from a checkout of the [RESET repository](https://github.com/Trac-Systems/reset).
Set its absolute path before running either suite:

```sh
export RESET_SOURCE_DIR=/absolute/reset
```

The checkout must contain `scripts/lib/devnet-network.mjs`, `tests/helpers/chain.mjs`,
`contract/protocol.js` and `contract/contract.js`, with its dependencies installed. A missing setting,
relative path or missing source file stops the command with an error naming `RESET_SOURCE_DIR`.
The fast unit/docs suite does not need this setting or a RESET checkout.

`DEX_LEGACY_PEAR_RUN=1` lets the peer runner use `pear run` when it detects Pear below version 3.
The default runner uses the installed `pear-runtime` module.

## The local stack

`tests/e2e/stack.mjs` runs everything on one machine: a RESET devnet (local DHT, MSB with local TNK, the RESET
contract), a local Solana validator with the escrow program and a local USDC-like mint, one venue, five signers and
the traders, each as a peer plus its role process.

```sh
DEX_PROOF_ZKEY=/absolute/lockkey.zkey node tests/e2e/stack.mjs
DEX_PROOF_ZKEY=/absolute/lockkey.zkey node tests/e2e/stack.mjs reset-sell refund
DEX_PROOF_ZKEY=/absolute/lockkey.zkey node tests/e2e/stack.mjs relay
DEX_PROOF_ZKEY=/absolute/lockkey.zkey node tests/e2e/stack.mjs relay-none
DEX_PROOF_ZKEY=/absolute/lockkey.zkey node tests/e2e/stack.mjs fee-change
```

Without arguments it runs `wallets`, `reset-sell`, `tnk-buy`, `cheating-dealer`, `cheating-certificate`,
`signers-offline`, `not-enough-signers`, `signers-vanish-before-ack`, `crowd`, `silent-taker` and `refund`. Run
`relay` and `relay-none` on their own, each with fresh peers. The stack prints its run folder at start; the logs of
every process are in its `logs` folder. `DEX_DEBUG=1` adds message and adapter logs. It stops every process it
started on exit.

## The local network profile

Every role and peer config names `network`. `networks/local.json` marks the values a local stack supplies as
`REQUIRED:`, and a resolved profile must contain none. Local configs fill them with the top-level `mint` and
`platformCollector` and a `peer` object (`environment`, `msbNetworkId`, `msbBootstrap`, `msbChannel`,
`msbDhtBootstrap`, `peerDhtBootstrap`, and `trac.reset` with `bootstrap`, `channel`, `dhtBootstrap` and
`beaconOptions`). A local peer may also set `validatorKey`, and local tests alone may point
`peer.trac.reset.source.directory` at a vendored fixture. Mainnet refuses every one of these overrides. The stack
writes such configs for each process; see `tests/e2e/stack.mjs` for a complete example.
