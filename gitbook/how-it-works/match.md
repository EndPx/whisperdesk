# 2 · Match

Makers quote **blind**: they never see the taker's sealed RFQ, only what they're willing to fill
against a live reference price. Each quote is authenticated with **EIP-712**, so the enclave knows
which maker is quoting without the quote ever touching a database or log.

## Many makers, one sealed RFQ

More than one maker can quote the same RFQ, and none of them can tell. A maker is never shown the
side, the size, the taker's limit, the taker's identity, a rival's price — or **whether a rival
exists at all**. There is no quote count, no "2 dealers responding" badge, nothing to shade a price
against. The competition is real; from inside a seat it is invisible. That is the point: a maker
who cannot see the rival has to quote their own book honestly.

> The auction rule ships today and is covered end to end by unit tests; the live demo currently
> shows one maker per trade. [Roadmap](../reference/roadmap.md) has the detail.

## How the enclave picks

Every quote runs the same six filters, in order
([`extension/matcher/match.go`](https://github.com/EndPx/whisperdesk/blob/main/extension/matcher/match.go)):

| # | Filter | A quote is dropped when |
|---|---|---|
| 1 | `SELF_MATCH` | the maker is the taker — nobody fills their own RFQ |
| 2 | `STALE` | the quote is older than the quote TTL (strict `<`; a future-dated quote also fails closed) |
| 3 | `UNDERSIZED` | it cannot fill the whole size — there are no partial fills in v1 |
| 4 | `OUT_OF_BAND` | it falls outside the FTSOv2 **±1% band** (inclusive on both edges) |
| 5 | `BELOW_LIMIT` | it does not beat the taker's sealed limit |
| 6 | `INSUFFICIENT_BOND` | the maker's free bond is under 1% of notional |

Whatever survives competes on price alone: **best price wins**, and an exact tie is broken by the
**lowest sequence number** — price-time priority. The rule is deterministic by construction: `now`
and the reference price are passed in as arguments rather than read from the clock or the network,
so the same book always yields the same winner. Every one of the six filters, both band edges, and
the tie-break each carry their own test in `extension/matcher/match_test.go`.

## What leaves the enclave, and what doesn't

On a match the enclave signs a `MatchInstruction` — scheme `WD_MATCH_V1` — with its own
**in-enclave key**. Nothing outside the enclave ever holds that key.

The match response also carries an aggregate `reasons` map: counts of *why non-winning quotes were
excluded*, carrying no addresses and no prices. It exists for diagnostics, and it is deliberately
**not passed on to a matched maker** — the maker route returns `reasons` only on `NO_MATCH`, where
no trade happened and the counts describe the caller's own failed attempt. On a match, a maker's
browser receives exactly the match id, the XRP amount, the destination and tag, and the payment
deadline. Nothing else.

One detail makes that boundary tighter than it first looks: a quote that passed all six filters and
simply **lost on price is counted nowhere**. Losing a fair auction leaves no trace in the response
at all.

Side, size, limit, and the identity↔order mapping of the unmatched book stay RAM-only, inside the
enclave, for the life of the trade.

> At every step, the enclave can only ever *emit an instruction*. It never holds, moves, or
> releases a token.

Previous: [1 · Seal](./seal.md) · Next: [3 · Settle or slash](./settle-or-slash.md)
