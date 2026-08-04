# Problem and Solution

Institutional XRP↔FXRP block trades cannot happen on a public order book without paying for the
privilege of being seen first, and the OTC channels that exist instead carry cross-chain settlement
risk with no trusted middleman to fall back on. WhisperDesk is built to close both gaps at once: it
seals the order so it cannot be front-run, and it settles the trade so payment and delivery either
happen together or the failing side pays for the failure.

## In this section

- [The Problem](./problem.md) — why a lit order book and the mechanics of FAssets FXRP both work
  against institutions trying to move size.
- [The Solution](./solution.md) — sealed RFQ matching inside a Flare Confidential Compute enclave,
  and cross-chain delivery-versus-payment enforced by an FDC-proven XRPL payment and bond slashing.
