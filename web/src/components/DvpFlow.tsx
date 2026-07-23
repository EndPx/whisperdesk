"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* ---------------------------------------------------------------------------
   DvpFlow — the centerpiece: a 3-party money-flow simulation.

   Three actors — You (Taker), the WhisperDesk Vault, and the Counterparty
   (Maker) — sit in a row connected by machined rails. Small pills travel the
   rails in sync with the 6-step walkthrough, and each party's mono balance
   panel snaps to its new value the moment assets move. A "default path"
   toggle replays steps 4-6 as the safety-net case: buyer never pays, vault
   refunds, maker's bond comes to you.
--------------------------------------------------------------------------- */

type Token = "FXRP" | "XRP" | "lock" | "bond";
type ChipState = "sealing" | "matched" | "idle";
type Ring = "none" | "ice" | "iron";
type PillSpec = { token: Token; reverse?: boolean } | null;

type StepDef = {
  title: string;
  plain: string;
  data: string;
  chip: ChipState;
  railA: PillSpec; // You <-> Vault
  railB: PillSpec; // Vault <-> Maker
  payment: PillSpec; // You <-> Maker (direct XRPL rail, below)
  vaultRing: Ring;
  blockedMarker?: boolean;
};

type Balances = {
  you: { fxrp: number; xrp: number };
  vault: { fxrp: number };
  maker: { xrp: number; fxrp: number };
};

const START: Balances = {
  you: { fxrp: 5000, xrp: 0 },
  vault: { fxrp: 0 },
  maker: { xrp: 5000, fxrp: 0 },
};

const LOCKED: Balances = {
  you: { fxrp: 0, xrp: 0 },
  vault: { fxrp: 5000 },
  maker: { xrp: 5000, fxrp: 0 },
};

const PAID: Balances = {
  you: { fxrp: 0, xrp: 5000 },
  vault: { fxrp: 5000 },
  maker: { xrp: 0, fxrp: 0 },
};

const SETTLED: Balances = {
  you: { fxrp: 0, xrp: 5000 },
  vault: { fxrp: 0 },
  maker: { xrp: 0, fxrp: 5000 },
};

const REFUNDED: Balances = {
  you: { fxrp: 5000, xrp: 0 },
  vault: { fxrp: 0 },
  maker: { xrp: 5000, fxrp: 0 },
};

// index i = balances after step i completes (0-indexed step, so length 6)
const BALANCES_HAPPY: Balances[] = [START, START, LOCKED, PAID, PAID, SETTLED];
const BALANCES_DEFAULT: Balances[] = [START, START, LOCKED, LOCKED, LOCKED, REFUNDED];

const HAPPY_STEPS: StepDef[] = [
  {
    title: "You place a private order",
    plain:
      "Your side and size are encrypted before they ever leave your browser — the market can't see what you're about to do.",
    data: "5,000 FXRP · encrypted",
    chip: "sealing",
    railA: { token: "lock" },
    railB: null,
    payment: null,
    vaultRing: "none",
  },
  {
    title: "A fair match is found, in secret",
    plain:
      "Matched inside a tamper-proof chip at a fair market price (±1%) — still no money has moved.",
    data: "matched · within ±1% of market",
    chip: "matched",
    railA: null,
    railB: null,
    payment: null,
    vaultRing: "none",
  },
  {
    title: "Your funds are locked safely",
    plain:
      "Your FXRP sits in an on-chain vault; nobody can take it until payment is proven.",
    data: "5,000 FXRP · locked in vault",
    chip: "idle",
    railA: { token: "FXRP" },
    railB: null,
    payment: null,
    vaultRing: "none",
  },
  {
    title: "The other side pays in XRP",
    plain:
      "The counterparty sends the XRP on the XRP Ledger — real money, on the real network.",
    data: "5,000 XRP · paid",
    chip: "idle",
    railA: null,
    railB: null,
    payment: { token: "XRP", reverse: true },
    vaultRing: "none",
  },
  {
    title: "The payment is proven — no trust needed",
    plain:
      "Flare independently verifies the exact payment happened. The vault believes math, not promises.",
    data: "payment verified on-chain",
    chip: "idle",
    railA: null,
    railB: null,
    payment: null,
    vaultRing: "ice",
  },
  {
    title: "You get paid, automatically",
    plain: "The vault releases the FXRP the instant payment is proven. Settled.",
    data: "settled ✓",
    chip: "idle",
    railA: null,
    railB: { token: "FXRP" },
    payment: null,
    vaultRing: "none",
  },
];

const DEFAULT_STEPS: StepDef[] = [
  HAPPY_STEPS[0],
  HAPPY_STEPS[1],
  HAPPY_STEPS[2],
  {
    title: "The other side never pays",
    plain:
      "The deadline for the XRP payment passes with nothing received on the XRP Ledger.",
    data: "0 XRP · no payment received",
    chip: "idle",
    railA: null,
    railB: null,
    payment: null,
    vaultRing: "none",
    blockedMarker: true,
  },
  {
    title: "The deadline passes — the vault checks",
    plain: "Flare checks the XRP Ledger for the agreed payment. There isn't one.",
    data: "no payment found · deadline expired",
    chip: "idle",
    railA: null,
    railB: null,
    payment: null,
    vaultRing: "iron",
  },
  {
    title: "You're refunded, automatically",
    plain:
      "The vault returns your FXRP — and the counterparty's staked bond comes to you too.",
    data: "5,000 FXRP refunded · +1% bond",
    chip: "idle",
    railA: { token: "FXRP", reverse: true },
    railB: null,
    payment: { token: "bond", reverse: true },
    vaultRing: "none",
  },
];

const STEP_MS = 5200;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/* ---------------------------------------------------------------------------
   Small stroke icons — 2px, monochrome, matches the machined look.
--------------------------------------------------------------------------- */

function IconLock({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconCheck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M5 12.5 10 17l9-11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconX({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
   Token pill (legend + travel glyph)
--------------------------------------------------------------------------- */

function tokenClass(token: Token) {
  switch (token) {
    case "FXRP":
      return "text-ice border-ice/40";
    case "XRP":
      return "text-[#c9d2dc] border-[#c9d2dc]/35";
    case "lock":
      return "text-ink-2 border-steel-line-2";
    case "bond":
      return "text-ink-2 border-steel-line-2";
  }
}

function tokenBg(token: Token) {
  switch (token) {
    case "FXRP":
      return "color-mix(in oklab, var(--color-ice) 16%, var(--color-vault-2))";
    case "XRP":
      return "color-mix(in oklab, #c9d2dc 12%, var(--color-vault-2))";
    default:
      return "var(--color-vault-2)";
  }
}

function TokenGlyph({ token, className }: { token: Token; className?: string }) {
  if (token === "lock") return <IconLock className={className ?? "h-3 w-3"} />;
  if (token === "bond")
    return <span className="mono-label text-[0.5rem] leading-none">%</span>;
  return <span className="mono-label text-[0.52rem] leading-none">{token === "FXRP" ? "F" : "X"}</span>;
}

function TokenPill({ token }: { token: "FXRP" | "XRP" }) {
  return (
    <span
      className={`mono-label text-[0.56rem] px-1.5 py-0.5 rounded-full border shrink-0 ${tokenClass(token)}`}
      style={{ background: tokenBg(token) }}
    >
      {token}
    </span>
  );
}

/* ---------------------------------------------------------------------------
   Travel pill — animates from one end of its rail to the other over ~900ms.
   Remounted (via key upstream) whenever a new step activates it.
--------------------------------------------------------------------------- */

function TravelPill({ token, reverse }: { token: Token; reverse?: boolean }) {
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArrived(true), 40);
    return () => clearTimeout(t);
  }, []);
  const startLeft = reverse ? "left-[calc(100%-1.4rem)]" : "left-0";
  const endLeft = reverse ? "left-0" : "left-[calc(100%-1.4rem)]";
  return (
    <span
      className={`absolute top-1/2 -translate-y-1/2 h-[1.4rem] w-[1.4rem] grid place-items-center rounded-full border transition-[left] duration-[900ms] ease-in-out z-10 ${
        arrived ? endLeft : startLeft
      } ${tokenClass(token)}`}
      style={{
        background: tokenBg(token),
        boxShadow: "0 0 14px 1px color-mix(in oklab, var(--color-ice) 40%, transparent)",
      }}
      aria-hidden="true"
    >
      <TokenGlyph token={token} />
    </span>
  );
}

function Rail({ pill, dashed = false }: { pill: PillSpec; dashed?: boolean }) {
  return (
    <div
      className="relative flex-1 h-px min-w-[28px] sm:min-w-[52px] self-center"
      style={
        dashed
          ? {
              backgroundImage:
                "repeating-linear-gradient(90deg, var(--color-steel-line-2) 0 6px, transparent 6px 12px)",
              height: "1px",
            }
          : { background: "var(--color-steel-line-2)" }
      }
    >
      {pill && <TravelPill key={`${pill.token}-${pill.reverse ?? ""}`} token={pill.token} reverse={pill.reverse} />}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Party cards
--------------------------------------------------------------------------- */

function BalanceRow({ token, value }: { token: "FXRP" | "XRP"; value: number }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5 border-t border-steel-line first:border-t-0">
      <TokenPill token={token} />
      <span key={value} className="balance-pop mono-data text-[0.88rem] sm:text-[0.95rem] text-ink">
        {value.toLocaleString()}
      </span>
    </div>
  );
}

function PartyCard({
  sub,
  label,
  ring,
  children,
}: {
  sub: string;
  label: string;
  ring?: Ring;
  children: React.ReactNode;
}) {
  const ringClass =
    ring === "ice"
      ? "border-ice/50"
      : ring === "iron"
        ? "border-iron-red/50"
        : "border-steel-line";
  const ringShadow =
    ring === "ice"
      ? "0 0 28px -4px color-mix(in oklab, var(--color-ice) 55%, transparent)"
      : ring === "iron"
        ? "0 0 28px -4px color-mix(in oklab, var(--color-iron-red) 50%, transparent)"
        : undefined;
  return (
    <div
      className={`panel w-[132px] sm:w-[188px] shrink-0 p-4 sm:p-5 transition-[border-color,box-shadow] duration-500 ${ringClass}`}
      style={ringShadow ? { boxShadow: ringShadow } : undefined}
    >
      <p className="mono-label text-[0.56rem] text-ink-3 mb-0.5">{sub}</p>
      <h3 className="font-display font-semibold text-[0.92rem] sm:text-[1.02rem] text-ink mb-3 sm:mb-4 leading-tight">
        {label}
      </h3>
      <div>{children}</div>
    </div>
  );
}

function ChipBadge({ state }: { state: ChipState }) {
  const glow = state !== "idle";
  return (
    <div
      className={`absolute left-1/2 -translate-x-1/2 -top-14 sm:-top-16 flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 bg-vault-1 z-10 transition-[border-color,box-shadow] duration-500 ${
        glow ? "border-ice/50" : "border-steel-line-2"
      }`}
      style={
        glow
          ? { boxShadow: "0 0 20px 2px color-mix(in oklab, var(--color-ice) 55%, transparent)" }
          : undefined
      }
    >
      {state === "matched" ? (
        <IconCheck className={`h-3 w-3 ${glow ? "text-ice" : "text-ink-3"}`} />
      ) : (
        <IconLock className={`h-3 w-3 ${glow ? "text-ice" : "text-ink-3"}`} />
      )}
      <span className={`mono-label text-[0.52rem] whitespace-nowrap ${glow ? "text-ice" : "text-ink-3"}`}>
        Sealed chip
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Static fallback (prefers-reduced-motion): final-state diagram + plain list.
--------------------------------------------------------------------------- */

function StaticDiagram({ showDefault }: { showDefault: boolean }) {
  const bal = showDefault ? REFUNDED : SETTLED;
  return (
    <div className="flex flex-wrap items-stretch gap-6">
      <PartyCard sub="Taker" label="You">
        <BalanceRow token="FXRP" value={bal.you.fxrp} />
        <BalanceRow token="XRP" value={bal.you.xrp} />
      </PartyCard>
      <PartyCard sub="Escrow" label="WhisperDesk Vault">
        <BalanceRow token="FXRP" value={bal.vault.fxrp} />
      </PartyCard>
      <PartyCard sub="Maker" label="Counterparty">
        <BalanceRow token="XRP" value={bal.maker.xrp} />
        <BalanceRow token="FXRP" value={bal.maker.fxrp} />
      </PartyCard>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Main component
--------------------------------------------------------------------------- */

export default function DvpFlow() {
  const reducedMotion = usePrefersReducedMotion();
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [showDefault, setShowDefault] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!playing || reducedMotion) return;
    timerRef.current = setInterval(() => {
      setActive((i) => (i + 1) % HAPPY_STEPS.length);
    }, STEP_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [playing, reducedMotion]);

  const goTo = useCallback((i: number) => {
    setActive(i);
    setPlaying(false);
  }, []);

  const toggleDefault = useCallback(() => {
    setShowDefault((d) => !d);
    setActive(3);
    setPlaying(true);
  }, []);

  const steps = showDefault ? DEFAULT_STEPS : HAPPY_STEPS;
  const balances = (showDefault ? BALANCES_DEFAULT : BALANCES_HAPPY)[active];
  const step = steps[active];
  const isSettled = !showDefault && active === HAPPY_STEPS.length - 1;
  const isRefunded = showDefault && active === DEFAULT_STEPS.length - 1;

  return (
    <section id="flow" className="snap-section py-20 sm:py-28">
      <div className="mx-auto max-w-[1120px] px-6 sm:px-8">
        <p className="mono-label text-[0.72rem] text-ink-3 mb-4">How a trade settles</p>
        <h2 className="font-display font-semibold text-[1.9rem] sm:text-[2.6rem] leading-[1.1] tracking-tight max-w-2xl text-balance">
          Watch the money move.
        </h2>
        <p className="mt-5 max-w-[58ch] text-[1.02rem] leading-[1.7] text-ink-2">
          Three parties. Nothing leaks. Nobody gets stiffed. Follow the trade from a sealed
          order to money in hand — and see exactly what happens if the buyer never pays.
        </p>

        {reducedMotion ? (
          <div className="mt-14 space-y-10">
            <StaticDiagram showDefault={showDefault} />
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setShowDefault(false)}
                className={`mono-label text-[0.64rem] px-3 py-1.5 border transition-colors duration-300 ${
                  !showDefault ? "border-ice/50 text-ice" : "border-steel-line-2 text-ink-3 hover:text-ink-2"
                }`}
              >
                Happy path
              </button>
              <button
                type="button"
                onClick={() => setShowDefault(true)}
                className={`mono-label text-[0.64rem] px-3 py-1.5 border transition-colors duration-300 ${
                  showDefault ? "border-iron-red/50 text-iron-red" : "border-steel-line-2 text-ink-3 hover:text-ink-2"
                }`}
              >
                Default path (no payment)
              </button>
            </div>
            <ol className="space-y-5">
              {(showDefault ? DEFAULT_STEPS : HAPPY_STEPS).map((s, i) => (
                <li key={s.title} className="border-t border-steel-line pt-5 first:border-t-0 first:pt-0">
                  <p className="mono-label text-[0.6rem] text-ink-3 mb-1.5">Step {String(i + 1).padStart(2, "0")}</p>
                  <h3 className="font-display font-semibold text-[1.1rem] text-ink mb-1.5">{s.title}</h3>
                  <p className="max-w-[54ch] text-[0.95rem] leading-[1.6] text-ink-2">{s.plain}</p>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <>
            {/* legend */}
            <div className="mt-12 flex items-center gap-4">
              <span className="flex items-center gap-1.5">
                <TokenPill token="FXRP" />
                <span className="mono-label text-[0.62rem] text-ink-3">on WhisperDesk</span>
              </span>
              <span className="flex items-center gap-1.5">
                <TokenPill token="XRP" />
                <span className="mono-label text-[0.62rem] text-ink-3">on the XRP Ledger</span>
              </span>
            </div>

            {/* diagram */}
            <div className="mt-10 overflow-x-auto">
              <div className="min-w-[560px] sm:min-w-0 px-2 pt-16 pb-4">
                <div className="flex items-center gap-2 sm:gap-5">
                  <PartyCard sub="Taker" label="You">
                    <BalanceRow token="FXRP" value={balances.you.fxrp} />
                    <BalanceRow token="XRP" value={balances.you.xrp} />
                  </PartyCard>

                  <Rail pill={step.railA} />

                  <div className="relative shrink-0">
                    <ChipBadge state={step.chip} />
                    <PartyCard sub="Escrow" label="WhisperDesk Vault" ring={step.vaultRing}>
                      <BalanceRow token="FXRP" value={balances.vault.fxrp} />
                    </PartyCard>
                  </div>

                  <Rail pill={step.railB} />

                  <PartyCard sub="Maker" label="Counterparty">
                    <BalanceRow token="XRP" value={balances.maker.xrp} />
                    <BalanceRow token="FXRP" value={balances.maker.fxrp} />
                  </PartyCard>
                </div>

                {/* direct XRPL payment rail, bypassing the vault */}
                <div className="mt-8 sm:mt-10 flex items-center gap-3 px-1">
                  <span className="mono-label text-[0.56rem] text-ink-3 shrink-0">You</span>
                  <Rail pill={step.payment} dashed />
                  <span className="mono-label text-[0.56rem] text-ink-3 shrink-0 relative">
                    XRP Ledger — direct payment
                    {step.blockedMarker && (
                      <span
                        className="absolute -right-6 -top-1 text-iron-red"
                        aria-hidden="true"
                      >
                        <IconX className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </span>
                  <Rail pill={null} dashed />
                  <span className="mono-label text-[0.56rem] text-ink-3 shrink-0">Maker</span>
                </div>
              </div>
            </div>

            {(isSettled || isRefunded) && (
              <p
                className={`mt-6 mono-label text-[0.68rem] ${isSettled ? "text-ice" : "text-ink-2"}`}
              >
                {isSettled
                  ? "Settled — everyone got what they wanted."
                  : "Refunded — nobody lost money, and the bond came to you."}
              </p>
            )}

            {/* caption card for the active step */}
            <div className="panel mt-8 px-6 py-6 sm:px-8 sm:py-7">
              <div className="flex items-center gap-3 mb-1.5">
                <span className="mono-label text-[0.6rem] text-ink-3">
                  Step {String(active + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}
                </span>
              </div>
              <h3 className="font-display font-semibold tracking-tight leading-snug text-[1.3rem] sm:text-[1.5rem] text-ink">
                {step.title}
              </h3>
              <p className="mt-3 max-w-[54ch] text-[0.98rem] leading-[1.65] text-ink-2">{step.plain}</p>
              <p className="mt-4 mono-data text-[0.76rem] text-ink-3">
                {step.vaultRing === "ice" && <span className="ice-dot mr-2 align-middle" />}
                {step.data}
              </p>
            </div>

            {/* step dots */}
            <div className="mt-6 flex items-center gap-2">
              {steps.map((s, i) => (
                <button
                  key={s.title}
                  type="button"
                  onClick={() => goTo(i)}
                  aria-label={`Step ${i + 1}: ${s.title}`}
                  aria-current={i === active}
                  className={`h-2 rounded-full transition-all duration-500 ${
                    i === active ? "w-7 bg-ice" : "w-2 bg-steel-line-2 hover:bg-steel-line-2/80"
                  }`}
                  style={
                    i === active
                      ? { boxShadow: "0 0 10px 0 color-mix(in oklab, var(--color-ice) 55%, transparent)" }
                      : undefined
                  }
                />
              ))}
            </div>

            {/* controls */}
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => setPlaying((p) => !p)}
                className="mono-label text-[0.68rem] px-4 py-2 border border-steel-line-2 text-ink-2 hover:text-ink hover:border-ice-deep/60 transition-colors duration-300"
              >
                {playing ? "Pause" : "Play"}
              </button>
              <button
                type="button"
                onClick={toggleDefault}
                className={`mono-label text-[0.68rem] px-4 py-2 border transition-colors duration-300 ${
                  showDefault
                    ? "border-iron-red/50 text-iron-red"
                    : "border-steel-line-2 text-ink-2 hover:text-ink hover:border-ice-deep/60"
                }`}
              >
                {showDefault ? "Showing default path — back to happy path" : "What if the buyer never pays?"}
              </button>
            </div>

            <p className="mt-10 max-w-[56ch] text-[0.95rem] leading-[1.6] text-ink-3">
              <span className="text-ink-2">The safety net:</span> if the buyer never pays before the
              deadline, the vault refunds you automatically — and the deposit they staked is yours.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
