# WhisperDesk

Private OTC desk for institutional XRP↔FXRP block trades. Sealed RFQs are matched inside a Flare
Confidential Compute (FCE) enclave — side, size, and counterparty never leave it — and settlement
is delivery-versus-payment (DvP) on Coston2: FXRP is released only against an FDC-proven XRPL
payment. Built for **Flare Summer Signal** — Bounty 2 (Confidential Compute).

**▶ Try it: https://whisperdesk.endpx.cloud** — runs a real DvP settlement on Coston2 + XRPL Testnet
in about 3 minutes. Two modes: *Be the taker* (your own MetaMask; the XRP lands on an XRPL address
you control) or *One-click* (the desk's testnet keys, rate-limited). Live enclave:
https://fce.endpx.cloud/info

## What is and isn't real here

This is a hackathon prototype, and these are its scope boundaries, not apologies:

- **FXRP is a MockFXRP test token** (mintable, unbacked), not FAssets-minted FXRP. The DvP/settlement
  machinery around it — escrow, FDC proof check, price band, bond slashing — is real; the asset is a
  stand-in.
- **The enclave runs in simulated-TEE mode** (attestation `magic_pass`, `SIMULATED_TEE=true`). Its
  identity key regenerates on every restart by design — there is no persistent enclave identity yet.
- **Two RFQ ingresses exist.** The onchain one is now real: `WhisperDeskInstructionSender.submitRfq`
  is deployed and is the registry-enforced instruction sender for our extension, and it stamps the
  taker from `msg.sender` so the identity cannot be forged (see below). The live *demo* still enters
  over `POST /direct` (API-keyed, `WD_ALLOW_DIRECT_RFQ=true`), where the taker is self-attested,
  because the enclave's onchain instruction queue is currently gated on FSP signing-policy cadence
  on this deployment — infrastructure timing, not our code.

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
layer. The `MatchInstruction` for these two runs was signed by the integration instance's registered
`teeSigner` key (simulated-TEE custody, same `WD_MATCH_V1`/`ecrecover` scheme as the enclave —
byte-compatibility proven in `extension/smoketest/`).

### The enclave loop — signed by the live enclave, end to end

The run below is the one that matters for Bounty 2: **nothing was self-signed**. A sealed (ECIES)
RFQ went into the live enclave, a maker quote was authenticated inside it by EIP-712, the enclave
matched them and signed the `MatchInstruction` with its own in-enclave key, and the escrow accepted
that signature onchain (`ecrecover == teeSigner`) before the FDC-proven XRPL payment released the
FXRP. One continuous flow.

| Stage | Receipt |
|---|---|
| Sealed RFQ → enclave (`rfqId` = keccak256 of the ciphertext) | `0xddea516f…da38` |
| Enclave signer, verified by local `ecrecover` before any tx | [`0x56564F61…c18B`](https://coston2-explorer.flare.network/address/0x56564F61588bB110E0712c3938aDa4338e6cc18B) |
| `lock()` — escrow accepted the **enclave's** signature | https://coston2-explorer.flare.network/tx/0x58ec0e5e8e7b4e8ec85b86be863c62565a1292c210420e36b5f382196de5d1db |
| XRPL payment (1,005,708 drops, destination tag 1) | https://testnet.xrpl.org/transactions/D44BAE4B51F3A5B0F9CAF8510E4308A331547B1BFDDA5EF3059AB26DC9DB548A |
| FDC attestation request (voting round 1405105) | https://coston2-explorer.flare.network/tx/0x36e9e649b8d123369dbe0ede36fa2703bce8deb701c0f0270ab7689802f0a5e8 |
| `release()` — maker received 1.0 FXRP | https://coston2-explorer.flare.network/tx/0xb6b01c627771323542db03e7a911026139aa1e5a4e81c65dfd08866e21cbdfad |

Enclave-loop escrow: [`0x20A885cb…7023`](https://coston2-explorer.flare.network/address/0x20A885cb6ed3F652C5Fcb6a683CE74436F6a7023)
(its `teeSigner` **is** the live enclave). Reproduce with `scripts/enclave-loop/` — see that
directory plus `extension/fcewire/PROTOCOL.md` for the wire protocol.

### Chain-authenticated RFQ ingress

[`WhisperDeskInstructionSender`](https://coston2-explorer.flare.network/address/0x56A903F408C4745D34354Ec230BbfBDD78eC6426)
(`0x56A903F4…6426`) is deployed and is now the **registry-enforced** instruction sender for extension
`65641` — the TEE registry rejects `sendInstructions` from any other contract, so this is the only
address that can originate a WD_RFQ instruction.

| Step | Receipt |
|---|---|
| Registry swap — `setExtensionContracts(65641, 0x0, 0x56A903F4…)` | https://coston2-explorer.flare.network/tx/0x00394192a6947f3f2dfc7b7b4ac4d2fabf841d002be77aaa89c4c4b6bf189519 |
| First onchain `submitRfq` | https://coston2-explorer.flare.network/tx/0xd50dd58c2dd66747dc1caa97077c64a4119b2efe4fb48ced14b3c15b50eef69a |

Why it matters: decode that second transaction's instruction event and the message is
`abi.encode(0xBF164f13…c4F6, <ECIES ciphertext>)` — the taker address was written by the *contract*
from `msg.sender`, not supplied by the client. A caller cannot claim to be a different taker, which
is what closes the spoofing gap the `/direct` demo path leaves open (`contracts/test/` proves the
binding; 117/117 tests green).

Not yet done: the enclave has not consumed that onchain instruction — `ext-proxy` reports
`signing policy 5858 not yet on chain; waiting`, so the onchain instruction queue is waiting on FSP
signing-policy cadence for this deployment. The contract, the registration, and the `msg.sender`
binding are all live and verifiable now; end-to-end consumption over the onchain queue is the
remaining step.

Honest scope note: for this demo the RFQ enters over `POST /direct` behind an API key with
`WD_ALLOW_DIRECT_RFQ=true`, so the taker identity in the envelope is self-attested rather than
chain-authenticated. The production ingress is `WhisperDeskInstructionSender.submitRfq`, which binds
`msg.sender` onchain; that contract is still a stub. Everything downstream of ingress — sealing,
in-enclave matching, EIP-712 maker auth, enclave signing, and the onchain `ecrecover` check — is the
real path. The enclave runs in simulated-TEE mode (`magic_pass`), and its identity key regenerates
on every restart by design (see `docs/enclave-deploy-checklist.md`).

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

## Roadmap

What it would take to make this real, in order:

1. Onchain `submitRfq` ingress — `WhisperDeskInstructionSender.submitRfq` binds `msg.sender`, removing the self-attested taker in `POST /direct`.
2. Real FAssets FXRP — replace MockFXRP with an actual FAssets-minted FXRP position.
3. Persistent TEE identity + real attestation — replace `magic_pass` with genuine remote attestation and a key that survives restarts.
4. Maker onboarding — let more than one maker register into the sealed book, not just the demo pair.
5. Multi-RFQ book — support concurrent open RFQs and matches, not one trade at a time.
6. Mainnet/Songbird deploy — move off Coston2 once the above are stable.
