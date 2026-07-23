type Row = { text: string };

/* ---------------------------------------------------------------------------
   On-brand inline illustrations — stroke-based, ~2px, monochrome + one accent.
   No external images. Kept intentionally simple/geometric to match the
   machined-metal panel language.
--------------------------------------------------------------------------- */

function WatchedOrderIllustration() {
  return (
    <svg
      viewBox="0 0 360 128"
      fill="none"
      className="w-full h-auto"
      aria-hidden="true"
    >
      {/* the open order card, sitting exposed in the middle */}
      <rect
        x="118"
        y="40"
        width="124"
        height="66"
        rx="3"
        stroke="var(--color-iron-red)"
        strokeWidth="2"
        strokeDasharray="5 4"
        fill="color-mix(in oklab, var(--color-iron-red) 6%, transparent)"
      />
      <line x1="134" y1="58" x2="226" y2="58" stroke="var(--color-iron-red)" strokeWidth="2" opacity="0.6" />
      <line x1="134" y1="70" x2="206" y2="70" stroke="var(--color-iron-red)" strokeWidth="2" opacity="0.4" />
      <line x1="134" y1="82" x2="216" y2="82" stroke="var(--color-iron-red)" strokeWidth="2" opacity="0.4" />

      {/* watcher eyes, ringed around the card, gaze lines converging on it */}
      {[
        { cx: 34, cy: 30 },
        { cx: 34, cy: 98 },
        { cx: 326, cy: 30 },
      ].map((e, i) => (
        <g key={i}>
          <line
            x1={e.cx}
            y1={e.cy}
            x2={180}
            y2={73}
            stroke="var(--color-iron-red)"
            strokeWidth="1.5"
            strokeDasharray="2 4"
            opacity="0.45"
          />
          <ellipse cx={e.cx} cy={e.cy} rx="14" ry="9" stroke="var(--color-iron-red)" strokeWidth="2" />
          <circle cx={e.cx} cy={e.cy} r="3.4" fill="var(--color-iron-red)" />
        </g>
      ))}

      {/* an arrow front-running the order */}
      <path
        d="M250 106 L300 106"
        stroke="var(--color-iron-red)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M292 98 L302 106 L292 114"
        stroke="var(--color-iron-red)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function SealedProofIllustration() {
  return (
    <svg
      viewBox="0 0 360 128"
      fill="none"
      className="w-full h-auto"
      aria-hidden="true"
    >
      {/* sealed order box */}
      <rect
        x="46"
        y="42"
        width="120"
        height="62"
        rx="3"
        stroke="var(--color-ice)"
        strokeWidth="2"
        fill="color-mix(in oklab, var(--color-ice) 7%, transparent)"
      />
      <rect x="86" y="52" width="40" height="26" rx="2" stroke="var(--color-ice)" strokeWidth="2" />
      <path
        d="M94 52v-8a12 12 0 0 1 24 0v8"
        stroke="var(--color-ice)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="106" cy="65" r="2.6" fill="var(--color-ice)" />

      {/* dashed link, order to independent proof */}
      <line
        x1="166"
        y1="73"
        x2="244"
        y2="73"
        stroke="var(--color-ice)"
        strokeWidth="1.5"
        strokeDasharray="3 5"
        opacity="0.55"
      />

      {/* separate proof badge with a check */}
      <circle cx="284" cy="73" r="34" stroke="var(--color-ice)" strokeWidth="2" fill="color-mix(in oklab, var(--color-ice) 7%, transparent)" />
      <path
        d="M270 74l9 9 17-19"
        stroke="var(--color-ice)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const WITHOUT_ROWS: Row[] = [
  { text: "Order visible before it fills — anyone watching the mempool can front-run you." },
  { text: "Price moves against you — thin FXRP liquidity means real slippage on size." },
  { text: "OTC has no settlement guarantee — you send first and hope they pay." },
];

const WITH_ROWS: Row[] = [
  { text: "Quotes sealed in a TEE — side, size, and counterparty never exposed." },
  { text: "Fair price enforced on-chain — within ±1% of the live FTSOv2 mid, or the contract reverts." },
  { text: "Settlement proven, not trusted — FXRP releases only against an FDC proof of payment; default slashes the maker's 1% bond to you." },
];

function Row({ text, accent }: { text: string; accent: "iron-red" | "ice" }) {
  return (
    <li className="flex gap-3.5 py-4 border-t border-steel-line first:border-t-0">
      <span
        className={`mt-2 h-[5px] w-[5px] shrink-0 rounded-full ${
          accent === "iron-red" ? "bg-iron-red" : "bg-ice"
        }`}
        style={
          accent === "ice"
            ? { boxShadow: "0 0 8px 1px color-mix(in oklab, var(--color-ice) 70%, transparent)" }
            : undefined
        }
      />
      <span className="text-[0.95rem] leading-[1.65] text-ink-2">{text}</span>
    </li>
  );
}

export default function WithoutWith() {
  return (
    <section id="without-with" className="py-20 sm:py-28">
      <div className="mx-auto max-w-[1120px] px-6 sm:px-8">
        <p className="mono-label text-[0.72rem] text-ink-3 mb-4">The problem, and the fix</p>
        <h2 className="font-display font-semibold text-[1.9rem] sm:text-[2.4rem] leading-[1.12] tracking-tight max-w-2xl text-balance mb-14">
          Public DEX or a trust-me OTC chat, <span className="text-ink-3">versus</span> a sealed
          desk with proof.
        </h2>

        <div className="grid gap-6 lg:grid-cols-2">
          <div className="panel panel-hover p-8 sm:p-10">
            <p className="mono-label text-[0.68rem] text-iron-red mb-6">Without WhisperDesk</p>
            <div className="mb-7 -mt-1">
              <WatchedOrderIllustration />
            </div>
            <ul>
              {WITHOUT_ROWS.map((row) => (
                <Row key={row.text} text={row.text} accent="iron-red" />
              ))}
            </ul>
            <p className="mt-7 pt-6 border-t border-steel-line text-[0.9rem] text-ink-3">
              Outcome:{" "}
              <span className="text-ink-2">leaked intent, worse fills, counterparty risk.</span>
            </p>
          </div>

          <div className="panel panel-hover p-8 sm:p-10">
            <p className="mono-label text-[0.68rem] text-ice mb-6">With WhisperDesk</p>
            <div className="mb-7 -mt-1">
              <SealedProofIllustration />
            </div>
            <ul>
              {WITH_ROWS.map((row) => (
                <Row key={row.text} text={row.text} accent="ice" />
              ))}
            </ul>
            <p className="mt-7 pt-6 border-t border-steel-line text-[0.9rem] text-ink-3">
              Outcome:{" "}
              <span className="text-ink-2">
                private execution, guaranteed delivery-vs-payment.
              </span>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
