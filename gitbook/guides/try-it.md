# Try it

**[whisperdesk.endpx.cloud](https://whisperdesk.endpx.cloud)** runs a real DvP settlement on
Coston2 + XRPL Testnet in about 4 minutes end to end. It is not a simulation of the flow — every
line the console prints links out to an actual transaction, on a real block explorer, that you can
open and check yourself. The enclave doing the matching is live and inspectable at the same time:
**[fce.endpx.cloud/info](https://fce.endpx.cloud/info)** returns its signed `TeeInfo` on every
request.

## Before you start

Every trade here is **1 FXRP** and settles in **MockFXRP**, for one practical reason: the faucet has
to fund every visitor on request, and a faucet-funded XRPL account cannot cover the ~5,000 XRP
counter-payment the desk's real 5,000 FXRP minimum would demand. None of that is baked into the
mechanism — the same code, the same commands, have settled against genuine FAssets-minted FXRP.
Receipts are in [Contracts & receipts](../reference/contracts-and-receipts.md).

## Pick a seat

The console opens on a door rather than a dashboard. You choose which side of the trade you sit
on — **Watch the desk trade**, **Sit as the taker**, or **Sit as the maker** — and the desk opens
in that seat. Each card states what that seat is shown and draws what it is not as redacted blocks,
so the asymmetry is visible before you commit to a role.

| Seat | What you use | What it proves |
|---|---|---|
| **No setup** | The desk's own testnet keys | Fastest way to watch a full seal → match → settle cycle. Rate-limited: 3 runs per visitor per day, 20 globally. |
| **As the taker** | Your own MetaMask, plus a generated XRPL account (faucet-funded for you) | The XRP leg lands on an XRPL address you actually control, not a demo wallet. |
| **As the maker** | Your own MetaMask, quoting blind against a sealed RFQ you cannot read | The only seat where you price a trade you cannot see, sign it yourself, and pay the XRP leg from your own account. |

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

Here you are one of the two matched parties rather than a spectator — the desk takes the taker side,
and the enclave matches your quote against its sealed RFQ. You quote blind: the taker's side, size,
and limit stay sealed, and you never see them before you commit.

What this does **not** show is two outside parties matched against each other. Whichever seat you
take, the desk supplies the other one. The matcher itself already handles many makers competing on a
single RFQ — six filters, best price wins, ties broken by arrival — and that rule is covered by unit
tests; see [Roadmap](../reference/roadmap.md) for the line between what tests prove and what a
receipt proves. On a match you post a real **1% bond**, then have **180 seconds**
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
