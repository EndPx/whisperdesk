/* ---------------------------------------------------------------------------
   RealAssetProof — the answer to "sure, but is that a real asset?", placed at
   the door rather than buried in the docs.

   The seats beside this panel settle MockFXRP, and a judge is right to ask what
   that is worth. So the strongest counter-evidence sits next to the question:
   two complete settlements against the genuine FAssets-minted FXRP, each with
   its own explorer link, on an escrow anyone can inspect.

   Two runs rather than one is the whole point. A single settlement proves a
   path exists; a second one, minted and run from scratch afterwards, proves it
   is a mechanism. Static links on purpose — this is a claim about the past, and
   the past does not need a fetch.
--------------------------------------------------------------------------- */

const COSTON2_TX = (h: string) => `https://coston2-explorer.flare.network/tx/${h}`;
const XRPL_TX = (h: string) => `https://testnet.xrpl.org/transactions/${h}`;

const RUNS: { label: string; steps: { name: string; href: string }[] }[] = [
  {
    label: "First run",
    steps: [
      { name: "direct mint", href: COSTON2_TX("0xfc5255afa0cadee272275fa018b3a21a0b6aa69b497f01cae622045c5eb55c4d") },
      { name: "XRP paid", href: XRPL_TX("9188C50DC94E3D3B314B5B99E5ABE4DB3585E1C926ABB3125542EA20B3490ADF") },
      { name: "release()", href: COSTON2_TX("0x9ea70cafebbf0e6b937216af9cea374d798e6eb0466b7104fe40fd7e256aaea3") },
    ],
  },
  {
    label: "Second run",
    steps: [
      { name: "direct mint", href: COSTON2_TX("0xf2b1c06c81c215d82969ed2e6a4cdef23048dbf16eea301b3e8fc4f10d7bca4b") },
      { name: "XRP paid", href: XRPL_TX("0C0DB6C6FB3ECCC9CAA7820B16987F4D3049CB14E26ACDF30A535D6B0BA12C1B") },
      { name: "release()", href: COSTON2_TX("0x5934b0ac377ec4f256dd22216ab070ee14b5060ccf16559bc5667200d08ed6a3") },
    ],
  },
];

const FXRP_TOKEN =
  "https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7";

export default function RealAssetProof() {
  return (
    <div className="panel overflow-hidden mt-10">
      <div className="px-6 py-4 border-b border-steel-line">
        <p className="mono-label text-[0.6rem] text-ice">Settled in the real asset — twice</p>
        <p className="text-[0.9rem] text-ink mt-1.5 font-medium">
          The seats above trade a mintable test token. The mechanism does not need one.
        </p>
      </div>

      <div className="px-6 py-4">
        <p className="mono-label text-[0.56rem] text-ink-3 leading-relaxed">
          The demo settles MockFXRP because its faucet has to fund every visitor on request. The same
          contracts, driven by the same commands, have twice settled{" "}
          <a href={FXRP_TOKEN} target="_blank" rel="noopener noreferrer" className="text-ice hover:underline">
            genuine FAssets-minted FXRP
          </a>{" "}
          — acquired by a v1.3 direct mint we initiated on the real protocol, not handed to us.
        </p>

        <div className="mt-4 space-y-3">
          {RUNS.map((run) => (
            <div key={run.label} className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <span className="mono-label text-[0.56rem] text-ink-3 w-[5.5rem] shrink-0">{run.label}</span>
              {run.steps.map((s, i) => (
                <span key={s.name} className="flex items-center gap-2">
                  {i > 0 && <span className="mono-label text-[0.56rem] text-ink-3/50">→</span>}
                  <a
                    href={s.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mono-label text-[0.58rem] text-ice hover:underline"
                  >
                    {s.name}
                  </a>
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="px-6 py-3.5 border-t border-steel-line bg-vault-2/60">
        <p className="mono-label text-[0.54rem] text-ink-3 leading-relaxed">
          One settlement proves a path exists. The second was minted and run from scratch afterwards,
          which is what makes it a mechanism rather than an anecdote.
        </p>
      </div>
    </div>
  );
}
