# The Solution

WhisperDesk closes both gaps in [The Problem](./problem.md) with two mechanisms working together:
an enclave that keeps the order secret, and a settlement contract that keeps the trade honest
without ever trusting the enclave with funds.

## Sealed RFQs inside a Flare Confidential Compute enclave

Sealed RFQs are matched inside a Flare Confidential Compute (FCE) enclave, and side, size, and
counterparty never leave it. The enclave is trusted for secrecy only — it never holds funds. Nothing
about an unmatched order touches a database, a log, or the mempool, so there is nothing for a
front-runner to read before the trade fills.

## Cross-chain delivery-versus-payment, proven not trusted

FXRP on Coston2 moves only against an FDC-proven XRPL payment: `DvPEscrow.release()` pays FXRP to
the maker only against an FDC `XRPPayment` proof bound to that exact escrow instance
(`proofOwner == address(this)`), so a proof for one trade can never be replayed against another.
Price protection is enforced the same way — FTSOv2 re-checks a ±1% band at `lock()` time and derives
the required drops onchain, so the enclave cannot mismatch price even if it lies. Together these
mean the two legs of the trade — the FXRP leg on Coston2 and the XRP payment on XRPL — settle
against each other through chain-verified proof, with no trusted middleman holding both sides at
once.

## Bond slashing as the designed default path

A maker who never pays is slashed — the default path is a designed outcome, not an error. A 1%
maker bond is posted at match time and slashed to the taker if the maker never pays; `refund()` is
permissionless after `refundAfter + REFUND_GRACE`, so the taker is made whole without needing
anyone's permission or goodwill to recover from a maker's no-show.
