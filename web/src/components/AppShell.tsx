"use client";

/* ---------------------------------------------------------------------------
   AppShell — the frame that makes this an application instead of a walkthrough.

   The working surface had no chrome of its own: no brand, no destinations, no
   network, no wallet. What a visitor met was a bare panel and a log, which is
   why it read as a guided demo however the buttons were labelled. Every dapp a
   trader already uses answers four questions before they touch anything — where
   am I, what can I do here, which chain is this, and which account am I on —
   and answers all four in a bar that never moves.

   Destinations, not stages. A stage implies an order and a finish; a
   destination is somewhere you can be, leave, and come back to. That single
   distinction separates a wizard from a desk, and it is the one the old surface
   got wrong.

   The account figures sit in a rule-separated band rather than a row of stat
   cards. Big-number-over-small-label cards are the template every dashboard
   ships; a trading desk shows its account the way a terminal does — dense, on
   one line, tabular, scannable without moving your eyes — and that also keeps
   the figures subordinate to the work, which is where they belong.
--------------------------------------------------------------------------- */

import type { ReactNode } from "react";

export interface ShellRoute {
  id: string;
  label: string;
  /** Shown when a destination has something waiting — an open order, a fill. */
  badge?: string | null;
}

/** One account figure. `hint` explains a number whose name is not self-evident. */
export interface ShellFigure {
  label: string;
  value: string | null;
  hint?: string;
  /** Draws the value in the desk's accent — for a figure that is live or at risk. */
  live?: boolean;
}

function WhisperMark({ className = "" }: { className?: string }) {
  // Drawn, not borrowed: a sealed envelope carrying a lock. One stroke weight throughout, matching
  // the icon language already used across the desk's panels.
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <rect x="2.5" y="5.5" width="19" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.5 7 12 13.5 21.5 7" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="18.5" cy="16.5" r="3.2" fill="var(--color-vault-0)" stroke="currentColor" strokeWidth="1.5" />
      <path d="M17.2 16.5v-1.1a1.3 1.3 0 0 1 2.6 0v1.1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export default function AppShell({
  routes,
  active,
  onNavigate,
  address,
  onDisconnect,
  figures,
  children,
}: {
  routes: ShellRoute[];
  active: string;
  onNavigate: (id: string) => void;
  address: string | null;
  onDisconnect?: () => void;
  figures: ShellFigure[];
  children: ReactNode;
}) {
  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;

  return (
    <div className="mt-3">
      <header className="border border-steel-line bg-vault-2/50">
        {/* Row one: identity, destinations, session. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 sm:px-5 py-3">
          <div className="flex items-center gap-2.5 shrink-0">
            <WhisperMark className="h-[18px] w-[18px] text-ice" />
            <span className="mono-label text-[0.68rem] text-ink tracking-[0.08em]">WhisperDesk</span>
          </div>

          <nav className="flex items-center gap-1 min-w-0" aria-label="Desk sections">
            {routes.map((r) => {
              const on = r.id === active;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onNavigate(r.id)}
                  aria-current={on ? "page" : undefined}
                  className={`mono-label text-[0.6rem] px-3 py-2 border-b-2 transition-colors duration-200 flex items-center gap-2 ${
                    on ? "border-ice text-ice" : "border-transparent text-ink-3 hover:text-ink-2"
                  }`}
                >
                  {r.label}
                  {r.badge && (
                    <span className="mono-data text-[0.56rem] text-vault-0 bg-ice px-1.5 py-px tabular-nums">
                      {r.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="flex items-center gap-2 shrink-0 ml-auto">
            <span className="mono-label text-[0.54rem] text-ink-3 flex items-center gap-1.5 px-2.5 py-1.5 border border-steel-line-2">
              <span className="h-1.5 w-1.5 rounded-full bg-ice" aria-hidden="true" />
              Coston2
            </span>
            {short && (
              <span
                className="mono-data text-[0.62rem] text-ink-2 px-2.5 py-1.5 border border-steel-line-2"
                title={address ?? undefined}
              >
                {short}
              </span>
            )}
            {short && onDisconnect && (
              <button
                type="button"
                onClick={onDisconnect}
                className="mono-label text-[0.54rem] text-ink-3 hover:text-iron-red px-2 py-1.5 transition-colors duration-200"
              >
                Disconnect
              </button>
            )}
          </div>
        </div>

        {/* Row two: the account, on one line. Hidden entirely without a wallet — a row of dashes is
            furniture, and the door has already asked for a connection. */}
        {short && figures.length > 0 && (
          <div className="border-t border-steel-line flex flex-wrap items-stretch">
            {figures.map((f) => (
              <div
                key={f.label}
                className="px-4 sm:px-5 py-2.5 border-r border-steel-line last:border-r-0 min-w-[7.5rem]"
                title={f.hint}
              >
                <p className="mono-label text-[0.5rem] text-ink-3 leading-none">{f.label}</p>
                <p
                  className={`mono-data text-[0.82rem] mt-1.5 leading-none tabular-nums ${
                    f.live ? "text-ice" : "text-ink"
                  }`}
                >
                  {/* A dash, never a zero, while a figure is still loading: a stale number reads as
                      fact, and this bar is the first thing a trader believes. */}
                  {f.value ?? "—"}
                </p>
              </div>
            ))}
          </div>
        )}
      </header>

      <div className="mt-3">{children}</div>
    </div>
  );
}
