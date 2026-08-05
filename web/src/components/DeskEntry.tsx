"use client";

export type DeskRole = "one-click" | "wallet" | "maker";

/**
 * DeskEntry — the desk's front door: pick the seat you want to sit in.
 *
 * The console previously opened straight into one mode with the other two seats reduced to small
 * chips, which left the most interesting one — quoting blind against a sealed RFQ — looking like a
 * secondary option. Each card now states what that seat can SEE, and the maker card shows the
 * blindness rather than describing it: the RFQ's fields are drawn as redacted blocks with the
 * reason underneath.
 *
 * Purely presentational. It picks a mode and hands it back; every existing flow downstream is
 * untouched, and the in-console switcher still works for changing seats afterwards.
 */

type Seat = {
  role: DeskRole;
  tag: string;
  name: string;
  sees: string;
  visibleLabel: string;
  visibleValue: string;
  sealedLabel: string;
  sealedBlocks: number;
  sealedNote: string;
  cta: string;
  accent: "ice" | "amber";
};

const SEATS: Seat[] = [
  {
    role: "one-click",
    tag: "No setup",
    name: "Watch the desk trade",
    sees: "Sees the whole trade, both sides.",
    visibleLabel: "You provide",
    visibleValue: "Nothing — the desk's own testnet keys",
    sealedLabel: "Time to settle",
    sealedBlocks: 0,
    sealedNote: "about 4 minutes, FDC round included",
    cta: "Watch it settle",
    accent: "ice",
  },
  {
    role: "wallet",
    tag: "Your wallet",
    name: "Sit as the taker",
    sees: "Sees its own side, and the XRP arrive.",
    visibleLabel: "You receive",
    visibleValue: "Real XRP, on an address you control",
    sealedLabel: "Who fills you",
    sealedBlocks: 7,
    sealedNote: "matched inside the enclave · never on your feed",
    cta: "Enter as the taker",
    accent: "ice",
  },
  {
    role: "maker",
    tag: "Your wallet",
    name: "Sit as the maker",
    sees: "Sees only the price it names.",
    visibleLabel: "Your quote",
    visibleValue: "The price you set, against the FTSOv2 band",
    sealedLabel: "Side · size · limit",
    sealedBlocks: 9,
    sealedNote: "sealed in the enclave · never disclosed to you",
    cta: "Enter as the maker",
    accent: "amber",
  },
];

function RedactedBlocks({ count }: { count: number }) {
  return (
    <span className="inline-flex gap-[3px] py-1" aria-label="sealed">
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className="block h-[10px] w-[7px] rounded-[1px] bg-ink-3/45 animate-pulse"
          style={{ animationDelay: `${i * 90}ms`, animationDuration: "3.2s" }}
        />
      ))}
    </span>
  );
}

export default function DeskEntry({ onPick }: { onPick: (role: DeskRole) => void }) {
  return (
    <div className="mt-10">
      <div className="grid gap-5 lg:grid-cols-3">
        {SEATS.map((s) => {
          const accentText = s.accent === "ice" ? "text-ice" : "text-[#e0a33b]";
          return (
            <div key={s.role} className="panel flex flex-col p-7">
              <p className={`mono-label text-[0.58rem] ${accentText}`}>{s.tag}</p>
              <p className="font-display font-semibold text-[1.2rem] tracking-tight text-ink mt-2.5">
                {s.name}
              </p>
              <p className="text-[0.88rem] leading-[1.6] text-ink-2 mt-1.5">{s.sees}</p>

              <div className="mt-6 border border-steel-line bg-vault-2/60 px-4 py-4">
                <p className="mono-label text-[0.54rem] text-ink-3">{s.visibleLabel}</p>
                <p className="mono-data text-[0.76rem] text-ink mt-1.5 leading-relaxed">
                  {s.visibleValue}
                </p>

                <div className="my-3.5 border-t border-steel-line" />

                <p className="mono-label text-[0.54rem] text-ink-3">{s.sealedLabel}</p>
                {s.sealedBlocks > 0 ? (
                  <RedactedBlocks count={s.sealedBlocks} />
                ) : (
                  <p className="mono-data text-[0.76rem] text-ice mt-1.5">~4 min</p>
                )}
                <p className="mono-label text-[0.52rem] text-ink-3 mt-1.5 leading-relaxed">
                  {s.sealedNote}
                </p>
              </div>

              <button
                type="button"
                onClick={() => onPick(s.role)}
                className={`mono-label text-[0.64rem] mt-6 w-full px-4 py-3 transition-colors duration-300 ${
                  s.role === "one-click"
                    ? "bg-ice text-vault-0 hover:bg-ice-deep hover:text-ink"
                    : "border border-steel-line-2 text-ink-2 hover:text-ink hover:border-ice-deep/60"
                }`}
              >
                {s.cta}
              </button>
            </div>
          );
        })}
      </div>

      <p className="mono-label text-[0.56rem] text-ink-3 mt-6 max-w-[70ch] leading-relaxed">
        All three run a real lock → pay → attest → release on Coston2 + XRPL testnet. Open the maker
        seat in a second window to watch two independent parties get matched without either seeing
        the other&apos;s order.
      </p>
    </div>
  );
}
