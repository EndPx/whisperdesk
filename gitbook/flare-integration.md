# Flare Integration

WhisperDesk is built on four Flare-native primitives, and each one carries load it cannot shed:
**FCC/FCE** holds the secret order book, **FDC** gates the payout, **FTSOv2** bounds the price, and
**FAssets** is the settlement asset itself. Remove any one of them and the design collapses back into
either a public order book or a custodial box. This page documents what each integration actually
does, what it's verified against, and where the current build's honest limits sit.

## Flare Confidential Compute (FCC/FCE)

The desk itself runs inside a Flare Confidential Compute enclave (FCE) — this is where sealed RFQs
are matched and where side, size, limit price, and counterparty identity live for as long as an order
is unmatched. Nothing about the unmatched book touches a database, a log, or the mempool.

The extension is registered and running live on Coston2:

| Component | Address / URL |
|---|---|
| FCE `/info` (signed `TeeInfo`) | https://fce.endpx.cloud/info |
| FCE extension ID | `0x…010069` (65641) |
| WhisperDeskInstructionSender | `0x56A903F408C4745D34354Ec230BbfBDD78eC6426` |
| Live TEE signer | `0x56564F61588bB110E0712c3938aDa4338e6cc18B` |

The TEE machine backing the extension is registered and at `PRODUCTION` status, and
`WhisperDeskInstructionSender` is the **registry-enforced** instruction sender for extension `65641` —
the TEE registry rejects `sendInstructions` from any other contract, so this is the only address that
can originate a `WD_RFQ` instruction. Anyone can check the live wiring with no keys and no config:

```bash
cd scripts/enclave-loop && npm install && node monitor.mjs
```

It reads the live enclave and Coston2 directly and asserts all four: the escrow trusts the running
enclave's key, the registry routes instructions to it, its machine status is `PRODUCTION`, and the URL
registered onchain is the one actually serving. Exit 0 means all four passed.

**Honest limit:** the enclave runs in **simulated-TEE mode** — attestation `magic_pass`,
`SIMULATED_TEE=true` / `MODE=1` — which Flare states is eligible for judging; GCP Confidential Space
is not required. Simulated mode still costs something real: a hardware attestation and a persistent
identity. The enclave's signing key regenerates on every restart by design, which is exactly why
`scripts/enclave-loop/monitor.mjs` watches for it, and why a monitoring cron runs against the live
enclave continuously.

## Flare Data Connector (FDC)

FDC is what turns "a payment happened on XRPL" into something a Coston2 contract can act on.
`DvPEscrow.release()` pays FXRP to the maker only against an FDC `XRPPayment` proof — no proof, no
release, no exceptions carved out for a trusted operator.

The proof is bound to the exact escrow instance that requested it: `proofOwner == address(this)`. That
binding is what prevents a proof for one trade from being replayed against a different escrow — each
`XRPPayment` proof is single-use, single-instance.

Two proven-live receipt chains show the full cycle — request, XRPL payment, attestation, release:

| Step | Receipt |
|---|---|
| XRPL payment (maker → taker, exact drops + destination tag) | https://testnet.xrpl.org/transactions/097B23FD6F4C3FF6740A956838A180C29950DD3E05343786E95930116B18BAA6 |
| `release()` — maker received FXRP against FDC proof | https://coston2-explorer.flare.network/tx/0x2c162613abea611d7b09c50251b35936b6d7c8599daea17016d952591a17202f |
| FDC attestation request (real-FXRP run, voting round 1414419) | https://coston2-explorer.flare.network/tx/0x7c990bea581a5aa0f1b01e63d689c6b1b7e150678bc0ee5a0c18655ca6325371 |

Both flows ran end-to-end against real Coston2, real XRPL Testnet, and the real FDC verifier/DA layer
— `FdcVerification` is deployed at `0x906507E0B64bcD494Db73bd0459d1C667e14B933`.

## FTSOv2

Price protection is the second onchain check, and it runs independently of whatever the enclave
claims about price. XRP/USD is read **twice**: once in-enclave at match time (so the match itself is
priced sanely), and again onchain in `lock()`, where FTSOv2 re-checks a ±1% band and derives the
required drops itself. If the enclave lied or was compromised, the onchain re-check is what actually
bounds the damage — a match can land at the edge of the band, never outside it.

`FtsoV2` is read from the real Coston2 feed registry:

| Component | Address |
|---|---|
| FtsoV2 (real Coston2 registry) | `0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d` |

This is the concrete mechanism behind the desk's stated worst case: a fully compromised enclave can
leak order flow and fill at the edge of the price band — a bounded ~1% loss — and still cannot move a
token, because FTSOv2 and FDC are both re-checked onchain regardless of what the enclave signs.

## FAssets / FXRP

FXRP is the asset the whole DvP mechanism exists to move. Two things are true at once here, and both
are stated plainly rather than blended together:

- **The interactive demo settles a MockFXRP test token** (mintable, 6 decimals, unbacked) at
  `0x700bfC3620585eb42F1Dda6aBA3Ac8E793859FBE`. This exists because the public one-click demo needs a
  faucet that can hand every visitor FXRP on demand — the real, FAssets-minted asset cannot be
  conjured per visitor.
- **One full settlement has also run against the real FAssets-minted FXRP** — `AssetManagerFXRP.fAsset()`
  = [`0x0b6A3645…3dc7`](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7)
  (symbol `FTestXRP`, 6 decimals, same units as the mock) — on a dedicated escrow instance
  ([`0xfa0895ce…e087`](https://coston2-explorer.flare.network/address/0xfa0895ce6af9ef9764afbb967d822dadc13ae087)).

No `mint()` exists on the real asset. The team acquired it the way the protocol intends: a **v1.3
direct mint**, initiated by the team itself. 10.2 XRP went from the team's XRPL account to the
FAssets Core Vault with the 32-byte direct-minting memo, and the protocol's executor minted 10.0 FXRP
to the team's address (the 0.1 XRP executor fee is exactly what pays for that execution). The
settlement wallets were then funded by transfer from that real FXRP balance.

| Step | Receipt |
|---|---|
| XRPL payment → Core Vault (10.2 XRP, direct-minting memo) | https://testnet.xrpl.org/transactions/833E5C138006185960338AB0707768401E35AD2A53A203EDF2D076C473081AC0 |
| FAssets mint — 10.0 real FXRP to our address | https://coston2-explorer.flare.network/tx/0xfc5255afa0cadee272275fa018b3a21a0b6aa69b497f01cae622045c5eb55c4d |
| `lock()` on the real-FXRP escrow | https://coston2-explorer.flare.network/tx/0x874e167d710c04f1c670c779288f620003061dc9f808d5284bfeef0ba9cc7dbb |
| XRPL payment (1,000,000 drops, destination tag 1) | https://testnet.xrpl.org/transactions/9188C50DC94E3D3B314B5B99E5ABE4DB3585E1C926ABB3125542EA20B3490ADF |
| FDC attestation request (voting round 1414419) | https://coston2-explorer.flare.network/tx/0x7c990bea581a5aa0f1b01e63d689c6b1b7e150678bc0ee5a0c18655ca6325371 |
| `release()` — maker received 1.0 **real** FXRP | https://coston2-explorer.flare.network/tx/0x9ea70cafebbf0e6b937216af9cea374d798e6eb0466b7104fe40fd7e256aaea3 |

Reproduce it yourself:

```bash
FXRP_ADDRESS=0x0b6A3645c240605887a5532109323A3E12273dc7 \
  forge script script/DeployIntegration.s.sol --rpc-url coston2 --broadcast --slow
```

then point `happy-path.mjs` at the printed escrow.

> **Scope note on trade size.** Every trade you can run here — mock or real FXRP — is 1 FXRP, not an
> institutional block. The desk's canonical policy is a 5,000 FXRP minimum block (`MIN_BLOCK_FXRP`);
> the deployed integration instance overrides it to `1e6` (1 FXRP) because a 5,000-FXRP block needs
> ~5,000 XRP of counter-payment on the XRPL leg, and a faucet-funded XRPL testnet account cannot move
> that. Every receipt on this page is a 1-FXRP trade under that testnet-only override.

## How the four pieces fit together

```
sealed RFQ ──▶ matched inside FCE (secrecy only, no custody)
                  │ signed MatchInstruction, ecrecover == teeSigner
                  ▼
             DvPEscrow.lock() on Coston2
                  │ FTSOv2 re-check: price within ±1%, drops derived onchain
                  ▼
        real XRPL payment (maker → taker)
                  │
                  ▼
        FDC XRPPayment proof, proofOwner == this escrow
                  │
                  ▼
        DvPEscrow.release() — maker receives FXRP
```

The enclave is trusted for secrecy only and never holds funds. Every settlement rule — TEE signature
verification, the FTSOv2 band, FDC proof consumption bound to one escrow, deadlines, and bond
slashing — is enforced onchain regardless of what the enclave does or claims.
