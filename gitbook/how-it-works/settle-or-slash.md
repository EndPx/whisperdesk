# 3 · Settle or slash

The signed `MatchInstruction` goes to `DvPEscrow.lock()` on Coston2, which trusts nothing about the
enclave's claims — it re-derives everything itself:

- **Signature check** — `ecrecover == teeSigner`. A `MatchInstruction` not signed by the escrow's
  registered TEE key is rejected outright.
- **Price re-check** — FTSOv2's ±1% band is **re-read on-chain**, independently of whatever the
  enclave asserted, and the required XRP drops are derived from it. The enclave cannot mismatch
  price even if it lies.
- **Bond posted** — a 1% maker bond goes into `BondLedger` at lock time. That bond is what makes
  default costly instead of free.

From there, the trade forks on one thing: does the maker pay?

```
              lock() — signature + FTSOv2 band verified on-chain, bond posted
                                    |
                +-------------------+-------------------+
                |                                        |
        maker pays XRP on XRPL                    payment window elapses,
        within the payment window                      no payment
                |                                        |
        FDC proves the XRPL payment              refundAfter + REFUND_GRACE
                |                                        |
        release() pays the maker FXRP            permissionless refund():
                                                  taker gets principal back
                                                  + maker's slashed 1% bond
```

**Happy path.** The maker has a payment window to send XRP to the taker on XRPL — 180 seconds in
the deployed integration instance. Once sent, an **FDC** `XRPPayment` proof attests to that
payment, bound to the exact escrow instance it was requested for (`proofOwner == address(this)`,
so a proof for one trade can never be replayed against another). `release()` checks that proof and
pays the maker their FXRP.

**Default path.** If the payment window closes with nothing paid, nothing bad happens immediately
— the match simply sits `Locked`. Once `refundAfter + REFUND_GRACE` has elapsed, anyone can call
the permissionless `refund()`. It returns the taker's FXRP principal **plus the maker's slashed 1%
bond** — the taker is compensated for the maker's no-show, and the maker's cost for defaulting is
guaranteed, not optional. This refund-plus-slash outcome is the **designed default**, not a
failure mode.

## What the enclave is trusted for — and isn't

The enclave is trusted for **secrecy only**: holding the sealed book, matching it, signing the
result. It is never trusted with custody, and it cannot be, because every rule that actually moves
funds — signature verification, the price band, FDC proof binding, deadlines, bond slashing — is
enforced by the contract, not the enclave. A fully compromised enclave can leak order flow and fill
at the edge of the ±1% band; it still cannot move a token. That split — secrecy inside the enclave,
custody enforced entirely on-chain — is what makes phase 3 safe to run against an enclave running
in simulated-TEE mode today.

See [Trust model](../architecture/trust-model.md) for the full breakdown, and [Contracts &
receipts](../reference/contracts-and-receipts.md) for live addresses and proven-live transaction
receipts for both the happy path and the default path.

Previous: [2 · Match](./match.md)
