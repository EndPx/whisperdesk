type Row = { text: string };

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
