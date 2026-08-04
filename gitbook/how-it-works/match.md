# 2 · Match

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

> At every step, the enclave can only ever *emit an instruction*. It never holds, moves, or
> releases a token.

Previous: [1 · Seal](./seal.md) · Next: [3 · Settle or slash](./settle-or-slash.md)
