# Try it

**[whisperdesk.endpx.cloud](https://whisperdesk.endpx.cloud)** runs a real DvP settlement on
Coston2 + XRPL Testnet in about 4 minutes end to end. It is not a simulation of the flow — every
line the console prints links out to an actual transaction, on a real block explorer, that you can
open and check yourself. The enclave doing the matching is live and inspectable at the same time:
**[fce.endpx.cloud/info](https://fce.endpx.cloud/info)** returns its signed `TeeInfo` on every
request.

## Before you start

> The interactive demo settles **MockFXRP** (mintable, unbacked test token), not the genuine
> FAssets-minted asset — the demo faucet has to hand every visitor FXRP on request, and real FXRP
> can't be conjured per visitor. The settlement mechanism itself isn't mock-bound: it has also run,
> once, against real FAssets-minted FXRP on a separate escrow instance. See
> [Contracts & receipts](../reference/contracts-and-receipts.md) for that run.

Every trade you can run here is **1 FXRP**, not an institutional block. The desk's real policy is a
5,000 FXRP minimum (`MIN_BLOCK_FXRP`); the public demo overrides that to `1e6` (1 FXRP) because a
5,000-FXRP block needs roughly 5,000 XRP of counter-payment on the XRPL leg, and a faucet-funded
XRPL testnet account can't move that much.

## Pick a seat

The console opens on a door rather than a dashboard. You choose which side of the trade you sit
on — **Watch the desk trade**, **Sit as the taker**, or **Sit as the maker** — and the desk opens
in that seat. Each card states what that seat is shown and draws what it is not as redacted blocks,
so the asymmetry is visible before you commit to a role.

| Seat | What you use | What it proves |
|---|---|---|
| **No setup** | The desk's own testnet keys | Fastest way to watch a full seal → match → settle cycle. Rate-limited: 3 runs per visitor per day, 20 globally. |
| **As the taker** | Your own MetaMask, plus a generated XRPL account (faucet-funded for you) | The XRP leg lands on an XRPL address you actually control, not a demo wallet. |
| **As the maker** | Your own MetaMask, quoting blind against a sealed RFQ you cannot read | The only mode where two independent parties are matched *inside the enclave* — not the desk playing both sides. |

### No setup

Click through and watch. The desk supplies both the taker and the maker from its own testnet keys,
so you see the whole flow — RFQ sealed, matched blind, escrow locked, XRPL payment sent, FDC proof
consumed, FXRP released — without connecting a wallet. This mode is capped at 3 runs per visitor
per day and 20 runs globally, so it stays available for other judges.

### As the taker

Connect MetaMask and the demo generates an XRPL testnet account for you, funded from a faucet. When
the maker's XRP payment settles, it lands on that address — one you hold the keys to, not a
balance the desk credits you internally.

### As the maker

This is the only mode where you're matched against an independent counterparty inside the enclave,
not against the desk itself. You quote blind — the taker's side, size, and limit stay sealed; you
never see them before you commit. On a match you post a real **1% bond**, then have **180 seconds**
to send the XRP leg. Miss that window and the bond is slashed to the taker — that's not a failure
mode, it's the default protection described in [Trust model](../architecture/trust-model.md) doing
exactly what it's designed to do.

## What your seat is not told

Whichever seat you take, a panel stays on screen for the whole run listing the fields the enclave
holds and never discloses to you. Sitting as the maker, that list covers the RFQ's side, its size,
the taker's limit and identity, a rival's price — and whether a rival exists at all, not even the
count. Sitting as the taker, it covers who is quoting you, how many are, and every losing quote.

It is a standing inventory rather than a one-time notice on purpose: the claim is a property of the
venue, not a step in the flow. And these fields are not merely hidden by the interface — they were
never sent to your browser, so there is nothing there to un-hide. [2 · Match](../how-it-works/match.md)
traces where each one stops.

## Why it pauses after you pay

Once the XRP payment is sent, the console goes quiet for a few minutes before `release()` fires.
That gap is the **FDC attestation round** — the payment has to be picked up, attested, and
finalized by the Flare Data Connector before the escrow will accept it as proof, and that typically
takes **3–6 minutes**. Nothing is stuck; the run resumes on its own once the proof lands.

## What you're watching

Every step the console prints is a link, not a label — a Coston2 explorer transaction for the
contract calls, an XRPL testnet explorer transaction for the payment itself. If you want the same
flow from the command line instead of the browser, see
[Verify it yourself](verify-yourself.md).
