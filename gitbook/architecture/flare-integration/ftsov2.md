# FTSOv2

_Part of [Flare Integration](./README.md)._

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
