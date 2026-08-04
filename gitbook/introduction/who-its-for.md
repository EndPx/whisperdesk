# Who It's For

WhisperDesk is built for two kinds of counterparty who both need to move XRP↔FXRP size without
putting their order on a public book first.

## FAssets agents rebalancing inventory

FAssets agents rebalancing XRP↔FXRP inventory need to move size without broadcasting their book to
the mempool first. For an agent managing a position across both chains, showing that rebalancing
order on a lit venue means paying for the privilege of being seen before the trade fills.

## XRPL treasuries entering Flare DeFi

XRPL treasuries entering Flare DeFi want a settlement path where the counter-payment is provably
tied to the FXRP leg, without routing an RFQ through a public order book. WhisperDesk gives that
settlement path a chain-verified proof instead of a trusted intermediary: the FXRP leg only
releases against an FDC-proven XRPL payment, so the treasury's counter-payment and the FXRP delivery
are tied together by proof, not by trust.
