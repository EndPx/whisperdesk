# Roadmap

WhisperDesk's core mechanism — seal an RFQ in a TEE, match it blind, settle FXRP against an
FDC-proven XRPL payment or slash the maker's bond — has run end to end on Coston2 + XRPL Testnet,
including once against the real FAssets-minted FXRP, not just the demo's MockFXRP. What has not
happened yet is turning that proven mechanism into a live desk that trades institutional size on
mainnet. This page lays out that distance, in the order it needs to be closed.

| Milestone | Where it stands today | What ships next |
|---|---|---|
| Hardware TEE | Simulated-TEE mode (attestation `magic_pass`, `SIMULATED_TEE=true`), fully registered onchain — extension `65641`, TEE machine at `PRODUCTION` status, registry-enforced instruction sender | GCP Confidential Space with genuine remote attestation, and a signing key that survives a restart |
| Real-size blocks | Canonical policy is a 5,000 FXRP minimum block; the deployed integration instance overrides `MIN_BLOCK_FXRP` to `1e6` (1 FXRP), because a 5,000-FXRP block needs ~5,000 XRP of counter-payment and a faucet-funded XRPL testnet account can't move that | Liquidity and counter-payment capacity that lets the desk operate at the canonical minimum, not the testnet override |
| Full FAssets integration | The interactive demo settles MockFXRP (mintable, unbacked) so the faucet can fund every visitor; a separate escrow instance has settled once against real FAssets-minted FXRP via a v1.3 direct mint we initiated ourselves | Settle the demo itself in real FXRP, with direct mint/redeem wired into the desk instead of a manual, one-off mint |
| Multi-maker RFQ auctions | The sealed book matches one taker against one maker, one trade at a time | Multiple makers registered into the same sealed book, competing on a single RFQ in-enclave, with selective disclosure so an auditor can verify compliance facts without the plaintext RFQ, quote, or counterparty identity ever leaving the enclave |
| Mainnet path | Every address, transaction, and receipt in this repo is Coston2 + XRPL Testnet only; not audited, not production custody | Songbird first, then Flare mainnet, gated on a security review — no mainnet deploy before that review clears |

## Hardware TEE

The enclave already does the real work: it holds the sealed order book, matches deterministically,
and signs `MatchInstruction`s that `DvPEscrow` verifies with `ecrecover == teeSigner`. What
simulated mode costs is a hardware attestation and a persistent identity — today the enclave's key
regenerates on every restart by design, which is exactly what `scripts/enclave-loop/monitor.mjs`
watches for. Moving to GCP Confidential Space closes both gaps without changing the trust model:
the enclave stays trusted for secrecy only, never for custody.

## Real-size blocks

`MIN_BLOCK_FXRP` is a policy constant, not a protocol limit — the override lives in
`contracts/script/DeployIntegration.s.sol` and exists purely because a faucet-funded XRPL testnet
account cannot cover a 5,000-XRP counter-payment. Every receipt linked from [the live
demo](https://whisperdesk.endpx.cloud) is a 1-FXRP trade under that override.

## Full FAssets integration

The demo runs on MockFXRP for a practical reason — the desk cannot conjure real
[FAssets-minted FXRP](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7)
for every visitor's faucet claim. But the mechanism isn't mock-bound: a full settlement already
ran against the genuine asset on a
[dedicated escrow instance](https://coston2-explorer.flare.network/address/0xfa0895ce6af9ef9764afbb967d822dadc13ae087),
funded by a direct mint we initiated on the real protocol. Next is folding that mint/redeem path
into the desk itself, and settling the public demo on the same asset.

## Multi-maker RFQ auctions

Today's sealed book proves the privacy and settlement invariants with one maker and one taker.
Multi-maker auctions raise the bar: several makers quoting blind against the same sealed RFQ,
matched in-enclave, with a selective-disclosure path so auditors can confirm compliance-relevant
facts — without plaintext RFQ data, quotes, or counterparty identity ever leaving the enclave, the
same invariant the desk already enforces for a single match.

## Mainnet path

Everything live today — [the enclave](https://fce.endpx.cloud/info), the escrows, the FCE
extension — runs on Coston2 and XRPL Testnet. The path to Songbird and then Flare mainnet is gated
on a security review; none of the above milestones substitute for it.

---

What exists today is the mechanism proven end to end — sealed matching, chain-enforced DvP,
FTSOv2 price protection, bond slashing on default — not a live desk trading real size. This
roadmap is the distance between those two.
