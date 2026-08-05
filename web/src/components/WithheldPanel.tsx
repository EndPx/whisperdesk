"use client";

/**
 * WithheldPanel — a standing inventory of what this seat is NOT shown.
 *
 * Every other part of the console reports what happened. This one reports what deliberately did
 * not: the fields the enclave holds and never discloses to the seat you are sitting in. It stays
 * on screen for the whole run rather than appearing once, because the claim it makes is a
 * property of the venue, not a step in a flow.
 *
 * The last line is the load-bearing one. A redacted table invites the reading "the UI is hiding
 * this from me, and something server-side could reveal it"; the point is the opposite — the data
 * was never sent to this browser at all, so there is nothing here to un-hide.
 */

export type WithheldItem = { label: string; note?: string };

function Blocks({ seed }: { seed: number }) {
  // Varying widths per row so the redaction reads as concealed content rather than a UI divider.
  const count = 5 + (seed % 4);
  return (
    <span className="inline-flex gap-[3px]" aria-label="withheld">
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className="block h-[10px] w-[7px] rounded-[1px] bg-ink-3/40 animate-pulse"
          style={{ animationDelay: `${seed * 140 + i * 90}ms`, animationDuration: "3.4s" }}
        />
      ))}
    </span>
  );
}

export default function WithheldPanel({
  title,
  tagline,
  items,
  footer,
  className = "",
}: {
  title: string;
  tagline: string;
  items: WithheldItem[];
  footer: string;
  className?: string;
}) {
  return (
    <div className={`panel overflow-hidden ${className}`}>
      <div className="px-6 py-4 border-b border-steel-line">
        <p className="mono-label text-[0.6rem] text-ice">{title}</p>
        <p className="text-[0.9rem] text-ink mt-1.5 font-medium">{tagline}</p>
      </div>

      <div className="px-6 py-4 space-y-3">
        {items.map((it, i) => (
          <div key={it.label} className="flex items-start justify-between gap-4">
            <span className="mono-label text-[0.6rem] text-ink-3 pt-0.5">
              {it.label}
              {it.note && <span className="block text-[0.54rem] text-ink-3/70 mt-1">{it.note}</span>}
            </span>
            <Blocks seed={i} />
          </div>
        ))}
      </div>

      <div className="px-6 py-4 border-t border-steel-line bg-vault-2/60">
        <p className="mono-label text-[0.56rem] text-ink-3 leading-relaxed">{footer}</p>
      </div>
    </div>
  );
}

/** What a maker is never shown. The rival rows matter most: a maker cannot even learn whether a
 *  competing quote exists, which is what stops quote-shading against a known rival. */
export const MAKER_WITHHELD: WithheldItem[] = [
  { label: "RFQ side", note: "buy or sell" },
  { label: "RFQ size" },
  { label: "Taker's limit price" },
  { label: "Taker identity" },
  { label: "Rival price" },
  { label: "Rival exists?", note: "not even the count" },
];

/** What a taker is never shown before the match is signed. */
export const TAKER_WITHHELD: WithheldItem[] = [
  { label: "Who is quoting you" },
  { label: "How many are quoting" },
  { label: "Losing quotes" },
  { label: "Other takers' orders" },
];
