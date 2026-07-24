# WhisperDesk — demo video script (2:30–3:00)

Read this while screen-recording. Each block is: timestamp, what's on screen, exact words to say.

**Before you hit record:** resize the browser window to **1280x800** and keep it there for the
whole recording — every screenshot and layout in this repo assumes that width. Have MetaMask
already installed (not necessarily connected) and Coston2 gas ready to add if prompted.

---

## 0:00 — The problem (10–15s)

**Screen:** `whisperdesk.endpx.cloud` (or `localhost:3000`) landing page, scrolled to the
"Without WhisperDesk / With WhisperDesk" order-ticket section (`#without-with`). Let the sealed
ticket's redacted fields be visible on screen while you talk.

**Say:**
> "If you trade XRP for FXRP in size today, you've got two bad options: a public DEX, where your
> order is visible before it fills and gets front-run — or an OTC chat, where you just have to
> trust the other side pays. WhisperDesk fixes both."

---

## 0:20 — The DvP flow (20–25s)

**Screen:** scroll to the 3-party flow simulation (`DvpFlow`, "You / WhisperDesk Vault /
Counterparty"). Click through 2–3 steps of the 6-step walkthrough so the pills travel the rails
and the balance panels visibly update (lock, then release).

**Say:**
> "Here's the mechanism: a taker and a maker get matched, funds lock into an on-chain escrow, and
> FXRP only releases to the maker once there's cryptographic proof of the matching XRP payment on
> the XRP Ledger. That's delivery-versus-payment — nobody sends first and hopes."

---

## 0:45 — Be the taker (55s)

**Screen:** navigate to `/demo`, click **"Be the taker (your wallet)"** to switch off the
one-click mode. Walk the five-step stepper live:

1. **Connect wallet** — click "Connect MetaMask", approve the popup, let the address and Coston2
   gas balance show.
2. **Get demo FXRP** — click "Mint 2 demo FXRP", let the faucet tx confirm.
3. **XRPL receive address** — click "Generate one for me" so a funded testnet XRPL account
   appears on screen (this is the address that will receive real XRP later).
4. **Three wallet confirmations** — click "Prepare + lock" and confirm each of the three MetaMask
   popups in order: **approve**, **deposit**, **lock**. Let each one visibly land in the console
   log before moving to the next.

**Say (spread across the steps, don't read line by line — paraphrase naturally):**
> "I'm connecting my own MetaMask — this isn't a canned wallet, it's mine. I mint some demo FXRP,
> then generate an XRPL testnet address that will receive real XRP in a minute. Now I sign three
> transactions myself: approve, deposit, and lock — that's my funds going into the escrow, and I'm
> the one authorizing every step."

---

## 1:40 — Settlement completes (35–40s)

**Screen:** click "Settle" to start step 5. Let the console log run through: XRPL payment sent →
FDC attestation requested → proof ready → `release()` confirmed → final XRPL balance updated. As
each line appears, click at least the XRPL payment link and the `release()` link to briefly show
the real explorer pages (testnet.xrpl.org and coston2-explorer.flare.network) before returning to
the demo tab. End on the "Final XRPL balance … — settled." line with the balance clearly higher
than before.

**Say:**
> "Now watch it settle for real. The XRP Ledger payment just went out, the Flare Data Connector is
> attesting to it, and once that proof lands on Coston2, the escrow releases FXRP to the maker.
> That XRP balance you're seeing update — that's real XRP landing on the XRPL address I generated
> thirty seconds ago, not a mock."

---

## 2:20 — What ran where (15–20s)

**Screen:** scroll the main README (or open it in a second tab) to the "enclave loop" receipts
table — the `rfqId`, enclave signer address, and `lock()` / `release()` transactions signed by the
live enclave. Point at the enclave signer address and the `ecrecover == teeSigner` line.

**Say:**
> "One more thing worth seeing: this same flow also runs through our live confidential-compute
> enclave — a sealed RFQ goes in, gets matched and signed entirely inside the TEE, and the chain
> only ever checks one thing: that the signature came from that enclave's key. The enclave is
> trusted for secrecy; the chain enforces every rule — price, proof, and payout."

---

## Closing (optional, ~5s)

**Say:**
> "WhisperDesk — trades happen in a whisper, settlement happens on-chain."

---

## Notes for the recorder

- Keep the browser at **1280x800** for the entire recording.
- If a step is slow (FDC proof can take a few minutes to finalize), it's fine to cut and resume
  recording rather than showing dead air — just don't fake a transaction that didn't happen.
- All addresses, transactions, and balances shown must be real Coston2 / XRPL Testnet activity
  from this run — no pre-recorded or edited-in receipts.
