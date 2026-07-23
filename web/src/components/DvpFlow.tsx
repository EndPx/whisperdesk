"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Zone = "you" | "sealed" | "onchain";

type Step = {
  zone: Zone;
  title: string;
  plain: string;
  data: string;
};

// Plain-language walkthrough — no jargon. The mono `data` chip keeps a light
// technical footprint for credibility without leading with it.
const STEPS: Step[] = [
  {
    zone: "you",
    title: "You place a private order",
    plain:
      "Your side and size are encrypted before they ever leave your browser — the market can't see what you're about to do, so no one can trade against you.",
    data: "5,000 FXRP · encrypted",
  },
  {
    zone: "sealed",
    title: "A fair match is found, in secret",
    plain:
      "Inside a sealed, tamper-proof chip, your order is matched with a counterparty at a price checked against the live market rate.",
    data: "matched · within ±1% of market",
  },
  {
    zone: "onchain",
    title: "Your funds are locked safely",
    plain:
      "The FXRP moves into an on-chain vault. Nobody can take it out until a real payment is actually proven.",
    data: "5,000 FXRP · locked in vault",
  },
  {
    zone: "you",
    title: "The other side pays in XRP",
    plain:
      "Your counterparty sends the agreed XRP payment on the XRP Ledger — real money, on the real network.",
    data: "5,000 XRP · paid",
  },
  {
    zone: "onchain",
    title: "The payment is proven — no trust needed",
    plain:
      "Flare independently verifies the exact payment really happened. The vault believes math, not promises.",
    data: "payment verified on-chain",
  },
  {
    zone: "onchain",
    title: "You get paid, automatically",
    plain:
      "The vault releases the FXRP the instant payment is proven. And if they never pay? You're refunded — and you keep their deposit.",
    data: "settled ✓",
  },
];

const ZONE: Record<Zone, { label: string; ice: boolean }> = {
  you: { label: "You", ice: false },
  sealed: { label: "Sealed chip", ice: false },
  onchain: { label: "On-chain", ice: true },
};

const STEP_MS = 3200;

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

export default function DvpFlow() {
  const reducedMotion = usePrefersReducedMotion();
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!playing || reducedMotion) return;
    timerRef.current = setInterval(() => {
      setActive((i) => (i + 1) % STEPS.length);
    }, STEP_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [playing, reducedMotion]);

  const goTo = useCallback((i: number) => {
    setActive(i);
    setPlaying(false);
  }, []);

  const showAll = reducedMotion;
  // spine fill: 0% at step 0 → 100% at last step
  const fillPct = (active / (STEPS.length - 1)) * 100;

  return (
    <section id="flow" className="snap-section py-20 sm:py-28">
      <div className="mx-auto max-w-[1120px] px-6 sm:px-8">
        <p className="mono-label text-[0.72rem] text-ink-3 mb-4">How a trade settles</p>
        <h2 className="font-display font-semibold text-[1.9rem] sm:text-[2.6rem] leading-[1.1] tracking-tight max-w-2xl text-balance">
          Six steps, in plain English.
        </h2>
        <p className="mt-5 max-w-[58ch] text-[1.02rem] leading-[1.7] text-ink-2">
          Private where it should be private, provable where it matters. Follow the trade
          from a sealed order to money in hand.
        </p>

        <div className="mt-14 relative pl-10 sm:pl-14">
          {/* vertical spine */}
          <div className="absolute left-[15px] sm:left-[19px] top-3 bottom-3 w-px bg-steel-line" aria-hidden="true" />
          {!showAll && (
            <div
              className="absolute left-[15px] sm:left-[19px] top-3 w-px bg-ice/70 transition-all duration-700 ease-in-out"
              style={{
                height: `calc((100% - 1.5rem) * ${fillPct / 100})`,
                boxShadow: "0 0 10px 0 color-mix(in oklab, var(--color-ice) 55%, transparent)",
              }}
              aria-hidden="true"
            />
          )}

          <ol className="space-y-3 sm:space-y-4">
            {STEPS.map((step, i) => {
              const isActive = showAll || i === active;
              const isPast = !showAll && i < active;
              const zone = ZONE[step.zone];
              return (
                <li key={step.title} className="relative">
                  {/* node */}
                  <button
                    type="button"
                    onClick={() => goTo(i)}
                    aria-label={`Step ${i + 1}: ${step.title}`}
                    aria-current={i === active}
                    className="absolute -left-10 sm:-left-14 top-4 flex items-center justify-center"
                  >
                    <span
                      className={`grid place-items-center h-8 w-8 sm:h-10 sm:w-10 rounded-full border font-mono text-[0.72rem] transition-all duration-500 ${
                        isActive
                          ? zone.ice
                            ? "bg-ice text-vault-0 border-ice scale-105"
                            : "bg-ink text-vault-0 border-ink scale-105"
                          : isPast
                            ? "bg-vault-2 text-ink-2 border-steel-line-2"
                            : "bg-vault-1 text-ink-3 border-steel-line"
                      }`}
                      style={
                        isActive && zone.ice
                          ? { boxShadow: "0 0 20px 2px color-mix(in oklab, var(--color-ice) 55%, transparent)" }
                          : undefined
                      }
                    >
                      {isPast ? "✓" : String(i + 1).padStart(2, "0")}
                    </span>
                  </button>

                  {/* card */}
                  <button
                    type="button"
                    onClick={() => goTo(i)}
                    className={`block w-full text-left transition-all duration-500 ${
                      isActive
                        ? "panel px-6 py-6 sm:px-8 sm:py-7"
                        : "px-6 py-4 sm:px-8 opacity-55 hover:opacity-90"
                    }`}
                    style={
                      isActive
                        ? { borderLeft: `2px solid ${zone.ice ? "var(--color-ice)" : "var(--color-steel-line-2)"}` }
                        : undefined
                    }
                  >
                    <div className="flex items-center gap-3 mb-1.5">
                      <span
                        className={`mono-label text-[0.6rem] ${zone.ice ? "text-ice" : "text-ink-3"}`}
                      >
                        {zone.label}
                      </span>
                    </div>
                    <h3
                      className={`font-display font-semibold tracking-tight leading-snug ${
                        isActive ? "text-[1.3rem] sm:text-[1.5rem] text-ink" : "text-[1.15rem] text-ink-2"
                      }`}
                    >
                      {step.title}
                    </h3>
                    {isActive && (
                      <>
                        <p className="mt-3 max-w-[54ch] text-[0.98rem] leading-[1.65] text-ink-2">
                          {step.plain}
                        </p>
                        <p className="mt-4 mono-data text-[0.76rem] text-ink-3">
                          {zone.ice && <span className="ice-dot mr-2 align-middle" />}
                          {step.data}
                        </p>
                      </>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>

        {!showAll && (
          <div className="mt-8 flex items-center gap-4 pl-10 sm:pl-14">
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              className="mono-label text-[0.68rem] px-4 py-2 border border-steel-line-2 text-ink-2 hover:text-ink hover:border-ice-deep/60 transition-colors duration-300"
            >
              {playing ? "Pause" : "Play"}
            </button>
            <span className="mono-label text-[0.64rem] text-ink-3">
              Step {String(active + 1).padStart(2, "0")} / {String(STEPS.length).padStart(2, "0")}
            </span>
          </div>
        )}

        <p className="mt-10 max-w-[56ch] text-[0.95rem] leading-[1.6] text-ink-3 pl-10 sm:pl-14">
          <span className="text-ink-2">The safety net:</span> if the buyer never pays before the
          deadline, the vault refunds you automatically — and the deposit they staked is yours.
        </p>
      </div>
    </section>
  );
}
