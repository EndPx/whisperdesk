import type { Metadata } from "next";
import TopBar from "@/components/TopBar";
import Footer from "@/components/Footer";
import DemoConsole from "@/components/DemoConsole";

export const metadata: Metadata = {
  title: "Live demo — WhisperDesk",
  description:
    "Run a real DvP settlement on Coston2 + XRPL testnet, stage by stage, with real transaction links.",
};

export default function DemoPage() {
  return (
    <>
      <TopBar />
      <main className="flex-1">
        {/* Wide and short, because this is a terminal rather than an article. The old 1120px column
            with 7rem of vertical padding pushed the seats and the rail below the fold before anyone
            had done anything — the first impression was a scrollbar. */}
        <section id="demo" className="snap-section py-5 sm:py-6">
          <div className="mx-auto max-w-[1600px] px-5 sm:px-8">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              <h1 className="font-display font-semibold text-[1.5rem] sm:text-[1.85rem] leading-[1.15] tracking-tight">
                Watch it settle for real.
              </h1>
              <p className="mono-label text-[0.58rem] text-ink-3 max-w-[62ch] leading-relaxed">
                A genuine DvP settlement on Coston2 + XRPL testnet — sealed lock, XRPL payment, FDC
                proof, release. Every line links to a real transaction.
              </p>
            </div>

            <DemoConsole />
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
