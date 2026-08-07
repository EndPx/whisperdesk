# Roadmap

WhisperDesk's core mechanism — seal an RFQ in a TEE, match it blind, settle FXRP against an
FDC-proven XRPL payment or slash the maker's bond — has run end to end on Coston2 + XRPL Testnet,
on the genuine FAssets-minted FXRP that every seat now settles. What has not
happened yet is turning that proven mechanism into a live desk that trades institutional size on
mainnet. This page lays out that distance, in the order it needs to be closed.

| Milestone | Where it stands today | What ships next |
|---|---|---|
| Hardware TEE | Simulated-TEE mode (attestation `magic_pass`, `SIMULATED_TEE=true`), fully registered onchain — extension `65641`, TEE machine at `PRODUCTION` status, registry-enforced instruction sender | GCP Confidential Space with genuine remote attestation, and a signing key that survives a restart |
| Real-size blocks | Canonical policy is a 5,000 FXRP minimum block; the deployed integration instance overrides `MIN_BLOCK_FXRP` to `1e6` (1 FXRP), because a 5,000-FXRP block needs ~5,000 XRP of counter-payment and a faucet-funded XRPL testnet account can't move that | Liquidity and counter-payment capacity that lets the desk operate at the canonical minimum, not the testnet override |
| Full FAssets integration | Every seat settles the genuine FAssets asset (`FTestXRP`) on both escrows; visitors fund themselves from Flare's faucet, and the desk's own supply came from a v1.3 direct mint it initiated | Wire direct mint/redeem into the desk itself, so it can source and return FXRP without a manual step |
| Multi-maker RFQ auctions | The matcher already takes many quotes per sealed RFQ and awards the best price (ties broken by arrival), covered by unit tests — but every settlement demonstrated live so far has been one maker against one taker | A live run with two independent makers on one sealed RFQ, then selective disclosure so an auditor can verify compliance facts without the plaintext RFQ, quote, or counterparty identity ever leaving the enclave |
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

The demo runs on the genuine asset. Both escrows settle
[FAssets-minted FXRP](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7),
and the desk still cannot conjure it — nobody can. What changed is where visitors get theirs:
Flare's own faucet hands out 10 per address per day, which removed the reason a mintable stand-in
existed at all. The desk's own supply came from a v1.3 direct mint it initiated on the real
protocol, sending XRP into the Core Vault like any other minter.

What is left is folding that mint/redeem path into the desk itself, so it can source and return
FXRP as part of running, rather than as a manual step an operator performs beforehand.

## Multi-maker RFQ auctions

The matching rule is already an auction. `matchCore` takes a slice of quotes for one sealed RFQ,
runs the same six filters over each, and awards the trade to the best price — ties broken by
arrival order. Three-maker selection, both band edges, and the tie-break each carry their own unit
test in `extension/matcher/match_test.go`, and [2 · Match](../how-it-works/match.md) sets out the
rule in full.

The live demo currently runs one maker per trade. The two-maker run against the live enclave is
scripted and ready (`scripts/enclave-loop/competing-makers.mjs`), pending an operator key; until it
produces a receipt, the auction stands on its tests.

Past that sits the part that genuinely isn't built: a selective-disclosure path so auditors can
confirm compliance-relevant facts — without plaintext RFQ data, quotes, or counterparty identity
ever leaving the enclave, the same invariant the desk already enforces for a single match.

## Mainnet path

Everything live today — [the enclave](https://fce.endpx.cloud/info), the escrows, the FCE
extension — runs on Coston2 and XRPL Testnet. The path to Songbird and then Flare mainnet is gated
on a security review; none of the above milestones substitute for it.

---

What exists today is the mechanism proven end to end — sealed matching, chain-enforced DvP,
FTSOv2 price protection, bond slashing on default — not a live desk trading real size. This
roadmap is the distance between those two.
