# Introduction

WhisperDesk is cross-chain delivery-versus-payment, enforced by contract. It settles institutional
XRP↔FXRP block trades across two chains with no trusted middleman: FXRP on Coston2 moves only
against an FDC-proven XRPL payment, and a maker who never pays is slashed — the default path is a
designed outcome, not an error.

The order flow that needs this protection is private by construction. Sealed RFQs are matched
inside a Flare Confidential Compute (FCE) enclave, and side, size, and counterparty never leave it.
The enclave is trusted for secrecy only — it never holds funds. Every settlement rule (TEE signature
verification, the FTSOv2 price band, FDC proof consumption, deadlines, bond slashing) is enforced
onchain regardless of what the enclave does or claims.

## Who it's for

- **FAssets agents rebalancing XRP↔FXRP inventory** who need to move size without broadcasting their
  book to the mempool first.
- **XRPL treasuries entering Flare DeFi** who want a settlement path where the counter-payment is
  provably tied to the FXRP leg, without routing an RFQ through a public order book.

## What's live today

WhisperDesk is proven end to end on Flare testnet, including once against real FAssets-minted FXRP
minted by the team itself — not a live desk trading real size yet. The FCE extension is registered
and running on Coston2 with its own extension ID, its own TEE machine at `PRODUCTION` status, and its
own registry-enforced instruction sender. The public one-click demo runs a real DvP settlement on
Coston2 + XRPL Testnet in about 3 minutes.

**Try it:** https://whisperdesk.endpx.cloud
**Live enclave:** https://fce.endpx.cloud/info

> The interactive demo settles a MockFXRP test token (mintable, unbacked) — the demo faucet has to
> hand every visitor FXRP, and the real asset cannot be conjured per visitor. The mechanism itself is
> not mock-bound: one full settlement has also run against the real FAssets-minted FXRP
> (`AssetManagerFXRP.fAsset()`), on a second escrow instance. The enclave also runs in simulated-TEE
> mode (`SIMULATED_TEE=true`, attestation `magic_pass`) — the path Flare states is eligible for
> judging — and every trade you can run in the demo is 1 FXRP under a testnet-only override of the
> desk's 5,000 FXRP minimum block size. See [Verify Yourself](./verify-yourself.md) for the full scope
> notes and mitigations.

## Where to next

- [How It Works](./how-it-works.md) — the sealed matching, DvP settlement, and trust model in detail.
- [Try It](./try-it.md) — run the live demo yourself, as taker or as maker.
- [Verify Yourself](./verify-yourself.md) — addresses, receipts, and commands to check every claim on
  this page independently.
