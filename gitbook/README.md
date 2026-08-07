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

WhisperDesk settles. The whole cycle — sealed RFQ, blind match, escrow lock, XRPL payment, FDC
proof, FXRP release — runs end to end on Coston2 + XRPL Testnet, and has cleared against the
**genuine FAssets-minted FXRP**, acquired through a v1.3 direct mint on the real protocol rather
than a stand-in. The default path is live too: a maker who never pays gets slashed, permissionlessly.

The FCE extension is registered and running on Coston2 with its own extension ID, its own TEE
machine at `PRODUCTION` status, and its own registry-enforced instruction sender. The public demo
completes a full DvP settlement in about 4 minutes, most of that the FDC attestation round. Every
claim on this site carries an explorer link next to it.

**Try it:** https://whisperdesk.endpx.cloud
**Live enclave:** https://fce.endpx.cloud/info

> **Scope.** The public demo settles genuine FAssets FXRP — visitors fund themselves from Flare's faucet — sized
> at 1 FXRP against the desk's 5,000 FXRP policy minimum, with the enclave in the simulated-TEE mode
> Flare states is eligible for judging. [Trust model](architecture/trust-model.md) sets out each
> choice and exactly what it costs.

## Where to next

- [The life of a block trade](how-it-works/README.md) — seal, match, and settle-or-slash in detail.
- [Trust model](architecture/trust-model.md) — what the enclave is trusted for, what the chain
  enforces, and the worst case if the enclave is fully compromised.
- [Try it live](guides/try-it.md) — run the demo yourself, from whichever seat you pick.
- [Verify it yourself](guides/verify-yourself.md) — addresses, receipts, and commands to check every
  claim on this page independently.
