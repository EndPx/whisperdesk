type Zone = {
  eyebrow: string;
  title: string;
  body: string;
  points: string[];
  accent: "ice" | "ink";
};

const ZONES: Zone[] = [
  {
    eyebrow: "Private · enclave",
    title: "Trusted for secrecy",
    body: "The sealed order book, the matching engine, and the TEE signing key live here. This layer authorizes matches — it never holds funds.",
    points: ["Sealed RFQ book", "In-band matching", "TEE signing key"],
    accent: "ice",
  },
  {
    eyebrow: "On-chain · Coston2",
    title: "Enforces every rule",
    body: "DvPEscrow and BondLedger verify the enclave's signature, re-check the FTSOv2 band, consume the FDC proof, and run the deadline + slashing logic.",
    points: ["Verify enclave signature", "Re-check FTSO band", "Consume FDC proof · slash on default"],
    accent: "ice",
  },
  {
    eyebrow: "Worst case",
    title: "Bounded, not catastrophic",
    body: "A fully-compromised enclave can at most fill at the edge of the ±1% band — a quantified 1% loss, never theft. The enclave never custodies funds.",
    points: ["Max loss ±1% of mid", "Funds never pass through the TEE", "No key custody, no theft path"],
    accent: "ink",
  },
];

export default function TrustModel() {
  return (
    <section id="trust" className="py-20 sm:py-28">
      <div className="mx-auto max-w-[1120px] px-6 sm:px-8">
        <p className="mono-label text-[0.72rem] text-ink-3 mb-4">The trust model</p>
        <h2 className="font-display font-semibold text-[1.9rem] sm:text-[2.4rem] leading-[1.12] tracking-tight max-w-2xl text-balance mb-14">
          Trust the enclave for secrecy. Trust the chain for the rules.
        </h2>

        <div className="grid gap-px bg-steel-line lg:grid-cols-3">
          {ZONES.map((zone) => (
            <div key={zone.title} className="bg-vault-2 p-8 sm:p-9 panel-hover">
              <p
                className={`mono-label text-[0.66rem] mb-5 ${
                  zone.accent === "ice" ? "text-ice" : "text-ink-3"
                }`}
              >
                {zone.eyebrow}
              </p>
              <h3 className="font-display font-semibold text-[1.3rem] text-ink mb-4 tracking-tight">
                {zone.title}
              </h3>
              <p className="text-[0.92rem] leading-[1.65] text-ink-2 mb-6">{zone.body}</p>
              <ul className="space-y-2.5">
                {zone.points.map((point) => (
                  <li
                    key={point}
                    className="mono-data text-[0.75rem] text-ink-3 border-t border-steel-line pt-2.5 first:border-t-0 first:pt-0"
                  >
                    {point}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
