# WhisperDesk WD_RFQ wire protocol (fcewire)

**Status: authoritative — written by the handler author (this package, `extension/fcewire`).**
Supersedes the draft previously at this path (written by the client-side integrator, before the
handler existed, from `docs/design.md` + source reading only). See **§9 "Reconciling
`scripts/enclave-loop` (wd-client)"** at the bottom for the exact deltas that draft's assumptions
need once the real handler (this package) is wired in.

This file is the canonical source for everything a client (taker UI, maker UI, keeper,
`scripts/enclave-loop`) needs to speak to the deployed WD_RFQ handler. The handler lives in this
directory and is vendored by copy into `fce-extension-scaffold/internal/wd/fcewire` — see
`sync-to-scaffold.ps1`/`.sh`. If you change a schema here, re-run the sync script and update any
client reading this file.

## 1. Op routing

| opType | opCommand | Ingress | Sender auth |
|---|---|---|---|
| `WD_RFQ` | `RFQ_SUBMIT` | onchain instruction (canonical); `/direct` demo bypass iff `WD_ALLOW_DIRECT_RFQ=true` (§1.1) | envelope `msg.sender` (demo bypass: self-attested envelope address, not onchain-authenticated) |
| `WD_RFQ` | `QUOTE_SUBMIT` | `POST /direct` ONLY | in-payload EIP-712 signature |
| `WD_RFQ` | `RFQ_MATCH` | onchain instruction (canonical); `/direct` fallback iff `WD_ALLOW_DIRECT_MATCH=true` | permissionless |

All three strings are hashed with `teeutils.ToHash` (right-pad ASCII into a 32-byte array — the
same scheme as Solidity's `bytes32("…")` literal; `fcewire`'s own `opHash` helper in `handler.go`
duplicates this scheme, verified byte-identical). A command landing on the wrong ingress —
e.g. `QUOTE_SUBMIT` arriving as an onchain instruction, or `RFQ_SUBMIT` arriving via `/direct` — is
rejected `WD_ERR_PATH` (status 0), never silently routed. See `handler.go`'s `HandleInstruction` /
`HandleDirect` and the two `TestHandle*_IsWdErrPath` tests.

### 1.1 Demo ingress (`WD_ALLOW_DIRECT_RFQ`)

**Demo-only — not the production design.** When `WD_ALLOW_DIRECT_RFQ=true` (env, exact string
`"true"`; unset/anything else stays disabled — see `config.go`'s `LoadConfig`), `HandleDirect`
additionally accepts `RFQ_SUBMIT` over `POST /direct`, reusing the *exact same*
decrypt+decode+`AddRFQ` path the onchain-instruction ingress uses: `handler.go`'s
`handleRfqSubmitFromDirect` wraps `di.Message` in a synthetic `instruction.DataFixed` and calls
`handleRfqSubmit` directly — no duplicated logic, no second implementation to keep in sync. When the
flag is off (the default), behavior is byte-identical to the closed-book design: `WD_ERR_PATH`, same
as today.

This path is gated twice, independently: this env flag, AND the proxy's `/direct` API key
(`config/proxy/*.toml`'s `[direct]` block, `DIRECT_API_KEY`) — a caller needs both to reach it.

**Why it exists:** the production design binds `RFQ_SUBMIT` to an onchain, sender-authenticated
transaction via `WhisperDeskInstructionSender` (§3.1 below; `contracts/src/WhisperDeskInstructionSender.sol`)
— but that sender contract is still a stub. The live demo settlement loop needs a working
`RFQ_SUBMIT` path today, so this ingress exists to unblock it, not to replace the production one.
Once `WhisperDeskInstructionSender` ships, the intent is for this flag to go back to (and stay)
disabled — RFQ_SUBMIT is designed to be onchain-instruction-only, full stop.

**Accepted trade-off:** with no onchain transaction backing this ingress, there is no real
`msg.sender` to bind the RFQ to. The envelope shape is unchanged — still
`abi.encode(address sender, bytes ciphertext)` — but on this path `sender` is just whatever address
the caller put in that ABI encoding: self-attested, not onchain-authenticated. `handleRfqSubmit`'s
existing check that the plaintext's `taker` field equals the envelope sender still runs, but it only
proves the two fields agree with each other, not that either reflects a real onchain identity. In
short: **an RFQ names its taker in the sealed payload rather than being bound to `msg.sender`.**
Relatedly, `rfqId` can't be an onchain `instructionId` here (no instruction was mined) — it's derived
deterministically from the envelope bytes instead, so it's only knowable from the returned `RfqAck`,
never chosen upfront by the caller the way a test against the canonical ingress might.

## 2. Direct/Instruction dispatch fix

The scaffold's stock `processAction` (`fce-extension-scaffold/internal/extension/extension.go`)
called `processorutils.Parse[instruction.DataFixed](action.Data.Message)` unconditionally, with no
`action.Data.Type` check. The wired version switches on `action.Data.Type` FIRST:

```go
switch action.Data.Type {
case teetypes.Instruction:
    df, err := processorutils.Parse[instruction.DataFixed](action.Data.Message)
    // ... route by df.OPType/df.OPCommand, WD_RFQ -> wd.HandleInstruction(df)
case teetypes.Direct:
    di, err := processorutils.Parse[teetypes.DirectInstruction](action.Data.Message)
    // ... route by di.OPType/di.OPCommand, WD_RFQ -> wd.HandleDirect(di)
default:
    // 501
}
```

Un-patched, a `Direct` action's `OPType`/`OPCommand` fields still happen to parse correctly (both
`DirectInstruction` and `DataFixed` have those two field names), but `OriginalMessage` — which only
exists on `DataFixed` — silently comes back empty, since `DirectInstruction`'s payload field is
`Message`, not `OriginalMessage`. This looks exactly like an ECIES/decrypt bug from the caller's
side, not a routing bug. Fixed by branching on `Data.Type` before parsing either shape.

## 3. Plaintext payload schemas

RFQ and Quote payloads are JSON, decoded with `encoding/json`'s `DisallowUnknownFields()` — an
unrecognized field is a hard `WD_ERR_DECODE`, never silently ignored. Every numeric amount travels
as a **decimal string**, never a JSON number, to avoid float precision loss on 256-bit values.
Before ECIES encryption, the JSON is right-padded with ASCII spaces (`0x20`) to exactly
`WD_PAD_SIZE` bytes (default 512); the handler rejects any decrypted plaintext whose length is not
exactly `WD_PAD_SIZE` with `WD_ERR_PAD` — ciphertext/calldata length must never leak order-size
magnitude. RFQ_MATCH is NOT JSON/ECIES — see §3.3.

### 3.1 RFQ plaintext (`RfqPlaintext`, RFQ_SUBMIT)

```json
{
  "v": 1,
  "taker": "0x<20B address, must equal the envelope sender>",
  "side": "SELL_FXRP",
  "fxrpAmountRaw": "5000000",
  "limitPriceUsdE18": "3050000000000000000",
  "xrplAddress": "rLLsk7Ac3eDPRRPFPeeC1nCPKMWnQ38rTL"
}
```

- `v` must be `1`.
- `side` must be exactly `"SELL_FXRP"` (v1 supports only one side); anything else -> `WD_ERR_SIDE`.
- `taker` MUST equal the chain-authenticated envelope sender (see §5) -> otherwise `WD_ERR_AUTH`.
  This is deliberately redundant with the envelope: the enclave takes party identity ONLY from the
  envelope, never from decrypted plaintext; the inner field only guards against ciphertext/blob-swap
  confusion. There is no `/direct` bypass for `RFQ_SUBMIT` in the real handler — it is
  onchain-instruction-only, full stop (§1).
- `fxrpAmountRaw`: decimal string, raw 6-decimal FXRP; must parse as a non-negative `uint64` and be
  `>= WD_MIN_BLOCK_FXRP_RAW` (checked by `matcher.AddRFQ`, mapped to `WD_ERR_MIN_SIZE`).
- `limitPriceUsdE18`: decimal string, 18-decimal USD per XRP (== per FXRP at par); must be positive.
- `xrplAddress`: non-empty plaintext r-address; stays in-enclave only until match.

The RFQ envelope itself (the outer onchain instruction payload, NOT the ECIES plaintext) is
`abi.encode(address msg.sender, bytes ciphertext)`, written by
`WhisperDeskInstructionSender.submitRfq` (see `contracts/src/WhisperDeskInstructionSender.sol`).
`rfqId` for all downstream purposes (`QUOTE_SUBMIT`'s `rfqId` field, `RFQ_MATCH`'s target) is the
onchain instruction's `instructionId`, i.e. `DataFixed.InstructionID` as seen by the handler.

### 3.2 Quote plaintext (`QuotePlaintext`, QUOTE_SUBMIT via `POST /direct`)

```json
{
  "v": 1,
  "rfqId": "0x<32B — the RFQ_SUBMIT instructionId>",
  "maker": "0x<20B address, must equal the EIP-712 signature's recovered signer>",
  "priceUsdE18": "3070000000000000000",
  "maxFxrpRaw": "10000000000",
  "nonce": "7",
  "sig": "0x<65B EIP-712 signature over the Quote struct below, V in {27,28}>"
}
```

- `priceUsdE18`, `maxFxrpRaw`, `nonce`: decimal strings; `priceUsdE18` must be positive,
  `maxFxrpRaw`/`nonce` must be non-negative `uint64`s.
- `sig` is verified BEFORE the book is ever touched (`quoteauth.go`'s `VerifyQuoteSignature`) —
  a mismatch is `WD_ERR_AUTH`. This is maker-quote authentication the matcher package deliberately
  does not perform itself (`extension/matcher/book.go`'s `UpsertQuote` doc comment: "Caller (the
  `/direct` handler) is responsible for the EIP-712 signature + bond checks — this method only owns
  book bookkeeping and nonce monotonicity"). No new auth scheme was invented — this implements
  exactly the scheme `docs/design.md` §6.2 already specifies.
- A higher `nonce` replaces the maker's resting quote for `rfqId`; equal/lower `nonce` ->
  `WD_ERR_STALE_NONCE`.

**EIP-712 domain and type** (standard `eth_signTypedData_v4`; no Solidity counterpart to stay
byte-compatible with, since quotes never touch the chain):

```
domain: {name: "WhisperDesk", version: "1", chainId: 114, verifyingContract: <WD_ESCROW_ADDR>}
type:   Quote(bytes32 rfqId,address maker,uint256 priceUsdE18,uint256 maxFxrpRaw,uint256 nonce)
```

### 3.3 RFQ_MATCH payload — raw bytes32 rfqId, NOT JSON/ECIES

**Decided (supersedes the prior draft's ASSUMPTION of a padded+ECIES-sealed `{v, rfqId}` JSON —
see §9):**

- **Onchain instruction (canonical):** `OriginalMessage` is `abi.encode(bytes32 rfqId)` — a single
  static field, no dynamic types, so `abi.encode` of it IS the raw 32 bytes, exactly matching
  `WhisperDeskInstructionSender.triggerMatch(bytes32 rfqId)`'s own
  `message = abi.encode(rfqId)` (§3.10 of `docs/design.md`) — this is a plain ABI value written by a
  Solidity function argument, never ECIES/JSON at all for this ingress.
- **`/direct` fallback (gated by `WD_ALLOW_DIRECT_MATCH`):** the SAME raw 32-byte `rfqId`, sent
  unencrypted as the `message` field. `RFQ_MATCH` triggers carry no secret data — the `rfqId` is
  already public (emitted onchain by `SealedRfqSubmitted`) — so no decryption/EIP-712/padding step
  applies to this command either. `handler.go`'s `decodeRfqID` accepts a bare 32-byte slice
  directly (both ingresses decode identically).

This fallback exists purely so a keeper without gas can still trigger matching in a demo; it is
permissionless and idempotent either way (`matcher.SealedBook.CachedOutcome` / `Participants`).

## 4. Response payloads (`ActionResult.Data`, status 1)

```go
type RfqAck struct {
    RfqID        string `json:"rfqId"`
    WindowEndsAt uint64 `json:"windowEndsAt"`
}
type QuoteAck struct {
    RfqID    string `json:"rfqId"`
    Accepted bool   `json:"accepted"`
    Replaced bool   `json:"replaced"`
}
// MatchResponse == matcher.MatchOutcome — json tags already match this shape exactly.
type MatchResponse struct {
    Outcome      string         `json:"outcome"`                // "MATCHED" | "NO_MATCH"
    Reasons      map[string]int `json:"reasons,omitempty"`      // NO_MATCH aggregate filter counts
    Match        *MatchWire     `json:"match,omitempty"`        // decoded fields, hex/dec strings
    AbiEncoded   string         `json:"abiEncoded,omitempty"`   // 0x… == lock() arg 1
    TeeSignature string         `json:"teeSignature,omitempty"` // 0x… 65B, V already 27/28 == lock() arg 2
}
```

Acks never echo price/size (design invariant: "acks must not leak" — the intake commands' results
are publicly fetchable by actionId). These three shapes are byte-identical to what
`scripts/enclave-loop/internal/wire`'s `RfqAck`/`QuoteAck`/`MatchResponse` already expect — no
client change needed here.

## 5. Closed WD_ERR_* enum

Status 0, `Data = nil`, `Log = "WD_ERR_<CODE>"`. Never echo field values into `Log` — see
`errors.go` for the full set: `WD_ERR_PATH · WD_ERR_DECODE · WD_ERR_DECRYPT · WD_ERR_AUTH ·
WD_ERR_SIDE · WD_ERR_MIN_SIZE · WD_ERR_BOND · WD_ERR_TAKER_FUNDS · WD_ERR_RFQ_UNKNOWN ·
WD_ERR_WINDOW_OPEN · WD_ERR_STALE_NONCE · WD_ERR_PRICE_STALE · WD_ERR_SIGN · WD_ERR_PAD`.

Note: `WD_ERR_BOND` / `WD_ERR_TAKER_FUNDS` are reserved by the closed enum but are not returned as
hard errors by the current matching path — `matcher.matchCore` treats insufficient taker funds /
insufficient maker bond as **data**, not an error: a `NO_MATCH` outcome (status 1) carrying
`reasons: {"INSUFFICIENT_TAKER_FUNDS": N}` or per-quote `"INSUFFICIENT_BOND"` counts. This matches
the existing, tested `extension/matcher` behavior; nothing in fcewire overrides it.

## 6. Sign-port digest finding (the load-bearing part of Step 5)

**Question:** does `tee-node`'s `POST /sign` handler sign the posted bytes as a raw 32-byte digest,
or hash them again first? Verified by reading `tee-node/internal/extension/server/server.go`'s
`signWithTeeHandler` and `tee-node/internal/node/node.go`'s `Node.Sign`:

```go
// server.go: signWithTeeHandler
msgHash := crypto.Keccak256(signRequest.Message)   // (1) HASHES the posted bytes itself
signature, err := s.node.Sign(msgHash)             // (2)

// node.go: Node.Sign
func (n *Node) Sign(msgHash []byte) ([]byte, error) {
    return utils.Sign(msgHash, n.privateKey)
}

// pkg/utils/crypto.go: Sign
func Sign(msgHash []byte, privKey *ecdsa.PrivateKey) ([]byte, error) {
    sig, err := crypto.Sign(accounts.TextHash(msgHash), privKey) // (3) EIP-191 wrap over msgHash
    return sig, err
}
```

**Finding: the sign port hashes the posted `message` bytes with `keccak256` itself** (step 1) before
the EIP-191 personal-sign wrap (step 3) — it does NOT treat the posted bytes as an already-hashed
32-byte digest. So `POST /sign`'s `message` field must be the **raw pre-image**, not its hash.

This matters because `extension/matcher/instruction.go`'s local `Sign()` (used by tests/vectors with
a bare `*ecdsa.PrivateKey`) computes:

```go
payload := csigning.NewPayload(WDMatchTag(), chainID, dataHash)
payloadHash, _ := payload.Hash()          // == keccak256(abi.encode(WD_MATCH_TAG, chainId, dataHash))
sig, _ := teeutils.Sign(payloadHash[:], privKey)   // treats payloadHash AS the digest to sign directly
```

For the **real network sign port** to reproduce this exact signature, the fcewire client must POST
`message = abi.encode(WD_MATCH_TAG, chainId, dataHash)` (the 96-byte pre-image, i.e. the input to
`payload.Hash()` — NOT `payloadHash` itself) and let the sign port's own `crypto.Keccak256(message)`
produce `msgHash == payloadHash`. Given the same private key, the two paths are then byte-identical:

```
local:   digest = keccak256("\x19Ethereum Signed Message:\n32" || payloadHash)
network: digest = keccak256("\x19Ethereum Signed Message:\n32" || keccak256(message))
                where message = abi.encode(WD_MATCH_TAG, chainId, dataHash), so keccak256(message) == payloadHash
```

This is exactly what `docs/design.md` §3.5 already specified, and exactly what the prior client-side
draft of this file independently derived from the same source reading (its §9) — this is a
from-source confirmation, not a change to the documented scheme.

**Implementation (the signing seam):** `extension/matcher/instruction.go` gained an additive
`SignerFunc` type (`func(message []byte) ([]byte, error)`, taking the raw pre-image) and a
`SignWithFunc(mi, chainID, signFn)` that is byte-for-byte equivalent to `Sign()` for the same
underlying key. `extension/matcher/match.go` gained `MatchWithSigner`, the `SignerFunc`-flavored
sibling of `Match`. `extension/fcewire/signclient.go`'s `SignClient.Sign` method has exactly the
`SignerFunc` signature and is passed straight to `matcher.MatchWithSigner` (`handler.go`'s
`handleMatch`). Neither `Sign()`/`Match()` (the local-privkey path used by
`extension/matcher/*_test.go` and `cmd/genvectors`) was modified — this is a purely additive seam,
verified by matcher's full existing test suite still passing unchanged.

`fcewire`'s own `handler_test.go` exercises this at the HTTP level: a fake server that reproduces
`signWithTeeHandler`'s exact two-step hash-then-sign, driven through `Handler.HandleInstruction` /
`HandleDirect`, with the resulting signature's `ecrecover` checked against the fake key's address.

## 7. Chain reads — cached, never in-path

`docs/design.md` §4.1 is a hard invariant: `tee-proxy` calls `POST /action` with a 2-second client
timeout, so no handler path may perform a synchronous chain RPC. `snapshot.go`'s `ChainCache` runs
a single background goroutine (tick = `WD_PRICE_REFRESH_SEC`, default 2s) that:

1. Reads FTSOv2's `getFeedByIdInWei(XRP_USD_FEED_ID)` (resolved once at boot via
   `FlareContractRegistry.getContractAddressByName("FtsoV2")`, never hardcoded).
2. Reads `BondLedger.freeBond(maker)` for every maker registered via `TrackMaker` (called once per
   accepted `QUOTE_SUBMIT`).
3. Reads `DvPEscrow.balances(taker)` for every taker registered via `TrackTaker` (called once per
   accepted `RFQ_SUBMIT`), deriving `available = armed - committed` (zero if `armedUntil` has
   elapsed).

`Handler.handleMatch` builds a `matcher.ChainSnapshot` from ONLY these cached maps (`Snapshot()` —
no RPC call on that path) before calling `matcher.MatchWithSigner`. An address never yet fetched
reads as `0`, which fails closed (`matchCore` excludes it / returns `NO_MATCH`), never crashes.

## 8. Demo-instance policy overrides

Per this task's explicit instruction, the demo instance uses:

| Env | This deploy | `docs/design.md` §4.9 canonical |
|---|---|---|
| `WD_MIN_BLOCK_FXRP_RAW` | `1000000` (1 FXRP raw) | `5000000000` (5,000 FXRP) |
| `WD_QUOTE_TTL_SEC` | `600` | `60` |

All other `WD_*` env knobs (`WD_BAND_BPS`, `WD_RFQ_WINDOW_SEC`/`WD_RFQ_TTL_SEC`,
`WD_PRICE_REFRESH_SEC`/`WD_PRICE_STALE_MAX_SEC`, `WD_CHAIN_SNAPSHOT_TTL_SEC`,
`WD_ALLOW_DIRECT_MATCH`, `WD_PAD_SIZE`, `WD_REGISTRY_ADDR`) keep the `docs/design.md` §4.9 defaults
— see `config.go`'s `LoadConfig`. This matches what the prior client-side draft already recorded
(its §11) — no discrepancy there.

## 9. Reconciling `scripts/enclave-loop` (wd-client)

The client CLI at `scripts/enclave-loop` (`internal/wire`, `cmd/wd-client/loop.go`) was built
against the prior draft of this file, before the real handler existed. Comparing that client to
this authoritative version:

- **No change needed:** `wire.RFQPlaintext`, `wire.QuotePlaintext`, `wire.RfqAck`, `wire.QuoteAck`,
  `wire.MatchWire`, `wire.MatchResponse` — every field name and JSON tag matches this handler
  exactly (compared field-by-field against `wire.go`). `wire.OpType`/`OpCommand*`/`Hash`/`Pad` also
  match (`teeutils.ToHash`, 512-byte space padding).
- **No change needed:** the client's own flagged discrepancy in its old §2 — `loop` submitting
  `RFQ_SUBMIT` via `POST /direct` as a demo convenience — is correctly anticipated to fail
  `WD_ERR_PATH` against this handler, since `RFQ_SUBMIT` truly is onchain-instruction-only here, no
  bypass was added. That code path in `loop` remains unusable against this handler unless `loop` is
  changed to submit `RFQ_SUBMIT` as a real onchain instruction (out of this task's scope).
  `QUOTE_SUBMIT`/`RFQ_MATCH` via `/direct` both work as `loop` already does them.
  `QUOTE_SUBMIT`'s EIP-712 `sig` still must be supplied by the caller — this handler does not
  compute or waive it, matching the client's own documented scope note.
- **BREAKING — `RFQ_MATCH` payload:** `wire.MatchPlaintext{V, RfqID}` (JSON, padded to 512 B, then
  ECIES-sealed via `teeclient.Encrypt`) does NOT match this handler. §3.3 above documents the actual
  (and design.md-grounded, for the onchain ingress) format: a **raw, unencrypted 32-byte `rfqId`**
  as the `message` field, no JSON, no padding, no ECIES. `loop.go`'s match-trigger step
  (`json.Marshal(wire.MatchPlaintext{...})` -> pad -> `teeclient.Encrypt` -> submit) must be changed
  to submit `rfqID.Bytes()` (or its `0x`-hex form) directly as `message`, skipping the JSON/pad/
  encrypt steps entirely for this one command.
- **No change needed:** the sign-port digest finding (old §9, this file's §6) and the client-side
  `ecrecover` verification math (old §10) were already correct — both are reused verbatim by
  `extension/matcher`'s `EthSignedDigest`/`DataHash`/`Recover`, which this handler also calls
  unchanged in `handler_test.go`'s own ecrecover assertion.

**Addendum (client-side, applied):** the `RFQ_MATCH` breaking change above has been applied —
`scripts/enclave-loop/internal/wire`'s `MatchPlaintext` struct was replaced with
`MatchTriggerMessage(rfqID common.Hash) []byte` (returns `rfqID.Bytes()`, nothing else), and
`cmd/wd-client/loop.go`'s match-trigger step now calls `client.Submit` directly with that raw
32-byte message — no `wire.Pad`/`teeclient.Encrypt` in that call path. Covered by
`internal/wire/wire_test.go`'s `TestMatchTriggerMessageIsRaw32Bytes`. Separately, `loop` gained a
`--rfq-id` flag: since `RFQ_SUBMIT` truly has no `/direct` bypass in this handler (confirmed by
reading `handler.go`'s `HandleDirect`, not just anticipated), a caller who already drove
`RFQ_SUBMIT` onchain (e.g. via `WhisperDeskInstructionSender.submitRfq`) can pass the resulting
`instructionId` as `--rfq-id` and `loop` starts at `QUOTE_SUBMIT`, which — like `RFQ_MATCH` — does
work over `/direct` against this handler. Without `--rfq-id`, `loop` still attempts `RFQ_SUBMIT` over
`/direct` first (useful only against a relaxed/test handler) and, on the confirmed `WD_ERR_PATH`,
prints the `--rfq-id` remedy instead of an opaque failure.
