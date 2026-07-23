type Row = { text: string };

/* ---------------------------------------------------------------------------
   The illustration is a single idea shown twice: the *same* order ticket, once
   exposed and once sealed. Left ticket is fully legible (iron-red) — the market
   reads your side and size. Right ticket has those exact fields redacted (ice)
   — sealed inside a TEE, nothing to read. Same layout on both, so the only
   thing the eye catches is: readable vs blacked-out.
--------------------------------------------------------------------------- */

function IconEye({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

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
      <path
        d="M5 12.5 10 17l9-11"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* a blacked-out field — reads instantly as "redacted" */
function Redaction({ width }: { width: string }) {
  return (
    <span
      className="inline-block h-[0.82rem] rounded-[3px] align-middle"
      style={{
        width,
        backgroundColor: "color-mix(in oklab, var(--color-ink-3) 52%, var(--color-vault-0))",
        backgroundImage:
          "repeating-linear-gradient(115deg, rgba(255,255,255,0.09) 0 2px, transparent 2px 6px)",
      }}
    />
  );
}

function TicketRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 border-t border-steel-line/70 first:border-t-0">
      <span className="mono-label text-[0.54rem] text-ink-3">{label}</span>
      <span className="flex items-center">{children}</span>
    </div>
  );
}

function OrderTicket({ sealed }: { sealed: boolean }) {
  const accent = sealed ? "var(--color-ice)" : "var(--color-iron-red)";
  const value = "mono-data text-[0.82rem] text-ink";
  return (
    <div
      className="rounded-lg border p-4 sm:p-5"
      style={{
        borderColor: `color-mix(in oklab, ${accent} 34%, var(--color-steel-line))`,
        background: "linear-gradient(180deg, var(--color-vault-2), var(--color-vault-1))",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.045)",
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="mono-label text-[0.54rem] text-ink-3">Order ticket · OTC</span>
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{
            backgroundColor: accent,
            boxShadow: `0 0 8px 1px color-mix(in oklab, ${accent} 70%, transparent)`,
          }}
        />
      </div>

      <TicketRow label="Side">
        {sealed ? <Redaction width="3rem" /> : <span className={value}>SELL</span>}
      </TicketRow>
      <TicketRow label="Size">
        {sealed ? <Redaction width="5.2rem" /> : <span className={value}>5,000 FXRP</span>}
      </TicketRow>
      <TicketRow label="Counterparty">
        {sealed ? <Redaction width="4rem" /> : <span className={value}>open book</span>}
      </TicketRow>

      <div className="mt-3.5 pt-3.5 flex items-center justify-between border-t border-steel-line">
        <span className="inline-flex items-center gap-1.5" style={{ color: accent }}>
          {sealed ? <IconLock className="h-3.5 w-3.5" /> : <IconEye className="h-3.5 w-3.5" />}
          <span className="mono-label text-[0.54rem]">
            {sealed ? "Sealed in a TEE" : "Seen by the market"}
          </span>
        </span>
        <span
          className="mono-data text-[0.72rem] inline-flex items-center gap-1"
          style={{ color: accent }}
        >
          {sealed ? (
            <>
              fair fill <IconCheck className="h-3 w-3" />
            </>
          ) : (
            <>slips −1.8%&nbsp;▼</>
          )}
        </span>
      </div>
    </div>
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
            <div className="mb-8">
              <OrderTicket sealed={false} />
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
            <div className="mb-8">
              <OrderTicket sealed={true} />
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
