# The Problem

Institutional XRP↔FXRP block trades break down before they ever reach settlement, on three fronts.

## A lit order book front-runs a block order

An RFQ *is* the sensitive data: side, size, limit price, and who is asking. A smart contract keeps
no secrets — anything it can read, the mempool and every indexer can read too, before the trade
fills. That is precisely the information a front-runner needs, so putting the order book on-chain
defeats the trade at the first step. An institution that needs to move XRP↔FXRP size cannot show
that order on a lit venue without paying, in slippage and information leakage, for the privilege of
being seen first.

## Nowhere safe for this order flow to happen

The flow that needs protecting doesn't fit either side of what exists today:

- **FAssets agents rebalancing XRP↔FXRP inventory** need to move size without broadcasting their
  book to the mempool first.
- **XRPL treasuries entering Flare DeFi** want a settlement path where the counter-payment is
  provably tied to the FXRP leg, without routing an RFQ through a public order book.

Neither is served by an ordinary on-chain venue: any mechanism that keeps enough of the order book
visible to match trades also keeps it visible to everyone else, before the trade is done. There is
no venue built for this order flow to sit in while it waits to be matched.

## Mint/redeem friction for FAssets agents

FXRP is not a simple mint-on-demand token. No `mint()` function exists on the real, FAssets-minted
asset — acquiring it means going through the protocol's own path: a direct XRP payment to the
FAssets Core Vault carrying a 32-byte direct-minting memo, plus an executor fee paid in XRP, before
the protocol's executor completes the mint and the FXRP lands. That friction sits on top of the
front-running problem above for any agent managing XRP↔FXRP inventory across both chains — moving
size safely and acquiring the asset in the first place are two separate problems, and today neither
one has a safe, private path.
