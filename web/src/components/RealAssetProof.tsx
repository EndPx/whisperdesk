/* ---------------------------------------------------------------------------
   RealAssetProof — the receipts for the asset this desk actually settles.

   This panel used to be a rebuttal. Every seat traded MockFXRP, a judge was
   right to ask what that proved, and the answer was a pair of settlements run
   elsewhere against the genuine asset.

   It is not a rebuttal any more. Flare's own faucet hands out FXRP, which
   removed the only reason the mock existed — the demo faucet had to fund every
   visitor — so both escrows were redeployed against FAssets FXRP and the mock
   is gone. What is left is simply a record: three settlements, each on the real
   token, each with its own explorer link.

   Static on purpose. This is a claim about the past, and the past does not need
   a fetch.
--------------------------------------------------------------------------- */

const COSTON2_TX = (h: string) => `https://coston2-explorer.flare.network/tx/${h}`;
const XRPL_TX = (h: string) => `https://testnet.xrpl.org/transactions/${h}`;

const RUNS: { label: string; steps: { name: string; href: string }[] }[] = [
  {
    label: "First",
    steps: [
      { name: "direct mint", href: COSTON2_TX("0xfc5255afa0cadee272275fa018b3a21a0b6aa69b497f01cae622045c5eb55c4d") },
      { name: "XRP paid", href: XRPL_TX("9188C50DC94E3D3B314B5B99E5ABE4DB3585E1C926ABB3125542EA20B3490ADF") },
      { name: "release()", href: COSTON2_TX("0x9ea70cafebbf0e6b937216af9cea374d798e6eb0466b7104fe40fd7e256aaea3") },
    ],
  },
  {
    label: "Second",
    steps: [
      { name: "direct mint", href: COSTON2_TX("0xf2b1c06c81c215d82969ed2e6a4cdef23048dbf16eea301b3e8fc4f10d7bca4b") },
      { name: "XRP paid", href: XRPL_TX("0C0DB6C6FB3ECCC9CAA7820B16987F4D3049CB14E26ACDF30A535D6B0BA12C1B") },
      { name: "release()", href: COSTON2_TX("0x5934b0ac377ec4f256dd22216ab070ee14b5060ccf16559bc5667200d08ed6a3") },
    ],
  },
  {
    // The run that retired the mock: the first settlement on the escrow this demo now uses.
    label: "This desk",
    steps: [
      { name: "lock()", href: COSTON2_TX("0xc17149be80ed1ee5d87fcfb5156f734aab27ab608021ae013137b1dc6bb07422") },
      { name: "XRP paid", href: XRPL_TX("E81F6AEBEDD3F3781E39C011097C6BF5638E5FBAB829E8242CC85406AA7F06D3") },
      { name: "release()", href: COSTON2_TX("0x0b961b71556e9189b622efaac79b17afe860572663e6d8962c024397a34eb60f") },
    ],
  },
];

const FXRP_TOKEN =
  "https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7";

export default function RealAssetProof() {
  return (
    <div className="panel px-5 py-3.5 mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
      <p className="mono-label text-[0.56rem] text-ice shrink-0">Settles the real asset</p>

      {/* basis, not just a min-width: with the receipts sharing this row the paragraph was the only
          flexible child, so it collapsed to its 24ch floor and read as a narrow gutter of text. A
          real basis keeps a readable measure and lets the receipts wrap below instead. */}
      <p className="mono-label text-[0.52rem] text-ink-3 leading-snug flex-1 basis-[34ch] min-w-[28ch]">
        Every trade here settles{" "}
        <a href={FXRP_TOKEN} target="_blank" rel="noopener noreferrer" className="text-ice hover:underline">
          genuine FAssets FXRP
        </a>{" "}
        — no mock, no stand-in. Nobody can mint it on demand; it exists only against XRP locked in
        FAssets, and Flare&apos;s faucet is where you get some.
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {RUNS.map((run) => (
          <span key={run.label} className="flex items-center gap-1.5">
            <span className="mono-label text-[0.5rem] text-ink-3">{run.label}</span>
            {run.steps.map((s, i) => (
              <span key={s.name} className="flex items-center gap-1.5">
                {i > 0 && <span className="mono-label text-[0.5rem] text-ink-3/50">→</span>}
                <a
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mono-label text-[0.54rem] text-ice hover:underline"
                >
                  {s.name}
                </a>
              </span>
            ))}
          </span>
        ))}
      </div>
    </div>
  );
}
