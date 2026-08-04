# Flare Data Connector (FDC)

_Part of [Flare Integration](./README.md)._

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

## How the settlement flow gates on this proof

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
