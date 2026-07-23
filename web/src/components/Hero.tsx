"use client";

import SplitText from "@/components/react-bits/SplitText";

const FROM = { opacity: 0, y: 28 };
const TO = { opacity: 1, y: 0 };

export default function Hero() {
  return (
    <section id="top" className="pt-20 pb-24 sm:pt-28 sm:pb-32">
      <div className="mx-auto max-w-[1120px] px-6 sm:px-8">
        <p className="mono-label text-[0.72rem] text-ink-3 mb-7">
          Private OTC desk · XRP ↔ FXRP · Flare Confidential Compute
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

        <p className="mt-7 max-w-[62ch] text-[1.05rem] leading-[1.7] text-ink-2">
          A dark OTC desk for institutional XRP↔FXRP block trades. Quotes are sealed
          inside a Trusted Execution Environment, so no one front-runs your order —
          and settlement is delivery-versus-payment: the escrow releases FXRP only
          against a Flare Data Connector proof of the exact XRPL payment.
        </p>

        <div id="hero-ctas" className="mt-10 flex flex-wrap items-center gap-4">
          <a
            href="#flow"
            className="px-6 py-3 bg-ice text-vault-0 font-medium text-[0.95rem] hover:bg-ice-deep hover:text-ink transition-colors duration-300"
          >
            See the DvP flow
          </a>
          <a
            href="#trust"
            className="px-6 py-3 border border-steel-line-2 text-ink-2 hover:text-ink hover:border-ice-deep/60 font-medium text-[0.95rem] transition-colors duration-300"
          >
            Read the trust model
          </a>
        </div>
      </div>
    </section>
  );
}
