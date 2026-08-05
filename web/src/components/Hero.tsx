"use client";

import SplitText from "@/components/react-bits/SplitText";
import SealedRfq from "@/components/SealedRfq";

const FROM = { opacity: 0, y: 28 };
const TO = { opacity: 1, y: 0 };

export default function Hero() {
  return (
    <section id="top" className="pt-20 pb-24 sm:pt-28 sm:pb-32">
      {/* Two columns from lg up: the argument on the left, the evidence of it on the right.
          The panel shows a maker's actual view of a sealed RFQ, so "you quote blind" is
          demonstrated before the paragraph gets a chance to assert it. Below lg it stacks. */}
      <div className="mx-auto max-w-[1120px] px-6 sm:px-8 grid lg:grid-cols-[minmax(0,1fr)_360px] gap-y-12 lg:gap-x-14 items-start">
        <div>
        <p className="mono-label text-[0.72rem] text-ink-3 mb-7">
          Private OTC settlement · XRP ↔ FXRP · proven live on Coston2
        </p>

        <h1 className="font-display font-semibold text-[2.5rem] leading-[1.08] sm:text-[3.4rem] sm:leading-[1.06] tracking-tight max-w-3xl text-balance">
          <SplitText
            text="Move size in a"
            tag="span"
            splitType="words"
            duration={1.1}
            delay={40}
            from={FROM}
            to={TO}
            className="text-ink"
          />{" "}
          <SplitText
            text="whisper."
            tag="span"
            splitType="chars"
            duration={1.1}
            delay={40}
            from={FROM}
            to={TO}
            className="text-ice"
          />{" "}
          <SplitText
            text="Settle it on-chain."
            tag="span"
            splitType="words"
            duration={1.1}
            delay={40}
            from={FROM}
            to={TO}
            className="text-ink"
          />
        </h1>

        <p className="mt-7 max-w-[56ch] text-[1.05rem] leading-[1.75] text-ink-2">
          Institutional XRP↔FXRP block trades, settled{" "}
          <em className="not-italic font-semibold text-ice [text-shadow:0_0_20px_rgba(127,227,240,0.4)]">
            across two chains
          </em>{" "}
          with no trusted middleman. Quotes are{" "}
          <strong className="font-semibold text-ink">sealed inside a TEE</strong>, so nothing can be
          front-run in flight — and FXRP is released{" "}
          <strong className="font-semibold text-ink">only against an FDC-proven XRPL payment</strong>.
          Proven end to end on Flare testnet.
        </p>

        <div id="hero-ctas" className="mt-10 flex flex-wrap items-center gap-4">
          {/* The primary CTA leaves the page. Both buttons used to be in-page anchors, which meant
              the hero — the one screen every judge sees — offered no route to the live demo at all. */}
          <a
            href="/demo"
            className="px-6 py-3 bg-ice text-vault-0 font-medium text-[0.95rem] hover:bg-ice-deep hover:text-ink transition-colors duration-300"
          >
            Watch it settle live
          </a>
          <a
            href="#flow"
            className="px-6 py-3 border border-steel-line-2 text-ink-2 hover:text-ink hover:border-ice-deep/60 font-medium text-[0.95rem] transition-colors duration-300"
          >
            See the DvP flow
          </a>
        </div>

        {/* Three pillars, one line each: what makes this different (two ledgers), what makes it
            private (sealed), and what makes it safe when a counterparty walks (the bond). */}
        <dl className="mt-12 grid grid-cols-3 gap-x-6 gap-y-2 max-w-[34rem] border-t border-steel-line pt-6">
          {[
            { v: "2 ledgers", k: "settled against one proof" },
            { v: "Sealed", k: "size never leaves the enclave" },
            { v: "1% bond", k: "slashed if the maker defaults" },
          ].map((s) => (
            <div key={s.v}>
              <dt className="font-display font-semibold text-[1.15rem] text-ink tracking-tight">
                {s.v}
              </dt>
              <dd className="mono-label text-[0.56rem] text-ink-3 mt-1.5 leading-relaxed">{s.k}</dd>
            </div>
          ))}
        </dl>
        </div>

        <SealedRfq className="lg:mt-14" />
      </div>
    </section>
  );
}
