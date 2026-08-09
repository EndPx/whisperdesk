# WhisperDesk

**Cross-chain delivery-versus-payment, enforced by contract.** WhisperDesk settles institutional
XRP↔FXRP block trades across two chains with no trusted middleman: FXRP on Coston2 moves only
against an FDC-proven XRPL payment, and a maker who never pays is slashed — the default path is a
designed outcome, not an error. The order flow that needs this is private by construction: sealed
RFQs are matched inside a Flare Confidential Compute (FCE) enclave, and side, size, and
counterparty never leave it. Proven end to end on Flare testnet — including twice against real
FAssets-minted FXRP we minted ourselves — not a live desk trading real size yet. Built for
**Flare Summer Signal** — Bounty 2 (Confidential Compute).

**▶ Try it: https://whisperdesk.endpx.cloud** — runs a real DvP settlement on Coston2 + XRPL Testnet
in about 3 minutes. Watch it settle on the desk's testnet keys (rate-limited), or be the counterparty
with your own MetaMask — *as the taker*, where the XRP lands on an XRPL address you control, or *as
the maker*, quoting blind against a sealed RFQ you cannot read. Live enclave:
https://fce.endpx.cloud/info

![WhisperDesk architecture — seal, match blind, settle or slash](assets/architecture.svg)

## What runs in the TEE, and why it has to

Four questions, answered directly.

**What runs privately inside the enclave.** The order book, and the decision. RFQs and quotes arrive
ECIES-sealed and are decrypted only inside; the enclave verifies each maker's EIP-712 quote
signature, holds the sealed book, runs the matcher — six filters, then best price with ties broken by
arrival order — and signs the resulting `MatchInstruction` with a key that never leaves it. Side,
size, limit and counterparty never exist in plaintext anywhere else.

**What the chain verifies and consumes.** The enclave's signature is not trusted on its word:
`lock()` runs `ecrecover` and refuses anything not signed by the escrow's configured signer. It then
re-reads the FTSOv2 XRP/USD mid itself and rejects a price more than ±1% away — so a lying enclave
still cannot push a bad price through — and derives the XRP drops on-chain from that oracle, which
is why the enclave never signs a drops figure at all. Release consumes an FDC `XRPPayment`
attestation; refund slashes the maker's bond. Every one of those calls is permissionless.

**Trust assumptions, without softening.** The enclave runs in simulated-TEE mode
(`SIMULATED_TEE=true`, attestation `magic_pass`), so there is no hardware attestation — you are
trusting our deployment, not silicon. Its identity key regenerates on every restart by design, which
is why a monitor watches for exactly that drift. There is one enclave and we operate it. The escrow
owner can call `setLockPaused`. What that trust does *not* extend to: the price band, the drops
arithmetic, the payment proof and the bond slash are all enforced on-chain, so the enclave's power
is limited to choosing *who matches whom*, inside bounds it cannot move.

**Why this cannot be a normal smart contract.** Because anything on-chain is public. A sealed-bid
market whose bids sit in contract storage is not sealed — competitors read the order, and the venue
reads it first. The enclave exists to make one specific thing true: nobody, including us, can see an
order before it is matched. And it buys a second property a public venue structurally cannot offer —
a losing quote is recorded nowhere, not even the fact that it existed, because the taker is never
shown a list to choose from. Venues that let the taker pick must disclose every loser.

## What is and isn't real here

This is a hackathon prototype, and these are its scope boundaries, not apologies:

- **The demo settles genuine FAssets FXRP** — `FTestXRP`, `AssetManagerFXRP.fAsset()` =
  [`0x0b6A3645…3dc7`](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7),
  6 decimals — on both escrows. There is no mock. One was there because a demo faucet has to fund
  every visitor and the real asset cannot be conjured per visitor; Flare's own faucet turns out to
  hand out 10 FXRP per address per day, so the workaround was retired and both escrows redeployed
  against the real token. Nothing we run can mint it: FXRP exists only against XRP locked in
  FAssets, which is exactly what makes settling it worth anything.
- **The enclave runs in simulated-TEE mode** (attestation `magic_pass`, `SIMULATED_TEE=true`) — the
  path Flare states is eligible for judging; GCP Confidential Space is not required. We still did the
  full onchain registration on top of it: our own extension (`65641`), a TEE machine registered and
  at `PRODUCTION` status, and our own registry-enforced instruction sender. What simulated mode does
  cost us is a hardware attestation and a persistent identity — the enclave's key regenerates on
  every restart by design, which is why `scripts/enclave-loop/monitor.mjs` watches for exactly that.
- **The taker's identity is stamped by the contract, not claimed.**
  `WhisperDeskInstructionSender.submitRfq` is the registry-enforced instruction sender for our
  extension, and it writes the taker into the instruction from `msg.sender`. The desk seals your
  order and hands the ciphertext back; the transaction goes out from your own wallet, so nobody —
  this server included — can publish an order in your name.

  That path was broken for a stretch and we blamed the wrong party, which is worth recording because
  the diagnosis is the useful part. Every onchain submission 404'd, we attributed it to Flare's
  hosted FTDC proxy, and RFQ submission moved to `POST /direct` with a self-attested taker. The real
  cause was ours: our TEE machine was registered on-chain under `http://localhost:6674`. Flare's
  data providers push to the URL recorded on-chain, so they were pushing at a loopback address that
  meant nothing to them, and the availability check could never complete. `updateTeeMachineSettings`
  fixed it — no re-registration, no new extension id, no key rotation — the machine reached
  `PRODUCTION`, and an onchain `submitRfq` returned an enclave ack on the first try. If you are
  stuck on the same 404: read `getTeeMachine(<teeId>)` and check the URL is one the outside world
  can reach. `register-tee` will not update it for an already-registered machine, whatever flags you
  pass — `Register()` is the only writer and it is skipped.

  `RFQ_MATCH` stays on `POST /direct` deliberately. It is permissionless on either ingress, carries
  no secret (the `rfqId` is already public) and names no party, so putting it onchain would add a
  transaction, a fee and a wait to a call anyone is allowed to make.
- **Every trade you can run here is 1 FXRP, not an institutional block.** The desk's canonical
  policy is a 5,000 FXRP minimum block (`MIN_BLOCK_FXRP`); the deployed integration
  instance (`contracts/script/DeployIntegration.s.sol`) sets it to `1e6` (1 FXRP) instead, because a
  5,000-FXRP block needs ~5,000 XRP of counter-payment on the XRPL leg, and a faucet-funded XRPL
  testnet account cannot move that. Every receipt in this README is a 1-FXRP trade under that
  testnet-only override.
- **The one-click demo is rate-limited** (3 runs per visitor per day, 20 globally) **and runs on
  desk-held testnet keys** — it is not "be the taker" with your own funds; that mode is separate
  (above).

## What it does

- **Sealed matching in a TEE.** RFQ side, size, limit, and the identity↔order mapping of the
  unmatched book exist only inside the enclave, RAM-only, never in a database or log.
- **DvP settlement, chain-enforced.** `DvPEscrow.release()` pays FXRP to the maker only against an
  FDC `XRPPayment` proof bound to that exact escrow instance (`proofOwner == address(this)`) — a
  proof for one trade can never be replayed against another.
- **Price protection.** FTSOv2 re-checks a ±1% band at `lock()` time and derives the required
  drops onchain — the enclave cannot mismatch price even if it lies.
- **Default protection.** A 1% maker bond is posted at match time and slashed to the taker if the
  maker never pays; `refund()` is permissionless after `refundAfter + REFUND_GRACE`.

## Why this needs a TEE and not just a smart contract

An RFQ *is* the sensitive data: side, size, limit price, and who is asking. A smart contract keeps no
secrets — anything it can read, the mempool and every indexer can read too, before the trade fills.
That is precisely the information a front-runner needs, so "put the order book on-chain" defeats the
product at the first step.

Commit–reveal does not rescue it either. The matcher has to see *both* sides in the clear at the same
moment to decide whether they cross, and revealing at match time publishes the losing orders and the
winner's size anyway. What the desk needs is a place that can hold a secret, run one deterministic
matching rule over it, and then prove what it did — which is what a TEE is for.

But a TEE alone would just relocate the trust: you would be handing an opaque box your funds. So the
enclave is deliberately given the *least* power that still works — it is trusted for secrecy only,
never with custody. It emits one signed instruction, and the chain independently re-checks every part
of it that matters: `ecrecover == teeSigner`, an FTSOv2 ±1% band recomputed on-chain, an FDC proof of
the actual XRPL payment bound to that one escrow, deadlines, and bond slashing. A fully compromised
enclave can leak order flow and fill at the edge of the band — a bounded ~1% loss — and still cannot
move a token. That split is the whole design.

## Live right now

The FCE extension is registered and running on Coston2, hosted at `https://fce.endpx.cloud` —
our own extension id, our own TEE machine at `PRODUCTION` status, and our own instruction sender
that the TEE registry enforces as the only valid origin for our instructions. It runs in
**simulated-TEE** mode (`magic_pass`, `SIMULATED_TEE=true` / `MODE=1`), which Flare states is
eligible for judging.

Check it yourself — needs only Node, no keys and no config:

```bash
cd scripts/enclave-loop && npm install && node monitor.mjs
```

It reads the live enclave and Coston2 and asserts all four: the escrow trusts the running enclave's
key, the registry routes instructions to it, its machine status is `PRODUCTION`, and the URL
registered onchain is the one actually serving. Exit 0 means all four passed.

| Component | Address / URL |
|---|---|
| FCE `/info` (signed `TeeInfo`) | https://fce.endpx.cloud/info |
| FCE extension ID | `0x…010069` (65641) |
| WhisperDeskInstructionSender | `0x56A903F408C4745D34354Ec230BbfBDD78eC6426` |
| Live TEE signer | `0x56564F61588bB110E0712c3938aDa4338e6cc18B` |
| DvPEscrow — **public one-click demo** | `0x5f32783D629E2acBb83f16628ad76D02A26CFB9B` |
| DvPEscrow — **enclave loop** (`teeSigner` = the live enclave) | `0x20A885cb6ed3F652C5Fcb6a683CE74436F6a7023` |
| DvPEscrow — open desk (teeSigner = live enclave) | `0xB3C762634a86991A1e56530056dA05068DE2044C` |
| DvPEscrow — one-click (teeSigner = owner) | `0x78768737b4AfD0e2Fd3676E8dA55E5ff1155fB5c` |
| FXRP (FAssets, `FTestXRP`, 6 dec) | `0x0b6A3645c240605887a5532109323A3E12273dc7` |
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

### Settled against the real FAssets FXRP — not the mock

Same mechanism, same commands, but the asset is the genuine FAssets-minted FXRP
([`0x0b6A3645…3dc7`](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7),
symbol `FTestXRP`) on a dedicated escrow instance
([`0xfa0895ce…e087`](https://coston2-explorer.flare.network/address/0xfa0895ce6af9ef9764afbb967d822dadc13ae087)).
No `mint()` exists on the real asset — we acquired it the way the protocol intends: **a v1.3 direct
mint we initiated ourselves**. 10.2 XRP went from our XRPL account to the FAssets Core Vault with
the 32-byte direct-minting memo, and the protocol's executor minted 10.0 FXRP to our address
(the 0.1 XRP executor fee is exactly what pays for that execution). The settlement wallets were
then funded by transfer from that balance — the run's transcript says so explicitly.

| Step | Receipt |
|---|---|
| XRPL payment → Core Vault (10.2 XRP, direct-minting memo) | https://testnet.xrpl.org/transactions/833E5C138006185960338AB0707768401E35AD2A53A203EDF2D076C473081AC0 |
| FAssets mint — 10.0 real FXRP to our address | https://coston2-explorer.flare.network/tx/0xfc5255afa0cadee272275fa018b3a21a0b6aa69b497f01cae622045c5eb55c4d |
| `lock()` on the real-FXRP escrow | https://coston2-explorer.flare.network/tx/0x874e167d710c04f1c670c779288f620003061dc9f808d5284bfeef0ba9cc7dbb |
| XRPL payment (1,000,000 drops, destination tag 1) | https://testnet.xrpl.org/transactions/9188C50DC94E3D3B314B5B99E5ABE4DB3585E1C926ABB3125542EA20B3490ADF |
| FDC attestation request (voting round 1414419) | https://coston2-explorer.flare.network/tx/0x7c990bea581a5aa0f1b01e63d689c6b1b7e150678bc0ee5a0c18655ca6325371 |
| `release()` — maker received 1.0 **real** FXRP | https://coston2-explorer.flare.network/tx/0x9ea70cafebbf0e6b937216af9cea374d798e6eb0466b7104fe40fd7e256aaea3 |

Reproduce: `FXRP_ADDRESS=0x0b6A3645c240605887a5532109323A3E12273dc7 forge script script/DeployIntegration.s.sol --rpc-url coston2 --broadcast --slow`, then point `happy-path.mjs` at the printed escrow.

### Two strangers, one block, and a desk on neither side

Every other receipt in this README has the desk holding a leg — it signs as maker in wallet mode, it
stands in as taker in maker mode. That proves the machinery works. It does not prove the *product*,
which claims two parties who have never met can trade a block through a venue that can read neither
of their orders and cannot pick the winner. This run proves that one.

The taker wallet was **generated at the start of the run**. Open it on the explorer: it has this
trade and nothing else. It cannot be the desk's standing counterparty, because ninety seconds
earlier it did not exist. The maker is a separate key that signed its own EIP-712 quote, having
never seen the order's size or limit.

And the taker **wrote that order**. The desk publishes two bounds — `MIN_BLOCK_FXRP` off the escrow,
and `mid × (1 + BAND_BIPS)` off FTSOv2 — each read from the contract that enforces it, and the taker
picks a size and a limit inside them. That distinction is the difference between a venue and a
counterparty: sealing an order the desk itself composed would hide it from makers while leaving it
in plain sight of the party that wrote it.

| Stage | Receipt |
|---|---|
| Taker, created during the run | [`0x45712Bef…E723`](https://coston2-explorer.flare.network/address/0x45712Bef9D6a85A2C0Ef1423Cc3d853093cbE723) |
| Maker, a different key | [`0x35AC3BE4…CE3C`](https://coston2-explorer.flare.network/address/0x35AC3BE4d8D3841f394564983Ed7b3fC3666CE3C) |
| Taker's own `deposit()` — its transaction, its key | https://coston2-explorer.flare.network/tx/0x2d36d799668dbe9c80ca847e730019e379922c97f7bed4fcd67652df80ec173a |
| **`submitRfq()` from the taker's own wallet** — the contract stamped the taker | https://coston2-explorer.flare.network/tx/0xd92a2307d203642ea0fbfed7945ebb8764e94df0811b8e07b3a286a769c55c1f |
| The order the taker chose | 1.0 FXRP, limit 1.032557 USD (ceiling that run: 1.047796) |
| `rfqId` = `matchId`, acked by the enclave | `0x0688f34b…1dfe` |
| Maker's blind quote, above that limit | 1.037674 USD/XRP → `MATCHED` |
| XRPL payment — maker → the taker's own account | https://testnet.xrpl.org/transactions/60E7157C768D3144AAFABB428A48F69D9701413CD231C66934BF577B7DD78BEF |
| `release()` — maker received 1.0 FXRP | https://coston2-explorer.flare.network/tx/0x6cb58550ebefec69f2e8ab5b2070d27663e19cb8c6b65e6023f075ae90ed0d36 |

The script checks the chain as it goes and those checks passed: the `SealedRfqSubmitted` event named
`0x45712Bef…` as taker — written by the contract from `msg.sender`, not supplied by anyone —
`matches().taker` == `0x45712Bef…`, `matches().maker` == `0x35AC3BE4…`, and the escrow's XRP
destination == the taker's own XRPL account. Balances after: maker FXRP 7.8 → 8.8, taker XRP
101.000002 on an account that was empty minutes earlier.

The bounds are enforced, not decorative — checked live against the deployed API. A size below the
block minimum, a limit above the band, and a zero limit are each refused with the reason:
`"minimum block is 1000000 raw FXRP"`, `"a limit above … can never fill: lock() re-reads the FTSOv2
mid"`, `"limit price must be positive"`.

What the desk did, in full: sealed the order, relayed two permissionless calls, and paid their gas.
It held neither leg. The FXRP came out of the taker's own escrow deposit, the bond was the maker's
own, and the XRP went from the maker's XRPL account to the taker's.

Reproduce: `scripts/e2e/two-party-desk.mjs`. It generates a fresh taker on every run, so no two runs
share a counterparty — this has now settled three times with three unrelated takers; the earlier two
released at
[`0x46353742…90ac`](https://coston2-explorer.flare.network/tx/0x46353742101183d8852ba788a1d3cfb012d7eea9110ece16ec0b7da45f5190ac)
and
[`0xe959c8eb…7e21c`](https://coston2-explorer.flare.network/tx/0xe959c8ebb84dfc79bd8538a119b71798c17251f5bfa8397ab0889d2e46f7e21c).

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

Why it matters: decode that transaction's instruction event and the message is
`abi.encode(0xBF164f13…c4F6, <ECIES ciphertext>)` — the taker address was written by the *contract*
from `msg.sender`, not supplied by the client. A caller cannot claim to be a different taker
(`contracts/test/` proves the binding; 117/117 tests green). Verify it yourself against live chain
state: `cd scripts/enclave-loop && npm install && node verify-onchain-rfq.mjs`.

### Full settlement through the onchain ingress

The complete flow, with identity chain-authenticated the whole way — RFQ and match trigger onchain,
quote over `/direct` (quotes are private maker data and never touch the chain):

| Stage | Receipt |
|---|---|
| `submitRfq` onchain — taker bound from `msg.sender` | https://coston2-explorer.flare.network/tx/0x212a33d771927a1b36b46b22da4b7d5dc739ebbad9cdb760825417c45299c481 |
| `triggerMatch` onchain → enclave matched + signed | https://coston2-explorer.flare.network/tx/0x94ab3378bf6571c6f2235034b18e13e0c578d77e01bad1d6c9a8ce17d975ee0d |
| `lock()` — escrow accepted the enclave's signature | https://coston2-explorer.flare.network/tx/0x7550a805531c03e2890d2b42ce8c34dc4baa136d82b63d0d2f1c3657af2c89a7 |
| XRPL payment | https://testnet.xrpl.org/transactions/D0F1D1F4BD9A4EA202341847BE9ECF5236C08249696DA45D2BEC384C014AA4D9 |
| `release()` — maker received 1.0 FXRP | https://coston2-explorer.flare.network/tx/0xcd660e692e9445f458ca99f285b2d405ffe702585bb4c5d90125c0b4c2811573 |

This is the operator's reproduction path: `scripts/enclave-loop/onchain-loop.mjs` (RFQ → quote →
match, prices taken from the live FTSOv2 mid so the run doesn't go stale) followed by `run.mjs`
(lock → pay → prove → release) run on the VPS beside a prebuilt `wd-client` binary and require
`DIRECT_API_KEY`, which is generated and held by the operator only — never shared, never
committed. `onchain-ingress-readiness.mjs` checks the two
preconditions first: the registered TEE machine must be the one actually running, and the
enclave's signing policy must match the on-chain reward epoch.

What you *can* verify independently, without those keys:
`cd scripts/enclave-loop && npm install && node verify-onchain-rfq.mjs` (reads Coston2 directly and
checks the registry/instruction binding live), `cd contracts && forge test` (the full 117/117 suite),
and the explorer receipts linked throughout this README.

Scope note: the receipts in *this* table came in over `POST /direct` with `WD_ALLOW_DIRECT_RFQ=true`,
where the taker identity in the envelope is self-attested. That was true of these runs and is no
longer how the site submits orders: RFQ submission goes through
`WhisperDeskInstructionSender.submitRfq` from the taker's own wallet, so the taker is stamped from
`msg.sender` rather than claimed. The `/direct` ingress is still gated on for `RFQ_MATCH`, where it
gives nothing away — that call is permissionless either way, carries no secret, and names no party.
Everything downstream of either ingress is identical: sealing, in-enclave matching, EIP-712 maker
auth, enclave signing, and the onchain `ecrecover` check. The enclave runs in simulated-TEE mode
(`magic_pass`), and its identity key regenerates on every restart by design — which is exactly
what the monitoring cron watches for.

## Judge quickstart (5 minutes)

Nothing to install for step 1. Steps 2–3 need [Foundry](https://getfoundry.sh) (`curl -L
https://foundry.paradigm.xyz | bash && foundryup`) and Node 20+.

1. **Confirm the enclave is alive** — no tooling required:
   ```bash
   curl -s https://fce.endpx.cloud/info
   ```
   Returns a signed `TeeInfo`: `publicKey{x,y}`, `codeHash`, `platform` (hex — decodes to
   `TEST_PLATFORM`, i.e. simulated), `chainId: 114`, `attestation: "magic_pass"`, and
   `machineData.extensionId` = `0x…010069` (65641).

2. **Run the contract test suite** — needs Foundry (117/117 passing):
   ```bash
   cd contracts && forge test --summary
   ```
   `BondLedgerTest` (17), `DvPEscrowTest` (66), `ForkFdcReleaseTest` (3), `ForkFtsoBandTest` (4),
   `GoldenVectorsTest` (4), `InvariantsTest` (4, fuzz/invariant), `MatcherToLockTest` (2),
   `WhisperDeskInstructionSenderTest` (17) — 117 passed, 0 failed.
   The two `Fork*` suites fork Coston2, so they need network access.

3. **Verify the chain-authenticated ingress against live chain state** — needs only Node:
   ```bash
   cd scripts/enclave-loop && npm install && node verify-onchain-rfq.mjs
   ```
   Reads Coston2 directly and asserts that the RFQ instruction's message decodes to
   `abi.encode(<the transaction's own sender>, <ECIES ciphertext>)` — i.e. the taker was stamped by
   the contract, not supplied by the client. No keys, no config.

   *Not runnable from a standalone clone:* `extension/matcher`'s Go parity tests and
   `extension/smoketest/` resolve `tee-node` through a `replace` directive pointing at Flare's
   `fce-*` repos as sibling checkouts, which only exist on an operator machine. The parity they
   prove is also covered by `GoldenVectorsTest`/`MatcherToLockTest` in step 2, which anyone can run.

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
at the edge of the price band — loss bounded at 1% of notional, no fund theft possible.

## Repo layout

| Path | Contents |
|---|---|
| `contracts/` | Foundry project — `DvPEscrow.sol`, `BondLedger.sol`, `WhisperDeskInstructionSender.sol`, `MatchInstructionLib`, mocks, 117 tests |
| `extension/matcher/` | Go sealed order book, deterministic matcher, golden vectors (ABI parity with Solidity) |
| `extension/smoketest/` | TEE-side signing smoke test (`ecrecover` compatibility check) |
| `scripts/e2e/` | Live DvP end-to-end runners (`happy-path.mjs`, `default-path.mjs`) against a deployed integration instance |
| `scripts/fdc-spike/` | Step-2 FDC XRPL spike that produced the GO/NO-GO gate decision |
| `web/` | Next.js landing page |

## Built during the hackathon

Everything in this repo — contracts, matcher, enclave wiring, E2E runners, UI — was built during
Flare Summer Signal; commit history is the evidence trail. All addresses and transactions above
are **Coston2 and XRPL Testnet only**. This is a hackathon prototype: not audited, not production
custody.

## Roadmap

What it would take to make this real, in order:

1. ~~Onchain `submitRfq` ingress~~ — done: the taker is stamped from `msg.sender` again, after our own TEE machine registration was corrected from a loopback URL.
2. ~~Real FAssets FXRP~~ — done: both escrows settle the FAssets asset directly.
3. Persistent TEE identity + real attestation — replace `magic_pass` with genuine remote attestation and a key that survives restarts.
4. Maker onboarding — let more than one maker register into the sealed book, not just the demo pair.
5. Multi-RFQ book — support concurrent open RFQs and matches, not one trade at a time.
6. Mainnet/Songbird deploy — move off Coston2 once the above are stable.
