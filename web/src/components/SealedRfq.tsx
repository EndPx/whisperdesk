/**
 * SealedRfq — the hero's right-hand panel: a maker's-eye view of a live RFQ.
 *
 * The point of the panel is the contrast INSIDE it. Four fields are sealed, and
 * one — the FTSOv2 band — is deliberately not, because it is the public
 * guardrail the escrow re-checks on-chain. A panel that redacted everything
 * would say "we hide things"; this one says "we hide the order and publish the
 * bound", which is the actual mechanism.
 *
 * Illustrative values, not a live feed: the band is a representative XRP/USD
 * ±1% window. The live numbers are one click away in the demo console, and the
 * caption says so rather than implying this ticks.
 */

const SEALED_FIELDS = [
  { label: "Side", blocks: 4 },
  { label: "Size", blocks: 7 },
  { label: "Limit price", blocks: 5 },
  { label: "Taker", blocks: 9 },
];

function SealedBar({ blocks, delay }: { blocks: number; delay: number }) {
  return (
    <span className="inline-flex gap-[3px]" aria-label="sealed">
      {Array.from({ length: blocks }).map((_, i) => (
        <span
          key={i}
          className="block h-[11px] w-[7px] rounded-[1px] bg-ink-3/45 animate-pulse"
          style={{ animationDelay: `${delay + i * 90}ms`, animationDuration: "3.2s" }}
        />
      ))}
    </span>
  );
}

export default function SealedRfq({ className = "" }: { className?: string }) {
  return (
    <div className={`panel overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-steel-line">
        <p className="mono-label text-[0.6rem] text-ink-3">Sealed RFQ · WD-LIVE-1</p>
        <p className="mono-label text-[0.56rem] text-ice border border-ice/40 px-2 py-1">
          Your view · Maker
        </p>
      </div>

      <div className="px-5 py-4 space-y-3">
        {SEALED_FIELDS.map((f, i) => (
          <div key={f.label} className="flex items-center justify-between gap-4">
            <span className="mono-label text-[0.62rem] text-ink-3 flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-ink-3/70 shrink-0" />
              {f.label}
            </span>
            <SealedBar blocks={f.blocks} delay={i * 220} />
          </div>
        ))}

        <div className="flex items-center justify-between gap-4 pt-3 border-t border-steel-line">
          <span className="mono-label text-[0.62rem] text-ink-2 flex items-center gap-2">
            <span className="ice-dot shrink-0" />
            FTSOv2 band
          </span>
          <span className="mono-data text-[0.78rem] text-ice tabular-nums">1.0714 – 1.0930</span>
        </div>
      </div>

      <div className="px-5 py-3.5 border-t border-steel-line bg-vault-2/60">
        <p className="mono-label text-[0.58rem] text-ink-3 leading-relaxed">
          You quote <span className="text-ink-2">blind</span>. This is not a redacted view — the
          enclave <span className="text-ink-2">never disclosed</span> those fields. The band is
          public on purpose: the escrow re-checks it on-chain.
        </p>
      </div>
    </div>
  );
}
