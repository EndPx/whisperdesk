# WhisperDesk — Unified Technical Design Spec (v1.1, reconciled + review-patched)

> Private OTC desk for XRP↔FXRP block trades on Flare. Sealed RFQ matching inside a Flare
> Confidential Compute extension (FCE); settlement is cross-chain DvP: a Coston2 escrow releases
> FXRP only against an FDC `XRPPayment` attestation proving the exact XRPL payment. FTSOv2 XRP/USD
> enforces a ±1% price band onchain; a 1% maker bond is slashed on settlement default.
>
> Targets: **Coston2 (chain 114)** + **XRPL Testnet**. FCE stack in `SIMULATED_TEE=true,
> LOCAL_MODE=false, MODE=1`. This document is the single source of truth; every cross-component
> interface below is canonical and byte-exact.

**Quantified policy (locked — enforced in code, not prose):** min block 5,000 FXRP (= `5_000_000_000`
raw at 6 decimals) · maker quote validity 60 s · match must be within ±1.0% of FTSOv2 XRP/USD mid
AND beat the taker limit · XRPL settlement window 30 min, now including a **360 s FDC-attestation
safety margin** (2× the ~180 s nominal FDC round-trip budget — widened per security review to
close a refund/release race, see §3.2/§3.8/§11/§14) · maker bond 1% of notional, slashed 100% to
the honest side on default · escrow auto-refund after deadline (permissionless) · public tape
delayed 24 h in the full design, **served live behind a `demo` flag for the v0 freeze** (§13.1) ·
daily aggregates only (v2).

**This revision (v1.1) integrates a security/scope review.** Three critical contract-level gaps
(armed-balance accounting, FDC proof-owner binding, `ecrecover` zero-address) are now closed in
the contract text itself. A demo-fragility critical finding removed the second live "demo-default"
deployment from the judged demo path entirely. A scope-vs-budget critical finding produced the new
**§13.1 v0 Demo-Critical Freeze**, which is now the authoritative cut line for a solo 19-day build.
Two scaffold/dependency major findings are folded into the Step 3 DoD. See §14 for what remains an
accepted, documented residual risk rather than a full fix.

---

## 1. Architecture Overview

```
                                PUBLIC INTERNET
 ┌────────────────────┐                                 ┌────────────────────┐
 │   BROWSER: TAKER   │                                 │   BROWSER: MAKER   │
 │ MetaMask (Coston2) │                                 │ MetaMask (Coston2) │
 │ ECIES-seal RFQ     │                                 │ ECIES-seal quotes  │
 └───┬─────────┬──────┘                                 │ xrpl.js (pay XRP)  │
     │ tx      │ https                                  └──┬─────┬─────┬─────┘
     │         ▼                                       tx  │     │https│ XRPL
     │   ┌───────────────────────┐   ┌──────────────┐      │     │     │
     │   │ VERCEL — Next.js UI + │◄─►│ NEON Postgres│      │     │     │
     │   │ API routes (tracker,  │   │ PUBLIC data  │      │     │     │
     │   │ tape, /api/tee/*)     │   │ mirror only  │      │     │     │
     │   └──────────┬────────────┘   └──────▲───────┘      │     │     │
     │              │ https                 │ sql          │     │     │
     ▼              ▼                       │              ▼     │     ▼
 ┌───────────────────────────────────────┐  │   ┌─────────────────────────────┐
 │ COSTON2 C-CHAIN (114, ~1.8 s blocks)  │  │   │ VPS srv1330754.hstgr.cloud  │
 │ ┌──────────────────────────┐          │  │   │ nginx:443 → 127.0.0.1:6674  │
 │ │WhisperDeskInstruction-   │──sendIns─┼─►│   │ ┌─────────────────────────┐ │
 │ │Sender  submitRfq /       │ tructions│  │   │ │ tee-proxy (ext-proxy)   │ │
 │ │        triggerMatch      │          │  │   │ │ /info /direct /action/* │ │
 │ └──────────────────────────┘          │  │   │ │ /instruction  ↔ redis   │ │
 │ ┌──────────┐  ┌───────────┐           │  │   │ └───▲───────────┬─────────┘ │
 │ │DvPEscrow │  │BondLedger │           │  │   │     │ :6663     │ queue     │
 │ │lock/rel./│◄─┤1% FXRP    │           │  │   │ ┌───┴───────────▼─────────┐ │
 │ │refund    │  │slash      │           │  │   │ │ extension-tee container │ │
 │ └─┬──┬──┬──┘  └───────────┘           │  │   │ │  tee-node + Go engine   │ │
 │   │  │  │ FlareTeeManager diamond     │  │   │ │  :7702 /action /state   │ │
 │   │  │  │ (TeeExtensionRegistry,      │  │   │ │  :7701 /sign /decrypt   │ │
 │   │  │  │  MachineManager, OpFees)    │  │   │ │  (loopback only)        │ │
 │ ┌─▼┐┌▼─────┐┌───────────────────────┐ │  │   │ └───────────┬─────────────┘ │
 │ │Ft││FXRP  ││FdcHub + FeeConfig +   │ │  │   │ ┌───────────▼─────────────┐ │
 │ │so││ERC20 ││FdcVerification + Relay│ │  │   │ │ whisper-worker (TS)     │ │
 │ │V2││6 dec ││                       │ │  └───┼─│ indexer· match keeper·  │ │
 │ └──┘└──────┘└───▲──────▲────────────┘ │      │ │ xrpl watcher· fdc relay·│ │
 └──────────────── │ ─────│───────────── ┘      │ │ refund keeper· tape cron│ │
                   │      │ Merkle roots        └──────┬───────────┬──────────┘
 ┌─────────────────┴──┐   │ (90 s rounds)               │ MySQL     │ WSS/RPC
 │ FDC data providers │───┘                        Flare Indexer   XRPL Testnet
 │ + ctn2 DA layer +  │◄── fetch attested tx ──┐    DB 34.38.42.208 (~4 s ledger,
 │ verifiers-testnet  │                        │         :3306     ~12 s final)
 └────────────────────┘                   XRPL Testnet
```

**One trade, end to end (happy path):**
1. Taker `approve` + `deposit(amount, armedUntil)` FXRP into `DvPEscrow` (armed-balance model,
   now with an independent `committed`-exposure counter — §3.3).
2. Taker browser fetches TEE pubkey (`/api/tee/info` ← proxy `GET /info`), verifies
   `keccak(pubkey) == escrow.teeSigner()`, ECIES-seals the RFQ (padded to 512 B), sends one tx:
   `WhisperDeskInstructionSender.submitRfq(ciphertext){value: fee}`.
3. Instruction relays through FSP data providers (>50% weight) → tee-proxy → tee-node → Go engine
   `POST /action`. Engine decrypts via loopback `POST /decrypt`, validates, rests RFQ in the RAM book.
   `rfqId = instructionId` of this instruction.
4. Makers stream sealed quotes via tee-proxy `POST /direct` (API-key gated, zero gas, ~1–2 s).
   Each quote carries an EIP-712 maker signature; engine verifies it and checks the maker's bond
   via cached `eth_call`. Replace-by-maker, 60 s freshness.
5. After the RFQ window (60 s; demo 30 s) the keeper calls `triggerMatch(rfqId)` (onchain audit
   anchor). Engine runs the deterministic auction, builds `MatchInstruction`, signs it through the
   sign port (`WD_MATCH_V1` digest), returns it as the action result.
6. Anyone (the match keeper does) polls `GET /action/result/{instructionId}`, extracts
   `(abiEncoded, teeSignature)`, calls `DvPEscrow.lock(...)`. The escrow verifies the TEE
   signature (rejecting a recovered zero-address outright, §3.5), re-checks the ±1% band against a
   live FTSOv2 read, **derives `xrpDrops` onchain**, reserves taker FXRP (incrementing
   `committed`) + maker bond, assigns a fresh destination tag, emits `MatchLocked`, and refunds any
   `msg.value` surplus over the FTSOv2 fee to the caller.
7. Maker reads `MatchLocked` (payment card in the UI), pays exact drops + destination tag on XRPL.
8. whisper-worker detects the payment (WSS), runs the FDC pipeline (`prepareRequest` with
   `requestBody.proofOwner` set to the escrow address → `requestAttestation{value: getRequestFee}`
   → DA-layer proof), calls `release(matchId, proof)`. Escrow verifies `verifyXRPPayment` + the
   proof-owner binding + all response-body checks → FXRP → maker, bond freed, `committed`
   decremented.
9. Default path: no valid proof by `refundAfter` → anyone calls `refund(matchId)`:
   principal → taker + 100% of the 1% bond → taker, atomically, `committed` decremented.

Happy-path wall time ≈ 3.5–7 min (two instruction relays + one 90–180 s FDC round); demo runner
pre-warms deposits/bond and uses `WD_RFQ_WINDOW_SEC=30` to fit the < 5 min judged round-trip.

---

## 2. Trust Boundaries

**Zone 1 — ENCLAVE-PRIVATE** (Go engine inside tee-node; SIMULATED_TEE for the hackathon,
GCP Confidential Space / AMD SEV documented as the production path):
- Plaintext RFQs (side, size, limit, taker XRPL address) — *pre-match only*.
- Plaintext maker quotes (price, size, nonce) and the identity↔order mapping of the unmatched book.
- The sealed book itself: RAM-only, ephemeral (TEE statelessness confirmed acceptable by Flare —
  quotes live 60 s; all settlement state lives onchain).
- The TEE identity key: generated fresh at every boot, used only via loopback `:7701`, never exported.
- **Invariant: nothing in this zone is ever written to Neon, server logs, `ActionResult.Log`/`Data`
  on error paths, `/state`, Redis, or analytics.** Enforced by a closed error-code enum + CI leak scan.

**Zone 2 — ONCHAIN-ENFORCED** (Coston2 — the chain, not the enclave, holds all funds):
- Ciphertext RFQs in calldata (public but opaque; padded to fixed 512 B so size doesn't leak).
- Escrow records post-match: parties, FXRP amount, drops, XRPL destination, tag, deadlines, status —
  post-trade transparency is by design (the XRPL payment is public anyway).
- ±1.0% FTSOv2 band **re-checked at lock time** and **onchain drops derivation** — enforced even if
  the enclave lies.
- FDC `XRPPayment` proof verification with status/address/tag/amount/window checks **plus a
  mandatory `proofOwner == address(this)` binding** (§3.7) — a proof requested for this escrow
  instance cannot be reused against any other, closing a cross-instance proof-reuse path found in
  review.
- TEE identity binding: `ecrecover == teeSigner` on every match, with an explicit zero-address
  reject on both the recovered signer and any `teeSigner`/`newSigner` configuration value; deadline,
  auto-refund, bond slash — all pure onchain, functional with every off-chain component dead.
- Taker fund exposure is tracked by an explicit `committed` counter, independent of the `armedUntil`
  time gate, so a taker can never withdraw FXRP that currently backs an open `Locked` match
  regardless of how the deposit's arming clock has run out (§3.3/§3.4/§3.6).

**Zone 3 — PUBLIC OFF-CHAIN** (convenience; zero fund custody, zero secret custody):
- Neon (public mirror + tape — 24 h delay is the full design, live-with-`demo`-flag for v0), Vercel
  UI/API, whisper-worker, tee-proxy public endpoints (`/info`, `/direct` intake, `/action/result/*`
  — never unmatched book state), XRPL ledger.

**Worst-case statements (verbatim for the Bounty 2 writeup):**
- Zone 3 compromised → wrong dashboard; funds safe.
- Zone 1 compromised → order-flow confidentiality lost + worst-price match at the edge of the ±1%
  band. Loss bounded at 1% of notional; **no fund theft possible** — Zone 2 re-checks the band,
  derives the drops itself, releases only against an FDC proof bound to this exact escrow instance,
  and refunds at the deadline.
- TEE crash mid-settlement → zero impact on locked matches; refund-by-deadline is pure onchain.
- SIMULATED_TEE disclosure: attestation is the `MagicPass` sentinel with fixed codeHash
  `0x194844cf…` and the operator can technically inspect container memory — **the demo shows the
  protocol, not the hardware guarantee**; production path (MODE=0, PKI JWT, code-hash allowlist,
  AMD SEV) is documented, not built.

---

## 3. Smart Contracts

All contracts in `contracts/` (Foundry). **`foundry.toml` bumped to `solc = "0.8.27"`** — an
explicit first Step 1 sub-task (bumping from the already-initialized `0.8.25`; verify
`evm_version = cancun` and `via_ir = true` still apply after the bump). Deps: `forge-std` +
`flare-periphery-contracts` only. Minimal hand-rolled `Owned`; custom errors everywhere;
transient-storage `nonReentrant` + CEI on every fund-moving function. All Flare protocol addresses
(FXRP, FtsoV2, FdcVerification) resolved via
`FlareContractRegistry (0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019)` in the deploy script +
permissionless `syncFromRegistry()` — never hardcoded. **Reference-doc note:** `flare-docs/fdc.md`
and `flare-docs/fdc-request-fee.md` list two different addresses for `FdcVerification` on Coston2
(`0x075bf3...` vs `0x9065...`), both claimed "verified live" the same day — the design never
hardcodes either (registry is the only truth used in code), but re-verifying both addresses via
`ContractRegistry.getFdcVerification()` and annotating/correcting whichever flare-docs file is
stale is tracked as an explicit Step 1 sub-task, so nobody hand-copies the wrong one during quick
debugging.

### 3.1 Contract map & money flow

```
taker (FXRP) ──deposit(amount, armedUntil)──▶ DvPEscrow ◀──lock(TEE-signed MatchInstruction, permissionless relay)
maker (FXRP bond) ──depositBond──▶ BondLedger ◀──lockBond/releaseBond/slashBond── DvPEscrow (onlyEscrow)
maker pays XRP on XRPL ──▶ FDC XRPPayment proof (proofOwner = escrow) ──▶ DvPEscrow.release ──FXRP──▶ maker
deadline passes, no proof ──▶ DvPEscrow.refund ──FXRP──▶ taker + slashed bond ──▶ taker
sealed RFQ ciphertext ──▶ WhisperDeskInstructionSender ──▶ FlareTeeManager.sendInstructions ──▶ TEE
```

- `DvPEscrow` holds only taker FXRP; `BondLedger` holds only maker bond FXRP; **the TEE never holds funds**.
- v1 direction: **taker sells FXRP; maker pays native XRP on XRPL** to the taker's r-address + a
  per-match destination tag; on FDC proof the escrow releases FXRP to the maker.
- **Maker bond is FXRP** (decided): slash = exactly `amountFxrp / 100` with zero oracle involvement
  and zero value drift; the slashed taker is compensated in the traded asset; one ERC-20 path.
- FXRP: 6 decimals, Coston2 `0x0b6A3645c240605887a5532109323A3E12273dc7` (resolved via registry at
  deploy, never pasted into code). 1 FXRP raw unit = 1 XRP drop at par (both 1e6 scale).

### 3.2 Policy constants & window parameters

```solidity
uint256 public constant MIN_BLOCK_FXRP = 5_000e6;  // 5,000 FXRP, 6-dec raw
uint16  public constant BAND_BIPS      = 100;      // ±1.0% vs FTSOv2 XRP/USD mid (inclusive)
uint16  public constant BOND_BIPS      = 100;      // maker bond = 1% of notional
uint32  public constant MAX_ORACLE_AGE = 60;       // FTSOv2 staleness bound
uint16  public constant TAKER_FEE_BIPS = 0;        // v1: zero; 5 bps slot wired (one-constant change)

// Windows are IMMUTABLE CONSTRUCTOR PARAMS (decided — enables a short-window test/staging instance
// without redeploying the canonical instance's policy):
uint32 public immutable SETTLEMENT_WINDOW;   // canonical deploy: 1800 s (locked policy, unchanged)
uint32 public immutable ATTESTATION_BUDGET;  // canonical deploy: 360 s — WIDENED 2x from the 180 s
                                              // nominal FDC round-trip time per security review
                                              // (closes the refund/release race, see §3.8/§11/§14)
uint32 public immutable PAYMENT_WINDOW;      // = SETTLEMENT_WINDOW - ATTESTATION_BUDGET (1440 s)
```

Splitting the window (`release` accepts payments with `blockTimestamp <= lockedAt + PAYMENT_WINDOW`,
`refund` unlocks strictly after `lockedAt + SETTLEMENT_WINDOW`) removes the pay-at-the-wire race: a
timely XRPL payment now has ≥ 360 s of proof runway — 2× the ~90–180 s the FDC pipeline normally
takes — rather than the originally-specified 180 s, which review found gave a dishonest taker an
economically rational window to race `refund()` against the relayer's `release()` when a maker paid
close to the deadline. **This narrows, but does not eliminate, that race** — see §14.

**No second (demo-default) deployment in v0.** A prior draft of this spec called for a second full
`BondLedger`+`DvPEscrow` stack (`SETTLEMENT_WINDOW=240, ATTESTATION_BUDGET=120`) plus a live
`wd-rebind.sh` TEE-restart-and-rebind step, run *during the judged demo*, purely to fast-forward the
failure-path narrative. Security review flagged this as a demo-fragility risk (any RPC hiccup, stale
env var, or slow confirmation during a live restart burns the judged window) with no offsetting
benefit. **Cut for v0** (§13.1): the failure-path demo reuses the **same canonical instance** as the
happy path, via the existing `mode:'default'` demo-pay helper (§7.2 module 6) which deliberately
skips payment, with the real 1800 s/360 s clock either fast-forwarded by a documented time-warp test
helper (staging/rehearsal only, on an anvil fork) or played back from a **pre-recorded transcript
with a real, committed proof fixture** for the judged run itself (§7.5, §10). Cross-instance replay
defenses (`mi.escrow == address(this)` inside the signed digest, §3.5) are retained as v2-forward
defense-in-depth in case a second instance is ever deployed, but are not exercised by v0.

### 3.3 DvPEscrow — state machine & storage

`enum MatchState { None, Locked, Released, Refunded }` — no separate `Created`/`Slashed` states:
deposits are a balance model, and default-refund slashes atomically in the same tx
(`MatchRefunded` carries `bondSlashed`; tracker status `slashed` = `Refunded && bondSlashed > 0`).
If a valid proof and an elapsed deadline coexist, **first transaction wins** — `release()` stays
callable after `refundAfter` until `refund()` executes; the refund keeper calls promptly (§7.2
module 5).

```solidity
// immutables / config
IERC20 public immutable FXRP;
IBondLedger public immutable BOND_LEDGER;
bytes32 public immutable EXPECTED_SOURCE_ID;   // bytes32("testXRP") right-padded on Coston2
bytes32 public constant  EXPECTED_ATTESTATION_TYPE = bytes32("XRPPayment");
bytes21 public constant  XRP_USD_FEED_ID = 0x015852502f55534400000000000000000000000000;
bytes32 public constant  WD_MATCH_TAG    = bytes32("WD_MATCH_V1");
address public owner;
address public teeSigner;                      // settable — TEE key regenerates on every boot;
                                                 // constructor + setTeeSigner both revert ZeroAddress()
                                                 // on address(0) (config-layer guard, see §3.4/§3.5)
FtsoV2Interface public ftsoV2;                 // synced from ContractRegistry
IFdcVerification public fdcVerification;       // synced from ContractRegistry
address public feeTreasury;
bool public lockPaused;                        // gates lock() ONLY — release/refund/withdraw never pausable

// taker deposits — ARMED-BALANCE model with an explicit COMMITTED-EXPOSURE counter.
// `committed` closes the review-flagged gap where a purely time-based `armedUntil` gate let a
// taker withdraw FXRP that was still backing an open Locked match (armedUntil typically expires
// minutes before a match's settlement window does). `committed` is independent of `armedUntil`:
// it is incremented in lock() and decremented ONLY in release() or refund() — never by the passage
// of time — so funds backing an open match can never be withdrawn regardless of the arming clock.
struct TakerBalance { uint128 armed; uint128 committed; uint64 armedUntil; }   // 2 slots
mapping(address => TakerBalance) public balances;                             // public getter read by engine + UI

// matches
struct Match {                                                   // packed, 5 slots
    address taker; uint32 destinationTag; uint40 lockedAt; MatchState state;
    address maker; uint40 paymentDeadline; uint40 refundAfter;
    uint128 amountFxrp; uint128 xrpDrops;
    uint128 bondAmount;
    bytes32 takerXrplAddressHash;
}
mapping(bytes32 matchId => Match) public matches;
uint32 public nextDestinationTag = 1;          // fresh per match, assigned at lock — replay anchor
```

### 3.4 DvPEscrow — external interface (canonical)

```solidity
// taker funds
function deposit(uint256 amount, uint64 armedUntil) external nonReentrant;  // transferFrom; extends armedUntil monotonically
function withdraw(uint256 amount) external nonReentrant;
    // requires BOTH, independently: block.timestamp > armedUntil  (else WithdrawLocked)
    //                               amount <= armed - committed    (else ExceedsUncommitted)
    // — the time gate alone is no longer sufficient; funds backing any open Locked match are
    //   excluded from what withdraw() can ever move, no matter how armedUntil has run out.

// settlement lifecycle — ALL permissionless (authority = signatures/proofs, never the caller)
function lock(bytes calldata instructionData, bytes calldata teeSignature)
    external payable nonReentrant returns (bytes32 matchId);
    // payable: forwards FTSOv2 fee; refunds any msg.value surplus over the fee to msg.sender,
    // performed last (after all state writes) — see §3.6 step 8.
function release(bytes32 matchId, IXRPPayment.Proof calldata proof) external nonReentrant;
function refund(bytes32 matchId) external nonReentrant;

// admin / config
function setTeeSigner(address newSigner) external;   // onlyOwner — reverts ZeroAddress() on address(0);
                                                       // required on every TEE restart
function setFeeTreasury(address t) external;         // onlyOwner
function setLockPaused(bool p) external;             // onlyOwner — lock() only
function syncFromRegistry() external;                // permissionless re-read of FtsoV2 + FdcVerification

constructor(IERC20 fxrp, IBondLedger bondLedger, address teeSigner_, FtsoV2Interface ftsoV2_,
    IFdcVerification fdcVerification_, bytes32 expectedSourceId, address feeTreasury_,
    uint32 settlementWindow_, uint32 attestationBudget_);
    // reverts ZeroAddress() if teeSigner_ == address(0)

event Deposited(address indexed taker, uint256 amount, uint64 armedUntil);
event Withdrawn(address indexed taker, uint256 amount);
event MatchLocked(bytes32 indexed matchId, address indexed taker, address indexed maker,
    uint256 amountFxrp, uint256 xrpDrops, uint32 destinationTag, string takerXrplAddress,
    uint64 paymentDeadline, uint64 refundAfter, uint256 priceUsd18, uint256 oracleMid18);
event MatchReleased(bytes32 indexed matchId, address indexed maker, uint256 amountFxrp, bytes32 xrplTxId);
event MatchRefunded(bytes32 indexed matchId, address indexed taker, uint256 amountFxrp, uint256 bondSlashed);
event TeeSignerUpdated(address indexed oldSigner, address indexed newSigner);

error ResultNotSuccess(uint8 status);          error BadSignatureLength(uint256 len);
error MalleableSignature();                    error InvalidTeeSignature(address recovered);
error WrongEscrow(address expected);           error MatchExists(bytes32 matchId);
error InstructionExpired(uint64 expiresAt);    error BelowMinBlock(uint256 amount);
error SelfMatch();                             error EmptyXrplAddress();
error FeeTooLow(uint256 need, uint256 got);    error OracleZero();
error StaleOracle(uint64 ts);                  error PriceOutOfBand(uint256 price, uint256 mid);
error InsufficientArmedBalance(uint256 need, uint256 have);
error DepositNotArmed();                       error WithdrawLocked(uint64 armedUntil);
error ExceedsUncommitted(uint256 requested, uint256 available);   // NEW — withdraw vs committed exposure
error NotLocked(bytes32 matchId);              error ProofInvalid();
error WrongSource();                           error PaymentFailedStatus(uint8 status);
error WrongDestination();                      error WrongDestinationTag();
error AmountTooLow(int256 got, uint256 need);  error PaymentBeforeLock();
error PaymentOutsideWindow();                  error RefundTooEarly(uint64 refundAfter);
error LockIsPaused();                          error NotOwner();  error ZeroAddress();
error WrongProofOwner();                       // NEW — release() proof-owner binding (§3.7)
```

### 3.5 THE cross-domain contract: `MatchInstruction` + `WD_MATCH_V1` digest

**Canonical struct — byte-identical in Solidity `abi.decode`, Go `abi.Arguments.Pack`, and TS
`encodeAbiParameters`. Any field-order drift breaks `lock()`.**

```solidity
struct MatchInstruction {
    bytes32 matchId;              // == rfqId == instructionId of the RFQ_SUBMIT instruction
    address escrow;               // target DvPEscrow (engine config) — cross-instance replay guard
    address taker;                // == SealedEnvelope.sender of the RFQ (chain-authenticated)
    address maker;                // EIP-712-verified, bonded quote signer
    uint256 amountFxrp;           // raw 6-dec, >= 5_000_000_000
    uint256 priceUsd18;           // matched USD per XRP (== per FXRP at par), 18-dec
    string  takerXrplAddress;     // plaintext r-address for the XRPL leg (public post-match by design)
    uint64  instructionExpiresAt; // enclave matchTime + 300 s; lock() reverts after this
}
// ABI tuple: (bytes32,address,address,address,uint256,uint256,string,uint64)
```

**Signature scheme (decided): application-level `WD_MATCH_V1` signature produced via the sign port
`POST /sign` — NOT the node's automatic `TEE_ACTION_RESULT` result signature.** Rationale: the
develop branch already changed the result-signature preimage once (domain wrap added vs the
weather-insurance doc pattern), FCC is pre-production, and reconstructing `ActionResult.Hash()`
onchain drags `submissionTag`/`status` encoding into Solidity for zero security gain. The sign
server's behavior is verified in source (`tee-node/internal/extension/server`, test asserts
`SigToPub(accounts.TextHash(keccak256(message)), sig)` against the TEE identity key): it computes
`keccak256(message)` then signs EIP-191 over it. Our digest mirrors the protocol's own
`SignedPayload` construction with our own tag, so domain separation is structurally identical:

```
dataHash    = keccak256(abi.encode(mi))                                  // mi = MatchInstruction
message     = abi.encode(bytes32("WD_MATCH_V1"), uint256(chainId), dataHash)   // 96 bytes; chainId=114
                → POST http://127.0.0.1:7701/sign  {"message": <base64(message)>}
payloadHash = keccak256(message)                                         // computed by sign server
digest      = keccak256("\x19Ethereum Signed Message:\n32" ‖ payloadHash)
signature   = 65 B [R‖S‖V]; sign port returns V ∈ {0,1} — ENGINE normalizes +27 before emitting
```

Onchain verification (inside `lock()`), **with an explicit zero-address reject added by review**
(a malformed/adversarial 65-byte signature — v∈{27,28}, s≤n/2 to pass canonicality, r/s otherwise
arbitrary — can cause `ecrecover` to return `address(0)` rather than reverting; if `teeSigner` were
ever left at, or reset to, `address(0)` this would forge an arbitrary match with zero cryptographic
authentication. §3.4's constructor/`setTeeSigner` guards close the configuration-layer half of this;
the check below closes the verification-layer half independently, defense-in-depth):

```solidity
bytes32 dataHash    = keccak256(instructionData);   // instructionData == abi.encode(mi), decoded separately
bytes32 payloadHash = keccak256(abi.encode(WD_MATCH_TAG, block.chainid, dataHash));
bytes32 digest      = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payloadHash));
// split sig; require length 65, s <= secp256k1n/2 (low-S, matches node canonicality), v in {27,28}
address recovered = ecrecover(digest, v, r, s);
if (recovered == address(0)) revert InvalidTeeSignature(recovered);   // NEW — closes the zero-address footgun
if (recovered != teeSigner)  revert InvalidTeeSignature(recovered);
```

Replay defense layers: `block.chainid` in the preimage (no cross-network replay), `mi.escrow ==
address(this)` (no cross-instance replay), `matches[matchId].state == None`
one-shot (no same-instance replay — `usedActionIds` is unnecessary and removed),
`instructionExpiresAt` (no stale-instruction ambush; band is also re-checked live). The escrow does
**not** consume `actionId`/`submissionTag`/`status` — those stay in the off-chain result envelope.

### 3.6 `lock()` — validation sequence

1. `!lockPaused`; decode `mi = abi.decode(instructionData, (MatchInstruction))`;
   `mi.escrow == address(this)`; verify `WD_MATCH_V1` signature (§3.5), including the
   zero-address-recovered reject.
2. `matches[mi.matchId].state == None`; `block.timestamp <= mi.instructionExpiresAt`;
   `mi.taker != mi.maker`; `mi.amountFxrp >= MIN_BLOCK_FXRP`; non-empty `takerXrplAddress`.
3. **FTSOv2 ±1% band re-check** (wei variant — decimals fixed at 18, never hand-parse `int8`):
   ```solidity
   uint256 fee = ftsoV2.calculateFeeById(XRP_USD_FEED_ID);
   if (msg.value < fee) revert FeeTooLow(fee, msg.value);
   (uint256 mid18, uint64 ts) = ftsoV2.getFeedByIdInWei{value: fee}(XRP_USD_FEED_ID);
   if (mid18 == 0) revert OracleZero();
   if (block.timestamp - ts > MAX_ORACLE_AGE) revert StaleOracle(ts);
   if (mi.priceUsd18 * 10_000 < mid18 * (10_000 - BAND_BIPS) ||
       mi.priceUsd18 * 10_000 > mid18 * (10_000 + BAND_BIPS)) revert PriceOutOfBand(mi.priceUsd18, mid18);
   ```
   Fee is 0 today; the payable pattern survives fee activation.
4. **Drops derivation — the oracle is load-bearing (decided: escrow computes, TEE never signs a
   drops figure):** `xrpDrops = mi.amountFxrp * mi.priceUsd18 / mid18` (floor; 18-dec factors
   cancel; result in 1e6 drop units). Because `priceUsd18 ∈ [0.99, 1.01] × mid18`, a fully
   compromised enclave misprices by at most 1%. **The `xrpDrops` stored and emitted in
   `MatchLocked` is the single source of truth for what the maker must pay** — maker/watcher/UI
   read the event, never recompute.
5. Reserve taker funds — **armed-balance check AND committed-exposure increment, both required**:
   `TakerBalance storage bal = balances[mi.taker]`; require `bal.armedUntil >= block.timestamp` and
   `bal.armed - bal.committed >= mi.amountFxrp + takerFee` (fee = 0 in v1; deduction point wired here
   for the 5 bps slot), else `InsufficientArmedBalance`; then `bal.committed += mi.amountFxrp`. This
   commitment is **independent of, and outlives, the `armedUntil` window** — it is decremented only
   by `release()` or `refund()` (§3.7/§3.8), never by time. This closes the review-flagged gap where
   a taker could withdraw funds still backing an open match once the short `armedUntil` clock (set
   by the UI to roughly RFQ TTL + 5 min, §7.1) had elapsed — which, before this fix, typically
   happened minutes before the match's real settlement deadline.
6. Reserve bond: `bondAmount = amountFxrp * BOND_BIPS / 10_000`;
   `BOND_LEDGER.lockBond(mi.matchId, mi.maker, bondAmount)` — reverts `InsufficientFreeBond`
   atomically (nothing charged).
7. Write `Match{Locked, …, destinationTag: nextDestinationTag++, lockedAt: now,
   paymentDeadline: now + PAYMENT_WINDOW, refundAfter: now + SETTLEMENT_WINDOW,
   takerXrplAddressHash: keccak256(bytes(mi.takerXrplAddress))}`; emit `MatchLocked` with the
   plaintext r-address, tag, drops, deadlines, `priceUsd18`, `mid18`.
8. **Surplus `msg.value` refund (NEW — closes a fund-safety gap flagged in review):** after all
   state writes above, `if (msg.value > fee) { (bool ok, ) = msg.sender.call{value: msg.value - fee}("");
   require(ok); }`. Without this, a relayer over-provisioning `msg.value` against FTSOv2 fee
   fluctuation would have its excess C2FLR permanently stranded (not stealable, but an avoidable
   UX/fund-safety gap once fees move off zero).

### 3.7 `release()` — FDC XRPPayment consumption

```solidity
function release(bytes32 matchId, IXRPPayment.Proof calldata proof) external nonReentrant {
    Match storage m = matches[matchId];
    if (m.state != MatchState.Locked) revert NotLocked(matchId);
    // NEW — mandatory proof-owner binding, checked before any other proof content: closes a
    // cross-instance/cross-match proof-reuse path where an FDC proof requested for ANY known XRPL
    // transactionId (prepareRequest/requestAttestation are fully permissionless) could otherwise be
    // replayed against a different escrow instance whose destination tag/amount happened to match.
    if (proof.data.requestBody.proofOwner != address(this)) revert WrongProofOwner();
    if (!fdcVerification.verifyXRPPayment(proof)) revert ProofInvalid();
    if (proof.data.attestationType != EXPECTED_ATTESTATION_TYPE
        || proof.data.sourceId != EXPECTED_SOURCE_ID) revert WrongSource();     // pins XRPL Testnet
    IXRPPayment.ResponseBody memory r = proof.data.responseBody;
    if (r.status != 0) revert PaymentFailedStatus(r.status);   // MUST come first: receivingAddressHash
                                                               // is ZEROED when status != 0
                                                               // (status 2 covers tecDST_TAG_NEEDED/tecNO_DST)
    if (r.receivingAddressHash != m.takerXrplAddressHash) revert WrongDestination();
    if (!r.hasDestinationTag || r.destinationTag != uint256(m.destinationTag)) revert WrongDestinationTag();
    if (r.receivedAmount <= 0 || uint256(r.receivedAmount) < m.xrpDrops)
        revert AmountTooLow(r.receivedAmount, m.xrpDrops);     // int256: sign-check before cast
    if (r.blockTimestamp < m.lockedAt) revert PaymentBeforeLock();
    if (r.blockTimestamp > m.paymentDeadline) revert PaymentOutsideWindow();
    m.state = MatchState.Released;
    balances[m.taker].committed -= m.amountFxrp;    // NEW — release the committed-exposure counter (§3.3/§3.6)
    BOND_LEDGER.releaseBond(matchId);
    FXRP.transfer(m.maker, m.amountFxrp);
    emit MatchReleased(matchId, m.maker, m.amountFxrp, proof.data.requestBody.transactionId);
}
```

Proof replay protection: the mandatory `proofOwner` binding + the fresh per-match destination-tag
counter + one-shot `Locked→Released` + `blockTimestamp >= lockedAt` — no historical, cross-instance,
or third-party payment can satisfy a match, and one payment can never release two matches.
`verifyXRPPayment` (attestation type `0x08`) is used, **not** `verifyPayment` — it natively exposes
`hasDestinationTag`/`destinationTag`. Proofs are valid forever (no expiry logic beyond the
payment-timestamp window); the relayer/worker **must always** set `requestBody.proofOwner =
address(escrow)` in `prepareRequest` (§6.5) — this is no longer just an FDC convention, it is
mandatorily enforced onchain.

### 3.8 `refund()`

```solidity
function refund(bytes32 matchId) external nonReentrant {
    Match storage m = matches[matchId];
    if (m.state != MatchState.Locked) revert NotLocked(matchId);
    if (block.timestamp <= m.refundAfter) revert RefundTooEarly(m.refundAfter);
    m.state = MatchState.Refunded;
    balances[m.taker].committed -= m.amountFxrp;    // NEW — release the committed-exposure counter (§3.3/§3.6)
    BOND_LEDGER.slashBond(matchId, m.taker);       // 100% of 1% bond → honest taker's wallet
    FXRP.transfer(m.taker, m.amountFxrp);
    emit MatchRefunded(matchId, m.taker, m.amountFxrp, m.bondAmount);
}
```

Contracts cannot self-execute: "auto-refund" = permissionless `refund()` + the worker's refund
keeper calling it at `refundAfter + 1`; the taker UI also exposes a "Claim refund" button as the
trust-minimized path. **Residual risk, narrowed but not eliminated by the widened
`ATTESTATION_BUDGET` (§3.2):** `refund()` is still fully permissionless and always pays `m.taker`,
so a dishonest taker who waits and watches the XRPL ledger can still race their own `refund()` call
against the relayer's `release()` the instant `refundAfter` is crossed, if a maker pays inside the
last `ATTESTATION_BUDGET` seconds of the window. Widening the margin to 360 s (2×) makes this
require the maker to pay unusually close to the deadline rather than merely inside a 180 s tail, but
does not remove the incentive structure itself — see §14 for the accepted residual risk and the
UI's T−12 min warning (§7.2 module 4).

### 3.9 BondLedger

```solidity
contract BondLedger {
    IERC20 public immutable FXRP;
    address public owner;
    address public escrow;                          // one-shot setEscrow (deploy: BondLedger → DvPEscrow → setEscrow)
    struct LockedBond { address maker; uint128 amount; bool active; }
    mapping(address maker => uint256) public freeBond;      // getter read by engine ("availableBond")
    mapping(bytes32 matchId => LockedBond) public lockedBonds;

    function depositBond(uint256 amount) external nonReentrant;               // transferFrom(maker)
    function withdrawBond(uint256 amount) external nonReentrant;              // free portion only
    function lockBond(bytes32 matchId, address maker, uint256 amount) external; // onlyEscrow
    function releaseBond(bytes32 matchId) external;                            // onlyEscrow
    function slashBond(bytes32 matchId, address to) external;                  // onlyEscrow; transfer to honest side
    function setEscrow(address e) external;                                    // onlyOwner, one-shot
}
event BondDeposited(address indexed maker, uint256 amount);
event BondWithdrawn(address indexed maker, uint256 amount);
event BondLocked(bytes32 indexed matchId, address indexed maker, uint256 amount);
event BondReleased(bytes32 indexed matchId, address indexed maker, uint256 amount);
event BondSlashed(bytes32 indexed matchId, address indexed maker, address indexed to, uint256 amount);
error NotEscrow(); error EscrowAlreadySet(); error InsufficientFreeBond(uint256 need, uint256 have);
error BondNotActive(bytes32 matchId);
```

Concurrent matches per maker: each `lockBond` reserves from `freeBond`; a maker quoting N RFQs
needs `freeBond >= Σ(1% notional)`; the (N+1)-th lock reverts cleanly inside `lock()`. Slashing
transfers directly to the taker's wallet (funds pre-escrowed — maker insolvency impossible).

### 3.10 WhisperDeskInstructionSender

Modeled 1:1 on the scaffold's `HelloWorldInstructionSender`; constructor + `setExtensionId()` +
`_getExtensionId()` copied verbatim (DO NOT MODIFY). **Quotes never touch this contract**
(they go via `/direct`, §4.3) — the sender has exactly two functions:

```solidity
bytes32 public constant OP_TYPE_WD_RFQ        = bytes32("WD_RFQ");      // byte-identical in Go config
bytes32 public constant OP_COMMAND_RFQ_SUBMIT = bytes32("RFQ_SUBMIT");
bytes32 public constant OP_COMMAND_RFQ_MATCH  = bytes32("RFQ_MATCH");
// (OP_COMMAND_QUOTE_SUBMIT = bytes32("QUOTE_SUBMIT") exists in Go only — /direct ingress)

function submitRfq(bytes calldata ciphertext) external payable returns (bytes32 instructionId);
    // message = abi.encode(msg.sender, ciphertext)  — SENDER BINDING IS LOAD-BEARING SECURITY:
    // DataFixed carries no onchain sender; without this, a spoofed RFQ could drain a victim's
    // armed deposit to an attacker's XRPL address. The enclave takes party identity ONLY from
    // this envelope, never from decrypted plaintext.
function triggerMatch(bytes32 rfqId) external payable returns (bytes32 instructionId);
    // message = abi.encode(rfqId); permissionless, idempotent enclave-side

event SealedRfqSubmitted(bytes32 indexed instructionId, address indexed taker);
event MatchTriggered(bytes32 indexed instructionId, bytes32 indexed rfqId, address indexed caller);
```

Both functions: `getRandomTeeIds(_getExtensionId(), 1)` → `TeeInstructionParams{opType, opCommand,
message, cosigners: [], cosignersThreshold: 0, claimBackAddress: msg.sender}` →
`sendInstructions{value: msg.value}` (returns `bytes32 instructionId` — emitted in our events so
UI/keeper get it without parsing registry logs). Fee handling: amounts are `OperationFeesFacet`-
controlled and undocumented — **clients over-provide a small configured `msg.value` buffer;
`claimBackAddress = msg.sender` makes overpayment safe** (a `quoteInstructionFee()` view against
the diamond is v2 — do not block on an undocumented facet ABI). Source of truth: the `.sol` lives
in `contracts/src/`, is copied into the scaffold's `contracts/` before `pre-build.sh` (one-shot per
extension — finalize before running; `--force` = new extension id + `MachineManager.TooMany()`
hazards), then `./scripts/generate-bindings.sh`.

### 3.11 teeSigner lifecycle

TEE machines are stateless; the identity key regenerates on every boot (confirmed by Flare).
v1: `teeSigner` is constructor-set + `setTeeSigner` (owner), both rejecting `address(0)` (§3.4).
Fail-closed: until rotated, new locks fail signature verification; locked matches are unaffected
(settlement is fully onchain). Runbook `scripts/wd-rebind.sh`: restart stack →
`register-tee -command rRap` (capital R = fresh challenge) → read new teeID from proxy `/info` →
`setTeeSigner(newTeeId)` on the **canonical** escrow → UI refreshes the encryption key off the
`TeeSignerUpdated` event. This runbook is a staging/operational recovery procedure only — it is
**not** exercised live during the judged demo (§3.2, §7.5). The same script covers the full-reset
path if the `FlareTeeManager` diamond is redeployed (new `pre-build`/`post-build`, new
`EXTENSION_ID`). **v2 (documented, not built):** permissionless rotation gated by
`FlareTeeManager` MachineRegistry proof (machine active + registered for our extensionId) — not
meaningful under SIMULATED_TEE where every simulated stack shares codeHash `0x194844cf…`.

### 3.12 Threat model (summary table)

| # | Attack | Mitigation |
|---|---|---|
| 1 | Forged match (non-TEE signer) | `ecrecover` vs `teeSigner` over `WD_MATCH_V1` domain digest; recovered `address(0)` explicitly rejected (defense-in-depth); `teeSigner`/`newSigner` reject `address(0)` at the config layer (constructor + `setTeeSigner`) |
| 2 | Replay of valid instruction (same/malleated sig) | `matches[matchId]` one-shot; low-S check |
| 3 | Cross-network / cross-instance replay | `block.chainid` + `mi.escrow` inside signed preimage |
| 4 | Compromised enclave signs off-market price | onchain ±1% band vs live FTSOv2 at lock; loss ≤ 1% |
| 5 | Stale/zero oracle | timestamp ≤ 60 s, `mid18 > 0`, wei variant kills decimals bugs |
| 6 | Maker never pays | permissionless refund after window: principal + 100% of 1% bond → taker (widened 360 s attestation margin narrows, but does not eliminate, a taker-side race — §3.8/§14) |
| 7 | Wrong amount/address/tag on XRPL | exact `receivingAddressHash` + fresh tag + `receivedAmount ≥ xrpDrops` |
| 8 | Failed XRPL tx presented (`tecDST_TAG_NEEDED`) | `status == 0` required, checked BEFORE address compare |
| 9 | Payment reused across matches / pre-existing payment | unique tag counter + one-shot state + `blockTimestamp ≥ lockedAt` |
| 10 | Wrong ledger / attestation type | `sourceId == "testXRP"` + `attestationType == "XRPPayment"` pinned |
| 11 | Stale instruction ambush | `instructionExpiresAt` (+300 s) + live band re-check |
| 12 | Taker withdraws between match and lock | armed-deposit model (`armedUntil` time-lock) **+ independent `committed`-exposure counter, decremented only by `release()`/`refund()`**, so a withdraw can never touch funds backing an open `Locked` match regardless of `armedUntil` |
| 13 | RFQ identity spoofing | envelope `sender = msg.sender` written by the only authorized sender contract |
| 14 | Quote identity spoofing | EIP-712 maker signature verified in-enclave + bond check |
| 15 | Bond overextension via concurrent quotes | per-match reservation from `freeBond`, atomic revert |
| 16 | Reentrancy | transient `nonReentrant` + CEI; FXRP is a plain ERC-20 |
| 17 | TEE restart / key rotation mid-settlement | settlement state fully onchain; `setTeeSigner` restores matching only |
| 18 | Negative `int256` FDC amounts | sign-checked before cast |
| 19 | Registry fee griefing | `claimBackAddress = msg.sender`; fee never hardcoded |
| 20 | Owner abuse | `lockPaused` gates new locks only; release/refund/withdraw never pausable |
| 21 | Relayer withholds signed result | permissionless `lock()`; result persisted at proxy (14 d TTL) |
| 22 | FDC proof requested for one instance replayed against another (e.g. a shared taker XRPL r-address + colliding destination tag) | **NEW** — `release()` mandatorily requires `proof.data.requestBody.proofOwner == address(this)`; a proof is unusable outside the exact escrow instance it was requested for |

---

## 4. TEE Matching Engine (Go FCE extension)

Lives in the monorepo at `engine/` — a customized fork of `fce-extension-scaffold` (keeps the
scaffold's `pre-build`/`post-build`/compose machinery). **Dependency-layout gotcha, verified by
reading source (review finding):** the scaffold's `go.mod` (at `fce-extension-scaffold/`, i.e.
repo root) contains `replace github.com/flare-foundation/tee-node => ../../tee-node`. Given the
team's actual documented local clone puts `tee-node` as a direct **sibling** of the scaffold
(`D:\Belajar\Hackacton\fce\tee-node`, one level up — not two), this relative path resolves one
directory too high and does not exist as-is; it will also resolve to a different depth again once
the scaffold is copied into the monorepo's `engine/` subfolder. Separately, `tee-node`'s own
`go.mod` pins `github.com/flare-foundation/go-flare-common` at a specific pseudo-version fetched
over the network with **no** local replace, while `tee-node`/`tee-proxy` themselves track the
`develop` branch — a real version-drift risk if `develop` moves ahead of the pinned
`go-flare-common` API. **Both are handled as the literal first action of Step 3** (before any
WhisperDesk handler code is written): run `go build ./... && go test ./...` in a fresh checkout
against current `tee-node@develop` HEAD; fix the `replace` path to match wherever `tee-node`
actually lives relative to the final `engine/` location, or switch to a `go.work` workspace file
(more robust to monorepo reshuffling than a relative `replace`); document the exact required
sibling layout; re-run this check whenever `tee-node`/`tee-proxy` are re-pulled from `develop`.

### 4.1 Role & ground rules

The engine is the only component that ever sees plaintext RFQs/quotes. It holds **no funds and no
persistent state**; its single binding output is the TEE-signed `MatchInstruction` (§3.5).
Hard latency budget: tee-node calls `POST /action` with a **2-second HTTP client timeout**
(`ProxyTimeout`, verified in source) — **no synchronous RPC in any handler**; the only in-path
network calls are loopback (sign port). Handler contract per scaffold: HTTP 200 + `ActionResult`
(status 0 = error, 1 = success), 400 undecodable, 501 unroutable.

### 4.2 Op routing (one opType, three commands — each bound to exactly one ingress)

| opType | opCommand | Ingress | Sender auth | Purpose |
|---|---|---|---|---|
| `WD_RFQ` | `RFQ_SUBMIT` | onchain instruction ONLY | envelope `msg.sender` (chain) | taker submits sealed RFQ |
| `WD_RFQ` | `QUOTE_SUBMIT` | `POST /direct` ONLY | API key + in-enclave EIP-712 + bond check | maker streams/replaces sealed quote |
| `WD_RFQ` | `RFQ_MATCH` | onchain instruction (canonical); `/direct` fallback iff `WD_ALLOW_DIRECT_MATCH=true` | permissionless | deterministic match for one rfqId |

Strings byte-identical across Solidity `bytes32("…")`, Go config consts, and Go router
(`teeutils.ToHash` right-pads — same encoding, verified). Commands on the wrong ingress →
status 0 `WD_ERR_PATH`.

**Quote ingress decision: tee-proxy's existing opt-in `POST /direct` endpoint** (verified in
`tee-proxy/internal/server/external.go`), NOT onchain instructions. 60 s quote validity cannot
survive 10–30 s relay latency per refresh; per-quote gas is unpayable at streaming cadence; and
onchain quote calldata leaks per-maker quoting frequency/timing — the exact metadata the product
hides. Cost: quotes are proxy-censorable — acceptable because quotes are ephemeral advisory data
(censoring loses a trade, never funds) and the binding decision (`RFQ_MATCH`) stays chain-anchored.
The onchain-quote path is the documented fallback if `/direct` fails the Step 3 verification.
Proxy config addition (VPS): `[direct] enable = true, api_key_variable = "DIRECT_API_KEY",
api_key_optional = false, max_body_size = 4096` + `DIRECT_API_KEY` injected into `ext-proxy` env.
One shared key for demo makers (anti-spam gate, not the security boundary — the EIP-712 signature
is) + nginx rate-limit on `POST /direct`; per-maker keys are v2.

**Handler dispatch MUST branch on `Action.Data.Type` first** (grounded gotcha, verified by reading
`internal/extension/extension.go`: `processAction` currently calls
`processorutils.Parse[instruction.DataFixed](action.Data.Message)` unconditionally with no
`Data.Type` check. Review sharpened the failure mode: `DirectInstruction`'s JSON keys (`opType`,
`opCommand`, `message`) overlap with `DataFixed`'s (`opType`, `opCommand`, `originalMessage`) on the
first two fields, so a direct `QUOTE_SUBMIT` action's `opType`/`opCommand` **will** parse and route
correctly — it is specifically `OriginalMessage` that silently comes back empty, since `message` has
no matching key in `DataFixed`. Un-patched, this looks exactly like an ECIES/decrypt bug, not a
routing bug):

```go
switch action.Data.Type {
case teetypes.Direct:      // di.OPType/di.OPCommand, payload = di.Message (raw ECIES blob)
case teetypes.Instruction: // df.OPType/df.OPCommand, payload = df.OriginalMessage (ABI envelope)
}
```

A dedicated regression test locks in the *exact observed symptom*, not just the branch's existence:
feed a real `DirectInstruction` JSON through the un-patched dispatch path and assert specifically
that `OriginalMessage`/decrypt input comes back empty while `opType`/`opCommand` still match — see
§10 Go tests.

### 4.3 Sealed book & data structures

```go
type SealedBook struct {
    mu     sync.Mutex                                  // single lock; desk-scale contention is trivial
    rfqs   map[common.Hash]*RFQ                        // rfqId (= instructionId) → RFQ
    quotes map[common.Hash]map[common.Address]*Quote   // rfqId → maker → latest quote (replace-by-maker)
    epoch  uint64                                      // random per boot ("bookEpoch")
}
type RFQ struct {
    ID common.Hash; Taker common.Address
    FxrpAmountRaw uint64          // >= 5_000_000_000
    LimitPriceE18 *big.Int        // min acceptable USD/FXRP for the seller
    XrplAddress string            // in-enclave only until match
    ReceivedAt, WindowEndsAt, ExpiresAt time.Time
    Matched bool; Outcome *MatchOutcome                // idempotence cache
}
type Quote struct {
    RfqID common.Hash; Maker common.Address
    PriceE18 *big.Int; MaxFxrpRaw uint64; Nonce uint64
    ReceivedAt time.Time          // freshness clock: eligible iff matchNow − ReceivedAt < 60 s (strict)
    Seq uint64                    // global intake counter — deterministic tie-break
}
```

Lock discipline: handlers take `book.mu` once, pure in-memory work, release. All chain reads come
from `ChainReader` caches snapshotted **outside** the lock. Janitor goroutine (5 s tick) GCs
expired quotes/RFQs; never emits results. Book is ephemeral by design — restart safety in §4.7.

### 4.4 Chain reads (cached, never in-path)

- **FTSOv2:** background goroutine every 2 s: `eth_call getFeedByIdInWei(XRP_USD_FEED_ID)` at the
  address resolved once at boot via `FlareContractRegistry`. Match fails `WD_ERR_PRICE_STALE` if
  the cache is older than 60 s (fail-closed; keeper retries). The enclave band check is a fairness
  **prefilter** — the escrow re-checks authoritatively at lock, so enclave staleness can only cause
  a reverted lock, never a wrong lock. No relayer-supplied price hints (determinism for vectors).
- **Bond/deposit:** cached `eth_call` snapshots (5 s TTL) of `BondLedger.freeBond(maker)` and
  `DvPEscrow.balances(taker)` — no Indexer DB dependency in the engine. UX prefilters only; the
  escrow re-validates atomically.

### 4.5 Matching algorithm (deterministic, integer-only, `math/big`)

`RFQ_MATCH(rfqId)` under `book.mu`:
1. Guards: rfq exists (`WD_ERR_RFQ_UNKNOWN`); `now ≥ WindowEndsAt` (`WD_ERR_WINDOW_OPEN`); already
   matched → return cached outcome, status 1; price cache fresh; taker deposit snapshot sufficient.
2. Eligibility over `quotes[rfqId]`: fresh (`< 60 s`, strict), full size
   (`MaxFxrpRaw ≥ rfq.FxrpAmountRaw` — no partial fills in v1), in band
   (`|PriceE18 − midE18| × 10_000 ≤ 100 × midE18`, inclusive), beats limit
   (`PriceE18 ≥ LimitPriceE18`), bond snapshot ≥ 1% notional.
3. Winner: max `PriceE18`; tie-break min `Seq` (price-time priority).
4. No eligible quotes → **status 1** `{"outcome":"NO_MATCH","reasons":{…aggregate counts…}}`.
5. Build `MatchInstruction{matchId: rfqId, escrow: cfg.EscrowAddr, taker, maker, amountFxrp,
   priceUsd18: winner.PriceE18, takerXrplAddress, instructionExpiresAt: now + 300}`, ABI-pack
   (mirrors §3.5 tuple exactly), sign via sign port, **normalize V +27**, mark matched, cache,
   return status 1. The engine may compute `floor(amount × price / mid)` for its own logs/UI hint
   but **never emits or signs a drops figure** — the escrow's `MatchLocked.xrpDrops` is canonical.

The matcher core is a pure function `Match(book, rfq, mid, now)` — time and price are arguments
(no `time.Now()`, no RPC inside) — a design requirement imposed by the test layer.

### 4.6 Result delivery

`ActionResult{Status: 1, Data: JSON MatchResponse}` rides the standard path: proxy stores it
(instruction results keyed by instructionId, tag `threshold`, TTL 14 d; direct results tag
`submit`, TTL 30 min). Match keeper polls `GET /action/result/{instructionId}` of the
`triggerMatch` tx, extracts `(abiEncoded, teeSignature)`, calls `lock()` permissionlessly.
Matching is **trigger-driven** (keeper after window close), not timer-driven: results ride the
standard poll path, every match has an onchain trigger tx (audit anchor for judges), and the engine
stays passive — correct posture for a component that can die at any moment. Sign-port
`POST /result` async push is the documented v2 upgrade for timer-driven matching.

### 4.7 Statelessness & restart safety

Invariant: **no value moves on any path that does not carry a TEE-signed `MatchInstruction`, and
once locked, every fund-bearing deadline lives onchain.**
- Restart before match: book vanishes; nothing was locked; takers resubmit (new instructionId ⇒
  new rfqId), makers keep streaming. Old ciphertexts are undecryptable (new key) — clean epoch.
- Restart between signing and lock: the signed result is persisted at the proxy — keeper still locks.
- Restart after lock: escrow + FDC + deadline only; engine plays no role.
- Double-match: `matches[rfqId]` one-shot even if a re-signed duplicate exists.
- The engine performs **no writes anywhere** (no DB, no disk).

### 4.8 Error codes (closed enum — never echo field values)

`WD_ERR_PATH · WD_ERR_DECODE · WD_ERR_DECRYPT · WD_ERR_AUTH · WD_ERR_SIDE · WD_ERR_MIN_SIZE ·
WD_ERR_BOND · WD_ERR_TAKER_FUNDS · WD_ERR_RFQ_UNKNOWN · WD_ERR_WINDOW_OPEN · WD_ERR_STALE_NONCE ·
WD_ERR_PRICE_STALE · WD_ERR_SIGN · WD_ERR_PAD` — status 0, `Data = nil`, `Log = "WD_ERR_<CODE>"`.
Success payloads: `RfqAck{rfqId, windowEndsAt}`, `QuoteAck{rfqId, accepted, replaced}` (no price
echo — acks must not leak), `MatchResponse` (§6). Intake-command results are publicly fetchable by
actionId, so acks are bare by contract.

### 4.9 Config knobs (env; policy values may only be tightened, guarded at `init`)

| Env | Default | Meaning |
|---|---|---|
| `EXTENSION_PORT` / `SIGN_PORT` | 7702 / 7701 | compose-provided |
| `CHAIN_URL` / `CHAIN_ID` | Coston2 RPC / 114 | compose-provided |
| `WD_ESCROW_ADDR` / `WD_BOND_ADDR` | required | canonical instance address (single deployment, v0) |
| `WD_REGISTRY_ADDR` | `0xaD67FE…6019` | FlareContractRegistry |
| `WD_MIN_BLOCK_FXRP_RAW` | `5000000000` | policy |
| `WD_QUOTE_TTL_SEC` | `60` | policy-locked |
| `WD_BAND_BPS` | `100` | policy, inclusive |
| `WD_RFQ_WINDOW_SEC` / `WD_RFQ_TTL_SEC` | `60` / `900` | auction window (demo: 30) / book GC |
| `WD_PRICE_REFRESH_SEC` / `WD_PRICE_STALE_MAX_SEC` | `2` / `60` | FTSO cache / fail-closed bound |
| `WD_CHAIN_SNAPSHOT_TTL_SEC` | `5` | bond/deposit snapshot TTL |
| `WD_ALLOW_DIRECT_MATCH` | `true` | demo keeper fallback without gas |
| `WD_PAD_SIZE` | `512` | exact plaintext padding (others rejected) |

`GET /state` (port 7702, **not published** in compose; optionally proxied read-only by the UI
backend): aggregates only — `bookEpoch, bootTime, teeSigner, chainId, openRfqCount,
activeQuoteCount, matchedTotal, noMatchTotal, ftsoMidE18, ftsoMidAgeSec, rpcHealthy, errorCounts`.

---

## 5. Encryption & Keys

### 5.1 Primitives (verified in tee-node source)

| Primitive | Implementation |
|---|---|
| Curve | secp256k1 (go-ethereum) — identity, signing, ECIES |
| TEE identity key | `crypto.GenerateKey()` at boot; RAM-only; `teeID = address(pubkey)` |
| Signing (`POST /sign`) | `keccak256(message)` → EIP-191 (`accounts.TextHash`) → ECDSA; **V ∈ {0,1}**, low-S canonical |
| ECIES (`POST /decrypt`) | go-ethereum `crypto/ecies`, `ECIES_AES128_SHA256`: ConcatKDF(SHA-256) + AES-128-CTR + HMAC-SHA-256, `s1=s2=nil` |
| ECIES wire format | `0x04‖X(32)‖Y(32) ‖ IV(16) ‖ ct ‖ HMAC(32)` — fixed 113 B overhead |
| Sign port | `127.0.0.1:{SIGN_PORT}` (compose sets 7701), loopback-only, unauthenticated (TEE boundary = container) |
| Wire gotcha | `SignRequest.Message` is Go `[]byte` → **base64 in JSON**, not `0x` hex; always marshal via `tee-node/pkg/types` |

WhisperDesk uses zero PMW wallets — only plain `/sign` and `/decrypt` with the identity key.

### 5.2 TEE public-key discovery & authenticity (anti-MITM)

**Root of trust for clients = `DvPEscrow.teeSigner`, not the proxy.** Client flow:
1. `teeSigner = escrow.teeSigner()` (onchain read).
2. `info = GET {EXT_PROXY_URL}/info` → full pubkey `{x, y}`.
3. Require `address(keccak256(X‖Y)[12:]) == teeSigner` — **the binding check**. A proxy/DNS
   hijacker serving a fake key cannot make it hash to the escrow-pinned address; a fake-key
   ciphertext is garbage to the real enclave; a fake enclave's matches fail `ecrecover`.
4. Optional defense-in-depth: recover `info.dataSignature` over the `TEE_MACHINE_REGISTER` payload.
Escrow pinning (vs trusting the machine registry) is deliberate: under SIMULATED_TEE every stack
shares `TestCodeHash 0x194844cf…`, so registry membership proves nothing in demo mode.

### 5.3 Client-side sealing

- Browser lib must be **go-ethereum-compatible**: `ecies-geth` (npm) first choice; default
  `eciesjs` (AES-256-GCM/HKDF) is **incompatible** and fails silently. Fallback: ~80-line port
  over `@noble/curves` + WebCrypto. **Acceptance gate either way (Step 3/4 DoD): golden-vector
  round-trip** — TS-encrypt fixture → live `POST /decrypt` returns byte-identical plaintext, and a
  committed TS-encrypted fixture decrypts in Go unit tests.
- **Fixed-size padding:** plaintext JSON padded with trailing spaces to exactly 512 B before
  encryption (calldata is public; ciphertext length must not leak order-size magnitude). Engine
  rejects non-512-B plaintexts (`WD_ERR_PAD`).
- **RFQ envelope (onchain):** `message = abi.encode(address msg.sender, bytes ciphertext)` —
  written by the sender contract, decoded by the engine, which requires `plaintext.taker ==
  envelope.sender`. (Timestamp field dropped — `DataFixed` already carries one.)
- **Quote transport (direct):** `DirectInstruction.message` = the raw ECIES blob (hex). Maker
  authentication is the in-payload EIP-712 signature (§6.2) + bond check; API key is anti-spam only.

### 5.4 Replay & binding (layered)

| Attack | Defense |
|---|---|
| Instruction re-delivery to node | protocol-level: instructionId uniqueness + >50% FSP weight (free from tee-node) |
| Ciphertext copied from calldata, resubmitted by another sender | envelope binds `msg.sender`; enclave requires `plaintext.taker == sender` → generic reject |
| Taker replays own RFQ ciphertext | harmless — new instructionId = new rfqId = a fresh RFQ (resubmission semantics); no nonce-LRU needed |
| Quote blob replay | idempotent replace of the same `(rfqId, maker)` slot; cross-RFQ impossible (rfqId is EIP-712-signed); stale nonce rejected |
| Cross-deployment / cross-chain | quote EIP-712 domain binds `chainId=114` + `verifyingContract=escrow`; match digest binds chainId + escrow |
| Pre-restart ciphertexts | new boot key ⇒ ECIES MAC fails ⇒ undecryptable by construction |
| Match instruction replay to escrow | one-shot `matches[matchId]` + escrow/chainId in digest + `instructionExpiresAt` |
| FDC proof requested against one instance replayed against another | `release()` mandatorily requires `proof.data.requestBody.proofOwner == address(this)` (§3.7) |

### 5.5 Never logged / never persisted (hard invariants)

1. Decrypted plaintext bytes exist only in the engine process — never in `ActionResult.Log/Data`
   (error paths return `Data=nil` + closed-enum code), stdout, `/state`, Redis, or Neon.
2. Neon mirrors public onchain events only (schema invariant, `db/schema.sql`).
3. Types-server decode registry (8100): envelope + public messages only — never plaintext schemas.
4. Public-by-design at lock: taker, maker, size, price, XRPL destination, tag — the escrow enforces
   them. Pre-trade privacy of the unmatched book is the product promise (Bounty 2 writeup line).
5. Enforced mechanically: CI leak-scan greps logs/results/state from golden failure vectors for
   fixture plaintext substrings (zero hits) + `scripts/check-privacy.sh` + zod `.strict()` schemas.

---

## 6. Message Formats (canonical wire table)

### 6.1 RFQ plaintext (JSON, `DisallowUnknownFields`, space-padded to 512 B, then ECIES)

```json
{"v":1, "taker":"0x…20B", "side":"SELL_FXRP", "fxrpAmountRaw":"5000000000",
 "limitPriceUsdE18":"3050000000000000000", "xrplAddress":"rLLsk7Ac3e…"}
```
`taker` must equal the envelope sender (chain-authenticated; inner field only prevents blob-swap
confusion). v1 accepts `SELL_FXRP` only (`BUY_FXRP` → `WD_ERR_SIDE`, explicit v2).

### 6.2 Quote plaintext (JSON, padded to 512 B, then ECIES; via `POST /direct`)

```json
{"v":1, "rfqId":"0x…32B", "maker":"0x…20B", "priceUsdE18":"3070000000000000000",
 "maxFxrpRaw":"10000000000", "nonce":"7", "sig":"0x…65B"}
```
`sig` = EIP-712 by the maker over `Quote(bytes32 rfqId,address maker,uint256 priceUsdE18,
uint256 maxFxrpRaw,uint256 nonce)` with domain `{name:"WhisperDesk", version:"1", chainId:114,
verifyingContract:<engine's WD_ESCROW_ADDR>}`. Higher nonce replaces; equal/lower →
`WD_ERR_STALE_NONCE`. Prices are **USD per XRP (= per FXRP at par), 18 decimals** everywhere.

### 6.3 MatchInstruction & signature — see §3.5 (single canonical definition)

### 6.4 Engine result payloads (`ActionResult.Data`, status 1)

```go
type RfqAck   struct { RfqID string `json:"rfqId"`; WindowEndsAt uint64 `json:"windowEndsAt"` }
type QuoteAck struct { RfqID string `json:"rfqId"`; Accepted bool `json:"accepted"`; Replaced bool `json:"replaced"` }
type MatchResponse struct {
    Outcome      string         `json:"outcome"`                // "MATCHED" | "NO_MATCH"
    Reasons      map[string]int `json:"reasons,omitempty"`      // NO_MATCH aggregate filter counts
    Match        *MatchWire     `json:"match,omitempty"`        // decoded fields, hex/dec strings
    AbiEncoded   string         `json:"abiEncoded,omitempty"`   // 0x… exact signed bytes = lock() arg 1
    TeeSignature string         `json:"teeSignature,omitempty"` // 0x… 65 B, V already 27/28 = lock() arg 2
}
```

### 6.5 HTTP surface (all grounded in source)

```
# Sign port (loopback, tee-node, :7701) — []byte fields are base64 in JSON
POST /decrypt  {"encryptedMessage": <b64>}  -> {"decryptedMessage": <b64>}
POST /sign     {"message": <b64>}           -> {"message":…, "signature": <65B, V in {0,1}>}

# Extension (internal-only, :7702)
POST /action  <teetypes.Action>  -> 200 ActionResult | 400 | 501
GET  /state   -> StateResponse (aggregates only)

# tee-proxy external (:6674, public via VPS nginx https://fce.srv1330754.hstgr.cloud)
GET  /info                                  # signed TeeInfo: pubkey{x, y}, codeHash, platform, teeID
POST /direct                                # header X-API-Key; body {"opType":"0x<WD_RFQ padded>",
                                            #  "opCommand":"0x<QUOTE_SUBMIT padded>", "message":"0x<ECIES blob>"}
                                            # -> echoes Action incl. data.id (random actionID)
GET  /action/result/{instructionId}         # instruction results, default tag threshold, TTL 14 d
GET  /action/result/{actionID}?submissionTag=submit   # direct results, TTL 30 min
POST /instruction                           # FSP data-provider relay (not called by us)

# FDC pipeline (relayer)
POST https://fdc-verifiers-testnet.flare.network/verifier/xrp/XRPPayment/prepareRequest
  X-API-KEY: 00000000-0000-0000-0000-000000000000
  {"attestationType":"0x5852505061796d656e74…00","sourceId":"0x74657374585250…00",  // "testXRP" right-pad, NEVER "XRP"
   "requestBody":{"transactionId":"0x<xrpl tx>","proofOwner":"<escrow addr>"}}
   // proofOwner MUST equal the target DvPEscrow address — release() now mandatorily enforces this
   // onchain (WrongProofOwner revert, §3.7), not merely as an FDC convention.
onchain: fee = IFdcRequestFeeConfigurations.getRequestFee(req) (try/catch); IFdcHub.requestAttestation{value: fee}(req)
POST https://ctn2-data-availability.flare.network/api/v1/fdc/proof-by-request-round
  {"votingRoundId": n, "requestBytes":"0x…"}  -> {"response": <IXRPPayment.Response>, "proof": [..]}   // retry n±1 on 400
```

Constants: XRP/USD feed `bytes21 0x015852502f55534400000000000000000000000000`; sourceId
`bytes32("testXRP") = 0x7465737458525000…00`; `FlareContractRegistry
0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`; `FlareTeeManager` diamond
`0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` (verify before demo — redeploys wipe everything).
`FdcVerification`: resolve via the registry, never hardcode — `flare-docs/fdc.md` and
`flare-docs/fdc-request-fee.md` currently disagree on this address (§3 intro); the registry call is
authoritative regardless of which doc is stale.

---

## 7. Backend & Web

Monorepo (pnpm workspaces): `web/` (Next.js 15 App Router, wagmi v2 + viem, TanStack Query,
Tailwind) · `services/worker/` (whisper-worker, Node 24 TS, one process) · `packages/shared/`
(generated ABIs, addresses, zod schemas, ecies helper) · `scripts/demo/` (demo runner) ·
`contracts/` (Foundry) · `engine/` (Go) · `db/` (schema + migrations) · `testdata/`.

### 7.1 Pages

- **`/trade` (taker):** connect → FXRP balance + escrow armed balance (client-direct reads) →
  `approve` + `deposit(amount, armedUntil = RFQ TTL + 5 min)` → RFQ form (side fixed SELL_FXRP,
  size ≥ 5,000 FXRP client-validated, limit USD, XRPL r-address) with live FTSOv2 mid + ±1% band
  rendered (client-direct `getFeedByIdInWei`, registry-resolved) → seal (ECIES, 512-B pad) →
  one tx `submitRfq(ciphertext){value: feeBuffer}` → store `instructionId` (from
  `SealedRfqSubmitted`) in localStorage → poll `/api/tee/result/{id}` → on match, deep-link
  `/settlements/{matchId}`. **Note:** `armedUntil` only governs eligibility to open *new* locks and
  to withdraw *uncommitted* funds; once a match is `Locked`, the FXRP backing it is tracked by the
  separate `committed` counter (§3.3) and stays reserved regardless of whether `armedUntil` has
  since elapsed.
- **`/desk` (maker):** bond card (`freeBond`, deposit/withdraw txs; red when a target quote's 1%
  exceeds free bond) → quote composer (price, max size, fixed 60 s validity countdown; "Stream"
  toggle re-signs + re-POSTs a fresh sealed quote every ~25 s) → sealed quote goes
  browser → nginx → proxy `POST /direct` (CORS configured in the nginx server block; fallback:
  `/api/tee/direct` pass-through — ciphertext only, invariant intact) → payment card after
  `MatchLocked`: r-address, tag, **exact drops from the event**, deadline countdown; demo buttons
  "Pay from demo maker wallet" (`POST /api/demo/pay`) and "Simulate default" (both operate on the
  same canonical escrow — no second deployment, §3.2).
- **`/settlements`, `/settlements/[matchId]`:** the judge-facing DvP stepper
  (`locked → xrpl_seen → attestation_requested → proof_submitted → released` /
  `deadline → refunded+slashed`), tx hashes as explorer links (Coston2, XRPL testnet, FDC round →
  systems explorer), Neon rows polled 3 s + client-direct cross-check of escrow state so the
  tracker is honest even if the worker lags. Manual "paste XRPL tx hash" fallback (validated
  against XRPL JSON-RPC before insert).
- **`/tape`:** `GET /api/tape` — v0 (§13.1): serves recent `released` settlements live behind a
  `demo` flag (no cron, no 24 h delay). v2 (full design): only `daily_tape` rows with
  `published_at IS NOT NULL` (24 h rule enforced in SQL, twice: aggregator publish + API filter).

Read/write split: all wallet writes and trust-critical fresh reads are client-direct viem;
lists/history via API routes → Neon; tee-proxy consumed via `/api/tee/info` (cached 60 s, includes
the §5.2 binding check server-side as a hint — the client re-verifies) and
`/api/tee/result/[id]` pass-through. No API route ever accepts order data; the only POSTs are
demo-pay and the public xrpl-tx-hash fallback.

### 7.2 whisper-worker modules (one container beside the FCE stack; crash-restart safe, resumes from Neon)

1. **Chain indexer** — 4 s tick, `eth_getLogs` over `[DvPEscrow, BondLedger, Sender]` from
   `indexer_cursor.last_block − 5` (re-scan overlap); consumes `SealedRfqSubmitted`,
   `MatchTriggered`, `MatchLocked`, `MatchReleased`, `MatchRefunded`, `Bond*`. Idempotent upserts
   keyed by matchId with a status-precedence map (`locked=10 < xrpl_seen=20 <
   attestation_requested=30 < proof_submitted=40 < released/refunded/slashed=50`) — status never
   moves backwards; cursor advances per committed batch.
2. **Match keeper** — on `SealedRfqSubmitted`, schedules `triggerMatch(rfqId)` at
   `txTime + WD_RFQ_WINDOW_SEC + 5 s` (relayer wallet pays; `WD_ALLOW_DIRECT_MATCH` fallback when
   C2FLR is short); then polls `GET /action/result/{triggerInstructionId}` (2 s × 15 tries),
   and on `outcome == "MATCHED"` submits `escrow.lock(abiEncoded, teeSignature)`. Only status-1
   results are ever submitted.
3. **XRPL watcher** — one WSS (`wss://s.altnet.rippletest.net:51233`), subscribes to dest accounts
   of `locked` settlements; on validated `Payment` with matching `DestinationTag` and
   `meta.delivered_amount ≥ xrpDrops` (never `Amount` — partial-payment safety) → `xrpl_seen`,
   enqueue `fdc_jobs` row.
4. **FDC relayer** — persisted state machine per `fdc_jobs` row:
   `await_finality (≥3 validations ≈ 12 s) → requested (prepareRequest with requestBody.proofOwner
   = escrow address → getRequestFee → requestAttestation exact msg.value; votingRoundId =
   ⌊(ts − firstVotingRoundStartTs)/90⌋, epoch start read from chain at boot) → polling_da (+60 s,
   10 s cadence, roundId±1 on 400; 6 min timeout → max 2 re-requests) → proof_ready → submitted
   (escrow.release, 3× retry) → done`. Proof cached forever in `proof_json`. Hard stop: no new
   requests after `paymentDeadline − 90 s`; maker UI shows a "pay before T−12 min" warning (≈2×
   slack vs the widened 360 s attestation-safety margin, §3.2/§3.8) — narrower than before this is
   not: the underlying race is documented as a residual risk in §14, not eliminated.
5. **Refund keeper** — `refund(matchId)` at `refundAfter + 1 block` for unsettled rows
   (permissionless; taker UI has a self-serve button).
6. **XRPL demo payment helper** — docker-network-only HTTP (`POST /internal/pay {matchId, mode}`,
   `X-Demo-Key`); reads payment data from the escrow/event, submits exact drops + tag from
   `XRPL_MAKER_SEED`; `mode:"default"` = deliberate no-op for the failure narrative, run against the
   **same canonical escrow** as the happy path (§3.2, §7.5) — no second deployment.
7. **Tape aggregator** — v0 (§13.1): cut; `/api/tape` reads recent `released` rows live behind the
   `demo` flag. v2 (full design): hourly cron upserts `daily_tape` from `released` settlements;
   sets `published_at` only when `trade_day + 24 h ≤ now()`.

### 7.3 API routes (public-data only; zod `.strict()` schemas shared client/server)

```
GET  /api/settlements?status=&address=&limit&cursor   -> SettlementRow[]
GET  /api/settlements/[matchId]                       -> SettlementRow & { fdcJob? }
POST /api/settlements/[matchId]/xrpl-tx  {txHash}     # validated vs XRPL JSON-RPC (public data)
GET  /api/tape                                        -> v0: recent released rows (demo flag); v2: published daily aggregates only
GET  /api/tee/info                                    -> {teeId, codeHash, platform, publicKey{x,y}, simulated} (60 s cache)
GET  /api/tee/result/[id]                             -> ActionResponse pass-through
POST /api/tee/direct                                  -> ciphertext pass-through to proxy /direct (CORS fallback only)
POST /api/demo/pay  {matchId, mode:'pay'|'default'}   # DEMO_MODE only; forwards X-Demo-Key to worker
```

### 7.4 Env matrix (secrets only via `.env`, gitignored)

| Var | Local | Vercel | VPS worker |
|---|---|---|---|
| `NEXT_PUBLIC_CHAIN_ID/RPC_URL/ESCROW/BOND/SENDER` | ✓ | ✓ | ✓ (non-public names) |
| `DATABASE_URL` | Neon dev branch | Neon prod (server-only) | Neon prod |
| `TEE_PROXY_URL` | localhost:6674 | `https://fce.srv1330754.hstgr.cloud` | `http://ext-proxy:6664` |
| `DIRECT_API_KEY` | dev key | — (maker pastes into console, localStorage) | proxy env |
| `RELAYER_PRIVATE_KEY` / `XRPL_MAKER_SEED` / `XRPL_WSS` | `.env` | **never** | VPS `.env` only |
| `VERIFIER_URL/API_KEY` / `DA_LAYER_URL` | testnet defaults | — | relayer only |
| `DEMO_MODE` / `DEMO_API_KEY` | ✓ | ✓ | ✓ |
| `WD_INSTRUCTION_FEE_BUFFER` | small C2FLR buffer | ✓ | ✓ (claim-back makes overpay safe) |

Note: the prior `NEXT_PUBLIC_DEMO_ESCROW` var for a second deployment is removed — v0 has a single
canonical escrow (§3.2/§13.1).

### 7.5 Demo runner (`pnpm demo` / `scripts/demo.sh`, reuses `packages/shared` — same code paths as the UI)

1. **Preflight:** RPC height; proxy `/info` reachable + pubkey↔teeSigner binding holds + codeHash
   `0x194844cf…`; Neon reachable; wallet balances (C2FLR, FXRP, XRPL accounts); verifier ping.
   Each of the stages below carries an **explicit per-stage timeout**; on any timeout, the runner
   aborts the live segment and switches to a pre-recorded fallback transcript/proof fixture from
   that point, rather than silently running past the judged window (documented intended behavior;
   implementing the abort-and-fallback logic itself is Step 6/7 work — see §14).
2. **Happy path** (canonical escrow): bond → deposit → sealed RFQ → streamed quote → trigger →
   assert `MatchLocked` → demo payment → relayer through `released` → print tracker URL + all
   explorer links.
3. **Default path — SAME canonical escrow as the happy path** (no second live deployment, no live
   TEE restart/re-bind during the judged window — a prior draft's `demo-default (240,120)` instance
   plus a live `wd-rebind.sh` step is cut per §3.2/§13.1): RFQ/quote round with `mode:"default"`
   (maker deliberately skips payment) → either (a) staging/rehearsal runs use a documented
   time-warp test helper that fast-forwards a local anvil fork's `block.timestamp` past
   `refundAfter`, or (b) the judged/live demo plays a pre-recorded transcript of a prior real-time
   run (real `SETTLEMENT_WINDOW=1800 s` / `ATTESTATION_BUDGET=360 s` clock, captured once
   end-to-end with its FDC proof committed as a fixture) → assert `MatchRefunded` + `BondSlashed`
   either way.
4. `--assert` mode adds hard state/balance/event assertions per stage; emits a timestamped
   markdown transcript (submission evidence).

---

## 8. ERD & Data

**Invariant:** Neon holds public data only — everything reconstructible from Coston2 logs. Existing
`settlements` + `daily_tape` stay; `settlements.escrow_id` column (kept for schema continuity)
stores the **matchId**. Migration `db/migrations/0002_tracker_fields.sql`:

```sql
ALTER TABLE settlements DROP CONSTRAINT settlements_status_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_status_check CHECK (status IN
  ('locked','xrpl_seen','attestation_requested','proof_submitted','released','refunded','slashed'));
ALTER TABLE settlements
  ADD COLUMN fxrp_provider_addr TEXT,       -- taker (from MatchLocked, public)
  ADD COLUMN xrp_payer_addr     TEXT,       -- maker
  ADD COLUMN xrpl_dest_address  TEXT,       -- watcher subscription + maker payment card
  ADD COLUMN dest_tag           BIGINT,
  ADD COLUMN drops_expected     BIGINT,     -- xrpDrops from MatchLocked (single source of truth)
  ADD COLUMN price_used_e18     NUMERIC(38,0);
CREATE INDEX idx_settlements_parties ON settlements (fxrp_provider_addr, xrp_payer_addr);

CREATE TABLE IF NOT EXISTS fdc_jobs (
  escrow_id  TEXT PRIMARY KEY REFERENCES settlements(escrow_id),
  xrpl_tx_hash TEXT NOT NULL,
  abi_encoded_request TEXT, voting_round_id BIGINT,
  proof_json JSONB,                          -- cached; proofs valid forever
  state TEXT NOT NULL CHECK (state IN ('await_finality','requested','polling_da','proof_ready',
                                       'submitted','done','expired','failed')),
  attempts INT NOT NULL DEFAULT 0, last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS indexer_cursor (
  id TEXT PRIMARY KEY,                       -- 'coston2'
  last_block BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
```

ERD: `settlements 1—N fdc_jobs`; `daily_tape` derived (v0: unused, live query instead per §13.1;
v2: daily aggregates, `published_at` NULL until +24 h); `indexer_cursor` singleton. Status mapping:
`MatchRefunded` with `bondSlashed > 0` (always in v1) → `slashed`; `refunded` kept in the enum for
compatibility. **Cut** (v2): the `makers` and `instructions` mirror tables — maker bond is a
client-direct read; instruction status lives in localStorage + proxy polling. Explicitly absent
forever: plaintext RFQs/quotes, pre-match counterparty↔order mapping, seeds/keys, sealed-book
contents. **Neon stays** (Vercel API routes need a publicly reachable DB); a VPS Postgres swap is a
`DATABASE_URL` change if ever needed.

---

## 9. Deployment Topology

### 9.1 Local dev (Windows + WSL2; scripts are POSIX bash)

FCE compose (redis 6382, ext-proxy 6673/6674, extension-tee with 7701/7702 in-container);
`LOCAL_MODE=true` for fast handler iteration; Coston2 e2e via `./scripts/use-chain.sh coston2 go`
→ `LOCAL_MODE=false, SIMULATED_TEE=true, MODE=1`. `EXT_PROXY_URL` (tunnel or VPS) set **before**
pre-build/start-services/test. Foundry in WSL; anvil fork for contract tests (also used for the
time-warp default-path test helper, §7.5); deploys go to Coston2. Indexer DB creds
(34.38.42.208:3306, peer-provided, verified working) in the proxy TOML (gitignored). As the literal
first action of Step 3: `go build ./... && go test ./...` against a fresh `tee-node@develop` clone,
before any handler code (§4 preamble) — this catches both the scaffold's `go.mod` relative-path
mismatch and `go-flare-common` version drift while there is still schedule slack.

### 9.2 Demo (judge-facing)

```
Vercel (Next.js UI + API) ── Neon (public mirror)
        │ https
VPS srv1330754.hstgr.cloud (Ubuntu 24.04, existing nginx :443 — add server block only)
  fce.srv1330754.hstgr.cloud → proxy_pass http://127.0.0.1:6674  (certbot TLS)
  docker compose (~/whisperdesk): redis (lo:6382) · ext-proxy (BIND 127.0.0.1:6673/6674 —
  nginx is the ONLY public door; override compose 0.0.0.0 default) · extension-tee
  (CHAIN_ID=114, MODE=1) · whisper-worker (no published ports; all hot keys in VPS .env)
  EXT_PROXY_URL=https://fce.srv1330754.hstgr.cloud set BEFORE pre-build (replaces ngrok)
  DO NOT TOUCH: sos-pg, backend:8080, 9router:32768, traefik (pre-existing)
```

Deploy order (Step 1): resolve FXRP/FtsoV2/FdcVerification via ContractRegistry in the deploy
script → `BondLedger(FXRP)` → `DvPEscrow(…, 1800, 360)` → `setEscrow`. **No second (demo-default)
deployment in v0** (§3.2/§13.1) — the failure-path demo reuses this same canonical instance.
Everything recorded in `.claude/context/deployments.md` (addresses, network, tx hashes —
mandatory submission item). Judges touch only the Vercel URL + the one-command demo runner.

---

## 10. Testing & CI Strategy

Built around the highest-probability disaster: **cross-language encoding drift** on the
`MatchInstruction`/`WD_MATCH_V1` chain. Three lanes:

- **Fast lane (every push, < 3 min, no network):** forge unit + fuzz + invariant + vector parity
  (Foundry + Go, v0 — see below); Go unit (matcher tables, ECIES fixtures, sign vectors); vitest
  (routes, FDC fixtures); ABI-drift check; privacy guard. Merge gate.
- **Fork lane (push to main, ~1 min):** anvil fork of Coston2 with **recorded FDC proofs**
  (valid forever — the Step 2 spike output becomes a permanent deterministic regression test for
  the full release path) + real-FtsoV2 sanity. Gate on main.
- **Slow lane (manual / optional nightly):** `demo.sh --assert` on live Coston2 + XRPL + real FDC
  round. **Never a merge gate**; manual runbook is load-bearing, automation nice-to-have.

Key artifacts:
- **Golden vectors** (`testdata/vectors/`, generated ONLY by `engine/cmd/genvectors` using the
  production encoder + a public throwaway key `keccak256("whisperdesk-vector-key-1")`,
  RFC-6979-deterministic): full chain `fields → abi.encode(MatchInstruction) → dataHash →
  WD_MATCH_V1 message → payloadHash → EIP-191 digest → signature → signer`. Because the escrow
  verifies `WD_MATCH_V1` (not `ActionResult`), **genvectors needs no go-flare-common dependency**
  and the vectors are fully self-contained. Positive set (min-size, max-realistic, r-address edge
  chars) + negatives (wrong chainId 14, wrong escrow, tampered amount, expired). **v0 consumers
  (§13.1): Foundry (`VectorParity.t.sol` exercising the production `WdMatchVerifier` library linked
  by `DvPEscrow`) and Go (`internal/sign/vectors_test.go`, per-step hex equality) only.** The TS
  consumer (vitest via viem) and the `vectors-fresh` CI job that regenerates + `git diff
  --exit-code` are **v2** — deferred to protect the 19-day budget (§13.1); this narrows v0's
  cross-language parity assurance to Solidity+Go, see §14.
- **Foundry:** mocks (`MockFxrp` **6 decimals** — an 18-dec mock would hide the off-by-1e12 bug
  class; `MockFtsoV2` wei-variant + fee; `MockFdcVerification` + hand-built `Proof` structs
  including a `proofOwner` field for the new §3.7 check; TEE signer via `vm.sign` over the exact
  §3.5 chain). Unit: happy lock→release; refund+slash; band at exactly ±1.00% (inclusive) and
  1.0001× (revert); stale/zero oracle; replayed matchId; wrong signer/escrow/chain; zero-address
  recovered signer (forged garbage signature); zero-address `teeSigner`/`newSigner` rejected at
  construction and rotation; high-S; expired instruction; below min block; wrong/missing tag;
  `status == 2` tec-trap; 1-drop-short; payment before lock / after paymentDeadline; release-after-
  refund and vice versa; **armed-balance edges — including: `withdraw()` must revert
  `ExceedsUncommitted` while `committed > 0` backs an open `Locked` match, independent of and even
  after `armedUntil` has expired**; wrong/missing `proofOwner` on `release()` (`WrongProofOwner`);
  bond accounting under N concurrent matches; drops floor-rounding vectors shared with Go. Fuzz:
  band ⇔ equivalence, bond conservation, deadline warp, min-size, committed ≤ armed at all times.
  Invariants (load-bearing: I1, I4): I1 no release without a true verifier result for that match's
  (addressHash, tag, drops) **and matching `proofOwner`**; I2 escrow balance = Σ open;
  **I2′ `committed[taker] ≤ armed[taker]` always, and `committed` exactly equals the sum of
  `amountFxrp` over that taker's open `Locked` matches**; I3 one-way state machine; I4 locked bonds
  ≥ Σ 1% of open notional; I5 conservation.
- **Go:** matcher table tests on the pure `Match(book, rfq, mid, now)` (boundary pins: quote age
  == 60 s excluded; band inclusive at ±1.00%; 4,999.999999 rejected; tie by Seq; stale-mid refuse);
  ECIES round-trip + TS-encrypted fixture decrypted by Go (catches the eciesjs incompatibility;
  decrypt-direction because ECIES is non-deterministic); **`DirectInstruction`-as-`DataFixed`
  regression asserting the exact observed symptom — `OriginalMessage` comes back empty while
  `opType`/`opCommand` still match — not just that the `Data.Type` branch exists**, since the two
  structs' JSON keys overlap enough to make routing look correct even when un-patched; EIP-712
  wrong-domain; sign-port client via `httptest` (port from env only).
- **Integration:** `scripts/loop-test.sh` (local/VPS only — needs indexer creds; asserts
  `LOCAL_MODE=false, SIMULATED_TEE=true, MODE=1`): live Coston2 instruction → sealed RFQ + /direct
  quote → trigger → poll result → `lock()` on an anvil fork of Coston2 (real FtsoV2 state) →
  recorded-proof `release()` (proof fixture carries a matching `proofOwner`). This one script is
  the Step 3 + Step 5 DoD machine, including the **golden gate**: `ecrecover` of a live-signed
  result == `/info` teeID before anything builds on the digest chain (`WdMatchVerifier` functions
  kept `internal`, one-file fix if a mismatch appears).
- **API/privacy:** zod `.strict()` on every route response (accidental extra field = failing
  test); v0 tape route documented as demo-flagged live data, not gated on `published_at` (§7.1/§13.1);
  `scripts/check-privacy.sh` grep guard over `web/src/app/api/`, `services/worker/`, DB-importing
  modules; leak-scan of golden failure vectors against logs/results/state.
- **E2E = demo runner** (`demo.sh happy|default --assert`) — one artifact for judges, staging, and
  the pre-recorded fallback (asciinema/OBS capture + tx hashes in deployments.md + that run's FDC
  proof committed as fixture — the fallback itself is explorer-verifiable). The default-path leg
  runs against the canonical escrow only (§7.5/§13.1).
- **CI (GitHub Actions):** jobs `contracts`, `engine` (sibling checkout tee-node@develop, run as the
  first Step 3 action — §4 preamble), `web` (+abi-drift: `forge build && gen-abi.sh && git diff
  --exit-code`), `privacy-guard` — all gates; `contracts-fork` on main; `staging.yml`
  workflow_dispatch. `vectors-fresh` (TS consumer regeneration) is **v2**, not a v0 gate (§13.1).
  Zero secrets in the gating lanes. `FOUNDRY_PROFILE=deep` (10k fuzz runs) before the Aug 10 freeze.
  Flake rule: any test failing twice without a code change is fixed or deleted.

---

## 11. Failure Modes

| Failure | Impact | Recovery | Fund risk |
|---|---|---|---|
| TEE restart | RAM book lost; unmatched RFQs/quotes vanish (users resubmit; quotes were 60 s-lived). Locked matches unaffected | `wd-rebind.sh`: restart → `register-tee -command rRap` → `setTeeSigner` on the canonical instance | **None** — refund-by-deadline is pure onchain |
| tee-proxy down | No intake/result serving; matching stalls | restart; missed instructions re-derived from indexer DB; results re-served | None |
| nginx/TLS down | Same blast radius as proxy down (providers can't POST /instruction) | restart nginx / certbot renew; `EXT_PROXY_URL` stable (no ngrok churn) | None |
| Indexer DB creds revoked/unreachable | Proxy never sees instructions → no new matches | escalate via hackathon Telegram; fallback: pre-recorded demo | None |
| FDC round slow / proof misses round | Settlement delayed; DA retry ±1 round; wide margin in window | automatic; proof valid forever once formed | Narrowed but not eliminated: a dishonest taker can still race `refund()` against `release()` if a maker pays inside the last `ATTESTATION_BUDGET` (360 s) seconds of the window. Mitigated: `PAYMENT_WINDOW` split (now 1440 s) + T−12 min UI warning + first-tx-wins ordering; **not fully closed — see §14** |
| Coston2 RPC down | UI reads fail; engine price cache goes stale → matches refused (fail-closed); keeper txs fail | retry/backoff; secondary RPC in config | None — deadlines pass; refund resumes |
| XRPL testnet degraded | Maker can't pay in window → deterministic default path (documented maker-borne risk) | none needed | Taker made whole (refund + bond) |
| `/direct` unavailable/misbehaving | No quote intake | fallback: onchain quote instructions (documented, higher latency/fee) | None |
| Vercel down | No UI | CLI demo runner drives the full flow | None |
| Neon down | Tracker/tape empty | UI falls back to client-direct `getLogs`; worker buffers | None — cache only |
| whisper-worker down | No auto trigger/attestation/refund | every onchain call is permissionless (judge CLI can self-serve); resumes from `indexer_cursor`/`fdc_jobs` | None |
| Redis down | Proxy queues/results lost (TTL'd) | restart; instructions re-derived from indexer DB | None |
| FTSO stale / fee activates | lock refused on staleness (fail-closed); fee handled via `calculateFeeById` + payable forward + surplus refund (§3.6 step 8) | none needed | None |
| FlareTeeManager diamond redeploy | All registrations wiped | full-reset path in `wd-rebind.sh` (re-run pre/post-build, new EXTENSION_ID, rebind the canonical instance) | None |
| Coston2 FXRP redeploy (testnet reset) | Escrow's immutable FXRP pointer stale | redeploy escrow pair (accepted; runbook note in deployments.md — immutability is the safety choice) | None (old escrow still exits funds) |
| Any external live-service stage in the demo runner exceeds its budget (RPC, XRPL WSS, FDC verifier/DA, indexer DB, VPS) | Live demo segment could silently exceed the judged window | Documented intended behavior: per-stage timeout aborts the live segment and falls back to a pre-recorded transcript from that point (§7.5) — **implementation of the abort/fallback automation is Step 6/7 work, not yet built as of this revision, see §14** | None |

Through-line for judges: **every off-chain component can die and no fund is ever stuck.**

---

## 12. Build-Step Mapping

| Step | Spec parts that land | Definition of done |
|---|---|---|
| **1 — Core contracts** | §3 complete: `DvPEscrow` (armed-balance + `committed` accounting, `WrongProofOwner`, zero-address guards) + `BondLedger` + `WdMatchVerifier` lib + mocks + unit/fuzz/invariant tests; solc bumped 0.8.25→0.8.27 (explicit first sub-task — verify cancun/via_ir still apply); `flare-periphery-contracts` installed & **verified to export `IXRPPayment` + `verifyXRPPayment`** (very first task); re-verify `FdcVerification` via `ContractRegistry.getFdcVerification()` and annotate/correct the stale flare-docs file (fdc.md vs fdc-request-fee.md conflict); deploy the single canonical pair to Coston2 via registry-resolving script (`SETTLEMENT_WINDOW=1800, ATTESTATION_BUDGET=360`); dev-EOA-signed `MatchInstruction` through the §3.5 chain proves lock→refund manually; `ci.yml` contracts job; deployments.md started | forge green local+CI; I1–I5 (incl. I2′) hold; manual lock-refund on Coston2 |
| **2 — FDC spike ⛔ GATE** | §3.7 exercised with a real XRPL testnet payment → prepareRequest (`testXRP` right-pad, `requestBody.proofOwner` = canonical escrow address) → `requestAttestation{value: getRequestFee}` → DA proof → onchain verify including the `proofOwner` check; recorded proof + DA responses + round-id triple committed to `testdata/fdc/`; `FdcProofFork.t.sol` | one real round-trip proven; recorded proof passes on fork. NO-GO (±3 days) ⇒ pivot GhostTrigger |
| **3 — FCE loop** | §4.1–4.2 skeleton + §5 discovery/binding; scaffold forked into `engine/`; **very first action: `go build ./... && go test ./...` against a fresh `tee-node@develop` clone — fix the scaffold's `go.mod` relative `replace` path mismatch (verified: it resolves one directory too high given the documented sibling layout) and check for `go-flare-common` pseudo-version drift, before writing any handler code; document the exact required sibling layout or switch to a `go.work` workspace**; VPS stack up behind nginx; `/direct` config enabled; **gates:** (a) live `POST /sign` output recovers to `/info` teeID under the §3.5 digest in Foundry, (b) `DataFixed.OriginalMessage` byte-equals the sender's `message`, (c) `op.IsValidPair` accepts `WD_RFQ`+`QUOTE_SUBMIT` on the direct path, (d) ECIES TS→`/decrypt` golden vector; relay latency measured; `wd-rebind.sh`; digest vectors frozen | `loop-test.sh` (dummy handler) exits 0; all four gates pass; dependency check clean |
| **4 — Matcher** | §4.3–4.9 full engine; §6 payloads; full vector set + **Foundry+Go consumers only for v0** (TS consumer + `vectors-fresh` deferred to v2, §13.1); EIP-712 quote auth; leak-scan test; `DirectInstruction`-as-`DataFixed` regression test asserting the exact empty-`OriginalMessage` symptom | matcher tables 100%; both v0 vector consumers green; deterministic `-count=10` |
| **5 — Full integration** | `WhisperDeskInstructionSender` finalized → copied into scaffold → `pre-build.sh` (one-shot) → `setExtensionId` → `post-build.sh`; §7.2 worker (indexer, keepers, watcher, FDC relayer); migration 0002; full `loop-test.sh`; first `demo.sh --assert` staging run (happy + default paths, both against the single canonical instance — no second deployment, §13.1) | live happy + default paths on Coston2+XRPL exit 0 with `--assert`; hashes in deployments.md |
| **6 — UI + demo runner** | §7.1 pages (v0 tape = live/demo-flagged); §7.3 routes + `.strict()` schemas; privacy guard; demo runner polished (`WD_RFQ_WINDOW_SEC=30`) + per-stage timeout/fallback logic (§7.5, §14) | CI fully green; judge-runnable from clean clone + `.env`, no GCP |
| **7 — Polish (freeze Aug 10)** | deep fuzz (10k); flake triage; pre-recorded fallback captured (video + tx hashes + proof fixture) for BOTH happy and default paths on the canonical instance; slippage-comparison chart; trust writeup draft (§2 verbatim blocks) | fast+fork lanes green 3 consecutive days; staging runbook clean twice same-day |
| **8 — Submission** | README (badge, ASCII arch, addresses, trust assumptions), 3-min video, one-pager, `/submission-check`; repo scrub (`git filter-repo` for `.claude/`+CLAUDE.md) done days early, not deadline day | judge can: clone → `forge test` green < 5 min → `demo.sh happy` live or verify the fallback on-explorer |

---

## 13. Explicit V2 Cuts (documented, not built — protects the 19-day budget)

### 13.1 v0 Demo-Critical Freeze (frozen before Step 1 starts — supersedes any broader ambition
elsewhere in this document; review found the prior draft ~2–3× oversized for a solo 19-day build)

1. **Single escrow/bond deployment only** — no demo-default pair, no live `wd-rebind.sh` during the
   judged demo (§3.2, §7.5, §9.2). The failure-path demo reuses the canonical instance via
   `mode:'default'` + a time-warp test helper (staging) or a pre-recorded transcript with a real
   committed proof fixture (judged run).
2. **Foundry+Go vector parity only** — the TS consumer and the `vectors-fresh` CI job are v2; v0's
   cross-language parity gate covers Solidity+Go (§10).
3. **One worker process, no hourly tape cron / no 24 h delay** — `/api/tape` serves recent
   `released` rows live behind a `demo` flag for v0; the delay/cron logic is added post-freeze only
   if time remains (§7.1, §7.2 module 7, §8).
4. **Everything else already listed below in §13** is documented-but-cut v2 scope, not aspirational
   v1 scope — treat it as frozen, not as a backlog to chip away at before the Aug 10 freeze.

### 13.2 Remaining v2 cuts

1. **BUY_FXRP direction** (taker buys FXRP / maker escrows) — v1 is SELL_FXRP only; `WD_ERR_SIDE`.
2. **Partial fills / multi-maker splits** — full-size quotes only.
3. **Timer-driven matching** (sign-port `POST /result` async push) — v1 is trigger-driven.
4. **Registry-verified teeSigner** (permissionless rotation via FlareTeeManager MachineRegistry
   proof) — v1 is owner-set; meaningless under SIMULATED_TEE anyway.
5. **Taker fee activation** (5 bps slot wired; constant stays 0).
6. **Per-maker `/direct` API keys** — v1 is one shared demo key + nginx rate limit.
7. **`quoteInstructionFee()` view** against the undocumented `OperationFeesFacet` ABI —
   v1 over-provides `msg.value` with claim-back.
8. **Multi-TEE redundancy** (`getRandomTeeIds(count > 1)`, cosigners, signer-set escrow) —
   v1 is single machine, single signer.
9. **Neon `makers` / `instructions` mirror tables** — client-direct reads + localStorage suffice.
10. **Second sealed channel for maker payment instructions** (hash-only `MatchLocked`) —
    post-match settlement data is public by design; plaintext r-address in the event.
11. **Public `/state` exposure / liveness dashboard** — port stays unpublished; optional read-through only.
12. **GCP Confidential Space deployment (MODE=0)** — documented upgrade path in the trust writeup only.
13. **Fdc2 / PMW usage** — classic FDC + manual XRPL payment only.
14. **Testing nice-to-haves:** Playwright UI tests, mutation testing, gas snapshots, coverage
    gates, nightly staging automation, multi-actor invariant handlers, Windows-native test parity.
15. **RFQ nonce-LRU replay set** — envelope sender-binding + fresh-instructionId semantics make it
    redundant; quote nonces (replace semantics) are kept.
16. **Songbird/mainnet deployment** — Coston2 only until stable (project rule).
17. **Demo-default second escrow/bond deployment + live `wd-rebind.sh` during the judged demo** —
    superseded by §13.1 item 1; recorded here for continuity with the pre-review draft.
18. **TS vector consumer + `vectors-fresh` CI lane for v0** — superseded by §13.1 item 2.
19. **Hourly tape-aggregator cron + 24 h-delayed public tape for v0** — superseded by §13.1 item 3.
20. **Demo-runner per-stage abort/fallback automation** — the *behavior* is documented (§7.5, §11)
    as the intended design; building the automation itself is Step 6/7 work, not done as of this
    revision (see §14).
21. **Full elimination of the refund/release race** (oracle/attestation-status precheck inside
    `refund()`) — v1 narrows the window via a widened `ATTESTATION_BUDGET` (§3.2/§3.8) but does not
    build the precheck; see §14.

---

## 14. Known Limitations

Residual risks that this revision narrows or documents, but does not fully eliminate — kept
separate from §13's deliberate v2 feature cuts because these are accepted trade-offs on
already-in-scope v0/v1 mechanisms, not deferred features:

1. **Refund/release race, narrowed not eliminated.** Widening `ATTESTATION_BUDGET` to 360 s (2× the
   ~180 s nominal FDC round-trip time, §3.2) shrinks the window in which a dishonest taker can race
   `refund()` against the relayer's `release()`, but does not remove the underlying incentive: a
   maker who pays inside the last `ATTESTATION_BUDGET` seconds of `PAYMENT_WINDOW` remains
   economically unsafe against a fully adversarial taker running a bot on the escrow's
   `refundAfter` timestamp (§3.8, §11). A full fix (an oracle/attestation-status precheck inside
   `refund()`) is deferred to v2 (§13.2 item 21).
2. **TS vector consumer + `vectors-fresh` CI deferred to v2 (§13.1).** v0's cross-language parity
   assurance for the `MatchInstruction`/`WD_MATCH_V1` chain covers Solidity+Go only; a TS-side
   encoding bug in the worker or UI would surface only at integration/E2E time, not at the fast CI
   gate.
3. **Hourly tape aggregator + 24 h-delayed public tape deferred to v2 (§13.1).** The v0 `/tape`
   endpoint serves live/recent data behind a `demo` flag; the "delayed tape" confidentiality-adjacent
   product feature described in the original quantified policy is documented, not enforced, by v0
   code.
4. **External live-service dependency chain has no built abort/fallback automation yet.** The demo
   runner's intended per-stage timeout-then-fallback behavior (§7.5, §11) is specified but not
   implemented as of this revision — it lands in Step 6/7. Until then, a mid-demo stall in any of
   Coston2 RPC, XRPL WSS, the FDC verifier/DA layer, the Indexer DB, or the VPS stack still risks
   silently exceeding the judged window unless the operator manually switches to the pre-recorded
   fallback.
5. **go.mod / go-flare-common drift is a process control, not a structural guarantee.** The fix
   (run `go build`/`go test` against `tee-node@develop` HEAD as the literal first Step 3 action,
   §4 preamble/§12 Step 3) catches drift only if the check is actually run each time `tee-node`/
   `tee-proxy` are re-pulled from `develop`; a `go.work` workspace is recommended but not mandatory,
   so the relative-path fragility can recur if skipped.
6. **`flare-docs` `FdcVerification` address inconsistency is tracked, not corrected, by this spec.**
   `fdc.md` and `fdc-request-fee.md` disagree on the Coston2 address; the design never hardcodes
   either (registry-resolved throughout), but re-verifying and annotating the stale doc file is a
   Step 1 sub-task, not something this document itself fixes.
7. **SIMULATED_TEE hardware guarantee remains a documented gap, unchanged by this revision** (§2):
   attestation is the `MagicPass` sentinel with a shared test codeHash; the operator can technically
   inspect container memory. The demo proves the protocol design, not a real TEE hardware boundary;
   the production path (MODE=0, PKI JWT, code-hash allowlist, AMD SEV) stays documented-only.