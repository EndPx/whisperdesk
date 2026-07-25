"use client";

/* ---------------------------------------------------------------------------
   flow/parts — shared visual vocabulary for the 3-party DvP diagram.

   Extracted from DvpFlow.tsx so the same party cards, rails, and travel pills
   can be reused by the live /demo console (DemoConsole.tsx) without
   duplicating the Cinematic Dark Vault styling. Pure presentation — no step
   data, no autoplay, no balances state lives here.
--------------------------------------------------------------------------- */

export type Token = "FXRP" | "XRP" | "lock" | "bond";
export type ChipState = "sealing" | "matched" | "idle";
export type Ring = "none" | "ice" | "iron";
export type PillSpec = { token: Token; reverse?: boolean } | null;

/* ---------------------------------------------------------------------------
   Small stroke icons — 2px, monochrome, matches the machined look.
--------------------------------------------------------------------------- */

export function IconLock({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconCheck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M5 12.5 10 17l9-11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconX({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconChevron({ dir, className }: { dir: "left" | "right"; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d={dir === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
   Token pill (legend + travel glyph)
--------------------------------------------------------------------------- */

export function tokenClass(token: Token) {
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

export function tokenBg(token: Token) {
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

export function TokenPill({ token }: { token: "FXRP" | "XRP" }) {
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
   Travel pill — glides one end of its rail to the other on a single eased
   curve (fade in → travel → fade out on arrival). Motion lives in CSS
   (.pill-travel / .pill-travel-rev); this just remounts per step via `key`.
--------------------------------------------------------------------------- */

// glow colour keyed to the asset moving down the wire
export function pillGlow(token: Token) {
  return token === "XRP" ? "#c9d2dc" : "var(--color-ice)";
}

export function TravelPill({ token, reverse }: { token: Token; reverse?: boolean }) {
  const glow = pillGlow(token);
  return (
    <span
      className={`absolute top-1/2 h-[1.4rem] w-[1.4rem] grid place-items-center rounded-full border z-10 ${
        reverse ? "pill-travel-rev" : "pill-travel"
      } ${tokenClass(token)}`}
      style={{
        background: tokenBg(token),
        boxShadow: `0 0 16px 2px color-mix(in oklab, ${glow} 42%, transparent)`,
      }}
      aria-hidden="true"
    >
      <TokenGlyph token={token} />
    </span>
  );
}

export function Rail({ pill, dashed = false }: { pill: PillSpec; dashed?: boolean }) {
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
      {pill && (
        <>
          {/* current running down the wire, in sync with the pill */}
          <span
            className={`absolute inset-x-0 top-1/2 -translate-y-1/2 h-[2px] pointer-events-none ${
              pill.reverse ? "rail-current-rev" : "rail-current"
            }`}
            style={{ "--rail-glow": pillGlow(pill.token) } as React.CSSProperties}
            aria-hidden="true"
          />
          <TravelPill token={pill.token} reverse={pill.reverse} />
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Party cards
--------------------------------------------------------------------------- */

// `value: null` renders a neutral placeholder dash instead of a number — for a figure that hasn't
// resolved yet (e.g. a cross-chain read still in flight), never guess or hold onto a stale number.
export function BalanceRow({ token, value }: { token: "FXRP" | "XRP"; value: number | null }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5 border-t border-steel-line first:border-t-0">
      <TokenPill token={token} />
      {value === null ? (
        <span className="mono-data text-[0.88rem] sm:text-[0.95rem] text-ink-3">—</span>
      ) : (
        <span key={value} className="balance-pop mono-data text-[0.88rem] sm:text-[0.95rem] text-ink">
          {value.toLocaleString()}
        </span>
      )}
    </div>
  );
}

export function PartyCard({
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

export function ChipBadge({ state }: { state: ChipState }) {
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
