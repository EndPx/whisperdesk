# How It Works

One block trade moves through three phases: **seal**, **match**, **settle or slash**. The order
itself — side, size, limit price, counterparty — exists in the clear only inside a Flare
Confidential Compute (FCE) enclave. Everything the chain sees afterward is either a signed
instruction it independently re-checks, or a payment it independently proves. See
`assets/architecture.svg` for the full diagram.

> The default path — maker never pays, taker gets refunded — is a **designed outcome**, not an
> error state. And at every step, the enclave can only ever *emit an instruction*. It never holds,
> moves, or releases a token.

## Phase 1 — Seal

The taker's RFQ (side, size, limit price) is ECIES-sealed before it reaches the enclave. Two
ingresses exist, and both work — they differ only in how the taker's identity is bound.

| Ingress | Taker identity | Where it's used |
|---|---|---|
| `POST /direct` | Self-attested in the request body (API-keyed, `WD_ALLOW_DIRECT_RFQ=true`) | The one-click browser demo — has to complete inside a single browser session |
| [`WhisperDeskInstructionSender.submitRfq`](https://coston2-explorer.flare.network/address/0x56A903F408C4745D34354Ec230BbfBDD78eC6426) | Stamped from `msg.sender` by the contract itself — cannot be forged by the caller | The chain-authenticated path — registry-enforced as the only valid instruction origin for extension `65641` |

Inside the enclave, the RFQ is identified by `rfqId = keccak256(ciphertext)`. Whichever ingress it
came through, everything downstream — sealing, in-enclave matching, EIP-712 maker auth, enclave
signing, the onchain `ecrecover` check — is identical.

## Phase 2 — Match

Makers quote **blind**: they never see the taker's sealed RFQ, only what they're willing to fill
against a live reference price. Each quote is authenticated with **EIP-712**, so the enclave knows
which maker is quoting without the quote ever touching a database or log.

Matching happens entirely inside the enclave:

1. The enclave checks the maker's quote against a live **FTSOv2** reference price, inside a **±1%
   band**.
2. If it crosses, the enclave forms a match and signs a `MatchInstruction` — scheme `WD_MATCH_V1`
   — with its own **in-enclave key**. Nothing outside the enclave ever holds that key.

That signature is the only thing that leaves the enclave. Side, size, limit, and the
identity↔order mapping of the unmatched book stay RAM-only, inside the enclave, for the life of
the trade.

## Phase 3 — Settle or slash

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
guaranteed, not optional.

## What the enclave is trusted for — and isn't

The enclave is trusted for **secrecy only**: holding the sealed book, matching it, signing the
result. It is never trusted with custody, and it cannot be, because every rule that actually moves
funds — signature verification, the price band, FDC proof binding, deadlines, bond slashing — is
enforced by the contract, not the enclave. A fully compromised enclave can leak order flow and fill
at the edge of the ±1% band; it still cannot move a token. That split — secrecy inside the enclave,
custody enforced entirely on-chain — is what makes phase 3 safe to run against an enclave running
in simulated-TEE mode today.

See [Trust model](trust-model.md) for the full breakdown, and [Contracts &
receipts](contracts-and-receipts.md) for live addresses and proven-live transaction receipts for
both the happy path and the default path.
