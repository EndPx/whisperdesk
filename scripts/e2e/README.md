# WhisperDesk Step 5 E2E runners

Two Node scripts that exercise a deployed `DvPEscrow` integration instance
(`contracts/script/DeployIntegration.s.sol`) end-to-end against **live** Coston2 + XRPL Testnet +
the real FDC verifier/DA layer. Neither script was executed by the agent that wrote them — this
is the instructor's live-network trigger.

## 1. Deploy the integration instance

```bash
cd contracts
forge script script/DeployIntegration.s.sol --rpc-url coston2 --broadcast --slow
```

Copy the printed `DvPEscrow` address — that's `ESCROW_ADDRESS` below.

## 2. Install

```bash
cd scripts/e2e
npm install
```

## 3. Configure `.env` (repo root)

```
PRIVATE_KEY=0x...          # same key used to deploy — escrow owner AND teeSigner; pays gas + FTSOv2/FDC fees
TAKER_PRIVATE_KEY=0x...    # fresh EVM key, funded with a little C2FLR for gas
MAKER_PRIVATE_KEY=0x...    # fresh EVM key, funded with a little C2FLR for gas
XRPL_MAKER_SEED=s...       # XRPL Testnet account seed, funded via https://faucet.altnet.rippletest.net (happy-path.mjs only)
XRPL_TAKER_ADDRESS=r...    # any XRPL Testnet r-address (does not need a seed — only receives)
```

Optional overrides: `ESCROW_ADDRESS`, `COSTON2_RPC`, `XRPL_TESTNET_WSS`.

If running from a directory other than the repo root, point at the repo-root `.env` explicitly:

```bash
DOTENV_CONFIG_PATH=/absolute/path/to/repo/.env node happy-path.mjs ...
```

## 4. Run

```bash
# Full happy path: lock() -> real XRPL payment -> fresh FDC proof -> release()
ESCROW_ADDRESS=0x... node happy-path.mjs

# Default path: lock() -> no payment -> wait past refundAfter+REFUND_GRACE -> refund()
ESCROW_ADDRESS=0x... node default-path.mjs
```

`node happy-path.mjs --help` / `node default-path.mjs --help` print usage without needing any env
configured or network access.

## What each script proves

- **happy-path.mjs** — the full DvP settlement loop for real: a `MatchInstruction` signed with the
  exact `WD_MATCH_V1` scheme (`lib/matchInstruction.mjs`, cross-checked against the Step 4 golden
  vectors), a real XRPL payment for the exact `xrpDrops`/`destinationTag` `lock()` assigned, a
  freshly-requested FDC `XRPPayment` attestation with `requestBody.proofOwner` bound to **this**
  escrow instance (the one required change from `scripts/fdc-spike/attest.mjs`, whose spike-only
  proof is bound to the Step 2 verifier contract and can never fund a real `release()` — see
  `contracts/test/ForkFdcRelease.t.sol`'s header comment), and a `release()` call that must move
  FXRP to the maker.
- **default-path.mjs** — the auto-refund path: a second, unrelated match is locked and
  deliberately never paid. It waits out `refundAfter + REFUND_GRACE` (the Step 5 race-window fix,
  `docs/design.md` §14) and calls the permissionless `refund()`, asserting the taker recovers
  principal plus the maker's slashed 1% bond.

## Layout

```
config.mjs              env/CLI parsing, shared Coston2/FDC constants (re-exported from
                         ../fdc-spike/config.mjs)
lib/abi.mjs              hand-written ethers ABI fragments for DvPEscrow/MockFXRP/BondLedger/FtsoV2
lib/matchInstruction.mjs JS mirror of MatchInstructionLib.sol / extension/matcher/instruction.go
lib/flow.mjs             shared setup + fund + lock() flow used by both runners
lib/xrplPay.mjs          real XRPL payment helper (adapted from ../fdc-spike/pay.mjs)
lib/fdc.mjs              FDC prepareRequest -> requestAttestation -> poll-DA-layer helper
                         (adapted from ../fdc-spike/attest.mjs + verify.mjs, parameterized proofOwner)
happy-path.mjs           runner 1
default-path.mjs         runner 2
```
