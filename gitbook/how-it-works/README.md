# The life of a block trade

One block trade moves through three phases: **seal**, **match**, **settle or slash**. The order
itself — side, size, limit price, counterparty — exists in the clear only inside a Flare
Confidential Compute (FCE) enclave; everything the chain sees afterward is either a signed
instruction it independently re-checks, or a payment it independently proves. See
`../assets/architecture.svg` for the full diagram.

> The default path — maker never pays, taker gets refunded — is a **designed outcome**, not an
> error state.

1. **[Seal](./seal.md)** — the taker's RFQ is ECIES-sealed before it ever reaches the enclave,
   arriving through one of two ingresses that differ only in how the taker's identity is bound.
2. **[Match](./match.md)** — makers quote blind against a live FTSOv2 reference price, and the
   enclave signs a `WD_MATCH_V1` instruction with its own in-enclave key.
3. **[Settle or slash](./settle-or-slash.md)** — `DvPEscrow.lock()` re-derives everything the
   enclave claimed on-chain, then the trade resolves by FDC-proven payment or by a permissionless
   refund that slashes the maker's bond.
