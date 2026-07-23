# WhisperDesk

Private OTC desk for institutional XRP↔FXRP block trades. Sealed RFQs are matched inside a Flare
Confidential Compute (FCE) enclave — side, size, and counterparty never leave it — and settlement
is delivery-versus-payment (DvP) on Coston2: FXRP is released only against an FDC-proven XRPL
payment. Built for **Flare Summer Signal** — Bounty 2 (Confidential Compute, primary) + Bounty 1
(FXRP, dual).

## What it does

- **Sealed matching in a TEE.** RFQ side, size, limit, and the identity↔order mapping of the
  unmatched book exist only inside the enclave, RAM-only, never in a database or log
  (`docs/design.md` §2, Zone 1).
- **DvP settlement, chain-enforced.** `DvPEscrow.release()` pays FXRP to the maker only against an
  FDC `XRPPayment` proof bound to that exact escrow instance (`proofOwner == address(this)`) — a
  proof for one trade can never be replayed against another.
- **Price protection.** FTSOv2 re-checks a ±1% band at `lock()` time and derives the required
  drops onchain — the enclave cannot mismatch price even if it lies.
- **Default protection.** A 1% maker bond is posted at match time and slashed to the taker if the
  maker never pays; `refund()` is permissionless after `refundAfter + REFUND_GRACE`.

## Live right now

The FCE extension is registered and running on Coston2, hosted at `https://fce.endpx.cloud`. This
is **simulated-TEE** (attestation `magic_pass`, `SIMULATED_TEE=true` / `MODE=1`) — stated honestly,
not hidden. See `docs/fce-runbook.md`.

| Component | Address / URL |
|---|---|
| FCE `/info` (signed `TeeInfo`) | https://fce.endpx.cloud/info |
| FCE extension ID | `0x…010069` (65641) |
| WhisperDeskInstructionSender | `0x6C2CA15B0c9459a71807e6Fb134874609E9c8790` |
| Live TEE signer | `0x1832e33F99cF5628f6Dc7Ae34e6011995BFdE4BD` |
| DvPEscrow (integration instance) | `0x5f32783D629E2acBb83f16628ad76D02A26CFB9B` |
| MockFXRP (mintable, 6 dec) | `0x700bfC3620585eb42F1Dda6aBA3Ac8E793859FBE` |
| BondLedger | `0xC2f2F46A126E542E8178e2cc8fdC13aF3A48E156` |
| FtsoV2 (real Coston2 registry) | `0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d` |
| FdcVerification (real) | `0x906507E0B64bcD494Db73bd0459d1C667e14B933` |

### Proven-live receipts (happy path + default path)

| Step | Receipt |
|---|---|
| XRPL payment (maker → taker, exact drops + destination tag) | https://testnet.xrpl.org/transactions/097B23FD6F4C3FF6740A956838A180C29950DD3E05343786E95930116B18BAA6 |
| `release()` — maker received FXRP against FDC proof | https://coston2-explorer.flare.network/tx/0x2c162613abea611d7b09c50251b35936b6d7c8599daea17016d952591a17202f |
| `refund()` — taker got principal + 1% slashed bond after no payment | https://coston2-explorer.flare.network/tx/0x1605a2ced9852f9caefebf6339cac3d294758f9d5e30c968208d2a4c0cc1feed |

Both flows ran end-to-end against real Coston2 + real XRPL Testnet + the real FDC verifier/DA
layer. The `MatchInstruction` for these runs was signed by the integration instance's registered
`teeSigner` key (simulated-TEE custody, same `WD_MATCH_V1`/`ecrecover` scheme as the enclave —
byte-compatibility proven in `extension/smoketest/`). The enclave itself is live and registered
separately (see `docs/fce-runbook.md`).

## Judge quickstart (5 minutes)

1. **Confirm the enclave is alive:**
   ```bash
   curl -s https://fce.endpx.cloud/info
   ```
   Returns a signed `TeeInfo` (pubkey, codeHash, platform, teeID).

2. **Run the contract test suite** (100/100 passing, verified locally):
   ```bash
   cd contracts && forge test --summary
   ```
   `BondLedgerTest` (17), `DvPEscrowTest` (66), `ForkFdcReleaseTest` (3), `ForkFtsoBandTest` (4),
   `GoldenVectorsTest` (4), `InvariantsTest` (4, fuzz/invariant), `MatcherToLockTest` (2) — 100
   passed, 0 failed.

3. **Optional: Go↔Solidity ABI parity + TEE signing smoke test:**
   ```bash
   cd extension/matcher && CGO_ENABLED=0 go test ./...   # golden-vector parity with Solidity
   ```
   See also `extension/smoketest/` for the enclave-side `ecrecover` signature check.

4. **Optional — run your own full live DvP trade end-to-end** (not just read the receipts above):
   deploy your own `DvPEscrow` instance (you become its owner + `teeSigner`, so you can self-sign
   and run the whole flow without needing our enclave), then run the happy-path and default-path
   runners against it. Full steps, env vars, and layout in `scripts/e2e/README.md`. Short version:
   ```bash
   cd contracts && forge script script/DeployIntegration.s.sol --rpc-url coston2 --broadcast --slow
   cd ../scripts/e2e && npm install
   # repo-root .env: PRIVATE_KEY, TAKER_PRIVATE_KEY, MAKER_PRIVATE_KEY (funded via https://faucet.flare.network)
   #                 XRPL_MAKER_SEED (https://faucet.altnet.rippletest.net), XRPL_TAKER_ADDRESS
   ESCROW_ADDRESS=0x... npm run happy-path     # lock -> real XRPL payment -> fresh FDC proof -> release
   ESCROW_ADDRESS=0x... npm run default-path   # lock -> no payment -> wait refundAfter+grace -> refund + bond slash
   ```
   Note: this self-run uses a `MatchInstruction` you sign yourself on your own instance — the
   same trust setup as the receipts above (the instance's registered `teeSigner` signs; the
   contract only ever trusts `ecrecover == teeSigner`, whoever holds that key).

## How a trade settles

```
 Maker RFQ                Taker RFQ
    |                         |
    v                         v
  +-------------------------------------------+
  |   FCE enclave (TEE) — sealed order book    |
  |   side / size / counterparty stay here     |
  +-------------------------------------------+
                    | signed MatchInstruction (WD_MATCH_V1, ecrecover == teeSigner)
                    v
  +-------------------------------------------+
  |   DvPEscrow.lock()   on Coston2            |
  |   - FTSOv2 re-check: price within +/-1%    |
  |   - onchain drops derivation               |
  |   - 1% maker bond posted (BondLedger)      |
  +-------------------------------------------+
                    |
        +-----------+-----------+
        |                       |
        v                       v
  real XRPL payment       no payment
  (maker -> taker)        before deadline
        |                       |
        v                       v
  FDC XRPPayment proof     refundAfter + GRACE elapses
  (proofOwner == escrow)         |
        |                       v
        v                permissionless refund()
  DvPEscrow.release()     taker: principal + slashed
  maker receives FXRP     maker's 1% bond
```

## Trust model

The enclave is trusted for **secrecy only** — the sealed book, the matcher, the TEE signing key.
It never holds funds. Every settlement rule is enforced onchain regardless of what the enclave
does or claims: TEE signature verification (`ecrecover == teeSigner`), the FTSOv2 ±1% band
re-check, FDC proof consumption bound to one escrow instance, deadlines, and bond slashing. Worst
case if the enclave is fully compromised: order-flow confidentiality is lost and a match can land
at the edge of the price band — loss bounded at 1% of notional, no fund theft possible. Full spec
and worst-case analysis: `docs/design.md` §2 (Trust Boundaries).

## Repo layout

| Path | Contents |
|---|---|
| `contracts/` | Foundry project — `DvPEscrow.sol`, `BondLedger.sol`, `WhisperDeskInstructionSender.sol`, `MatchInstructionLib`, mocks, 100 tests |
| `extension/matcher/` | Go sealed order book, deterministic matcher, golden vectors (ABI parity with Solidity) |
| `extension/smoketest/` | TEE-side signing smoke test (`ecrecover` compatibility check) |
| `scripts/e2e/` | Live DvP end-to-end runners (`happy-path.mjs`, `default-path.mjs`) against a deployed integration instance |
| `scripts/fdc-spike/` | Step-2 FDC XRPL spike that produced the GO/NO-GO gate decision |
| `web/` | Next.js landing page |
| `docs/` | `design.md` (full technical spec), `fce-runbook.md` (enclave bring-up), `ui-design-brief.md` |

## Built during the hackathon

Everything in this repo — contracts, matcher, enclave wiring, E2E runners, UI — was built during
Flare Summer Signal; commit history is the evidence trail. All addresses and transactions above
are **Coston2 and XRPL Testnet only**. This is a hackathon prototype: not audited, not production
custody.
