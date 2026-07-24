# WhisperDesk — UI Design Brief (Cinematic Dark Vault)

Paste the "PROMPT" block below into Claude Design. The rest is the reference system + real content
so the design is grounded, not templated. Direction chosen 23 Jul: **Cinematic dark vault** —
near-black, a single cold ice/steel accent (NO rainbow gradient), machined-metal depth, deliberate
slow motion. It should feel like an expensive sealed vault door, not a crypto SaaS landing.

---

## PROMPT (paste into Claude Design)

Design a single-page landing + product surface for **WhisperDesk**, a private OTC desk for
institutional XRP↔FXRP block trades on Flare. Visual direction: **cinematic dark vault** — a
near-black machined-metal world with ONE cold ice-cyan accent used sparingly as the "verified"
signal. Quiet, expensive, deliberate. Absolutely avoid: teal→violet or blue→purple gradients, neon
pops, glassmorphism, rounded-everything, emoji, centered generic hero. Reference feeling: a bank
vault door, a Leica, a Bloomberg terminal's seriousness — not a startup template.

Sections, in order: (1) top bar with logo + minimal nav; (2) hero — a heavy typographic thesis over
a subtly textured brushed-steel panel, with a small "proven live" data chip; (3) "Without vs With
WhisperDesk" as two engraved panels side by side (iron-red vs ice-cyan); (4) the animated
6-step delivery-versus-payment flow (a sealed matte packet travels a machined rail and only lights
ice-cyan on the on-chain steps); (5) a three-zone trust model; (6) a quiet footer. Use the exact
palette, type, and copy from the brief given. Motion is slow and deliberate (600–900ms), respects
prefers-reduced-motion. Design both dark (primary) and a light "cold platinum" theme.

---

## Color tokens (dark = primary)

| token | hex | use |
|---|---|---|
| `--vault-0` | `#06080B` | deepest ground (page) |
| `--vault-1` | `#0B0F14` | raised surface |
| `--vault-2` | `#11161D` | panels / cards |
| `--steel-line` | `#20272F` | hairlines, machined edges |
| `--steel-line-2` | `#2C353F` | hover / focus edges |
| `--ink` | `#E9EDF1` | primary text (cold white) |
| `--ink-2` | `#96A0AB` | secondary (cool grey) |
| `--ink-3` | `#5A6470` | captions / mono labels |
| `--ice` | `#7FE3F0` | THE accent — "verified / sealed→open" signal. Use rarely. |
| `--ice-deep` | `#3FA9BD` | ice pressed / borders |
| `--iron-red` | `#C4574E` | the "without WhisperDesk" / leaked side (muted, not neon) |
| logo sheen | `#8A94A0 → #D7DEE6 → #8A94A0` | brushed-metal gradient — **logo mark ONLY**, monochrome |

Light theme ("cold platinum"): ground `#EDEFF2`, surface `#FFFFFF`, panels `#F5F7F9`, ink `#0B0F14`,
lines `#DDE2E8`, same `--ice`/`--iron-red` dialed for contrast on light. Not warm — keep it cold/steel.

Depth recipe (this is what sells "vault"): every panel = `--vault-2` fill + 1px `--steel-line`
top-highlight (inset `0 1px 0 rgba(255,255,255,.04)`) + deep soft drop `0 30px 60px -40px #000`.
Add a faint global grain/noise overlay (~3% opacity) and a subtle vignette. Hero panel gets a
barely-visible brushed-metal texture (fine horizontal lines). No glow except the ice accent's tight halo.

## Type

- **Display** (hero, section H2): a high-impact face with character — either a sharp high-contrast
  serif (Didone-ish, engraved-nameplate feel) OR a tight condensed grotesk. Heavy weight, negative
  tracking (-0.02em), `text-wrap: balance`. This carries the whole personality — do not use Inter/
  Space Grotesk.
- **Body**: a clean neutral grotesk, 16–17px, `--ink-2`, ~65ch measure.
- **Data / labels / addresses / tx / drops**: monospace, uppercase labels with 0.14em tracking,
  `tabular-nums`. The mono is the "terminal/onchain" voice — use it for every number and hash.

## Layout

Max width ~1120px. Generous vertical rhythm (sections ~72–96px). Left-aligned, editorial — not
centered. Numbers and machined hairlines do the structural work. The animated flow is the centerpiece
and should feel like a precision instrument.

---

## Real content (use verbatim — it's true, and truth reads as confidence)

**Logo**: wordmark "WhisperDesk" ("Desk" in brushed-metal sheen). Mark = a 3-arc sound wave that
*collapses into a sealed vault slot* (a filled rounded slot with a keyway notch). Monochrome metal,
no color. It should read at 24px.

**Hero**
- eyebrow (mono): `PRIVATE OTC DESK · XRP ↔ FXRP · FLARE CONFIDENTIAL COMPUTE`
- headline: **Move size in a whisper. Settle it on-chain.** ("whisper" may get the ice accent — subtle)
- lede: *A dark OTC desk for institutional XRP↔FXRP block trades. Quotes are sealed inside a Trusted
  Execution Environment, so no one front-runs your order — and settlement is delivery-versus-payment:
  the escrow releases FXRP only against a Flare Data Connector proof of the exact XRPL payment.*
- data chip (mono, ice dot): `PROVEN LIVE ON COSTON2 — XRPL payment → FDC proof → release()  ·  tx 0x2c16…202f`

**Without vs With** (two engraved panels)
- WITHOUT (iron-red): "Public DEX or a trust-me OTC chat." Three rows: order visible before it fills
  (front-run); price moves against you (thin FXRP liquidity, real slippage); OTC has no settlement
  guarantee (send first and hope). Outcome: *leaked intent, worse fills, counterparty risk.*
- WITH (ice): "Sealed RFQ + on-chain DvP." Three rows: quotes stay sealed in a TEE (side/size/
  counterparty never exposed); fair price enforced on-chain (within ±1% of live FTSOv2 mid or the
  contract reverts); settlement is proven not trusted (FXRP releases only against an FDC proof;
  default → maker's 1% bond slashed to you). Outcome: *private execution, guaranteed delivery-vs-payment.*

**Animated DvP flow** — 6 steps on a machined rail; a matte "sealed packet" travels; it turns
ice-cyan only on on-chain steps; each step shows a mono data readout. Zones color-coded: External
(steel grey), Private/enclave (dim ice), On-chain (ice). Steps + readouts:
1. External — **Taker seals the RFQ** · block 5,000 FXRP · pair XRP/FXRP · state `sealed`
2. Private — **Enclave matches in band** · ftso mid 1.1355 USD · band ±1.0% · match `best quote`
3. On-chain — **Escrow locks the FXRP** · locked 5,000 FXRP · dest tag #1 · deadline T‑30min
4. External — **Maker pays XRP on XRPL** · xrpl pay 5,000 XRP · tag #1 · result `tesSUCCESS`
5. On-chain — **FDC proves the payment** · proof `XRPPayment` · status `0 · success` · bound to this escrow
6. On-chain — **Release → maker** · released 5,000 FXRP · to maker · settled `on-chain ✓`
   (footnote: miss the deadline → maker's 1% bond is slashed to the taker)

**Trust model** (three zones):
- Private · enclave — *Trusted for secrecy.* Sealed book + matching + TEE signing key; authorizes
  matches, never holds funds.
- On-chain · Coston2 — *Enforces every rule.* DvPEscrow + BondLedger verify the sig, re-check the
  FTSO band, consume the FDC proof, run deadline + slashing.
- Worst case — *Bounded, not catastrophic.* A fully-compromised enclave can at most fill at the edge
  of the ±1% band — a quantified 1% loss, never theft. (vs "the TEE holds your keys.")

**Footer**: `Flare Summer Signal · Bounty 2 (Confidential Compute) · live on Coston2`

---

## Do / Don't
- DO: cold near-black, one ice accent, machined hairlines, brushed-metal texture, deep soft shadows,
  mono for all data, slow deliberate motion, left-aligned editorial layout.
- DON'T: rainbow/teal-violet gradients, neon, glassmorphism, emoji, centered hero, Inter/Space
  Grotesk, rounded-everything, decorative 01/02/03 unless it's the real 6-step sequence.
