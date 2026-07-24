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
        <section id="demo" className="snap-section py-20 sm:py-28">
          <div className="mx-auto max-w-[1120px] px-6 sm:px-8">
            <p className="mono-label text-[0.72rem] text-ink-3 mb-4">Live demo</p>
            <h1 className="font-display font-semibold text-[1.9rem] sm:text-[2.6rem] leading-[1.1] tracking-tight max-w-2xl text-balance">
              Watch it settle for real.
            </h1>
            <p className="mt-5 max-w-[58ch] text-[1.02rem] leading-[1.7] text-ink-2">
              One click runs a genuine DvP settlement on Coston2 and XRPL testnet — sealed lock, XRPL
              payment, Flare Data Connector proof, then release. Every line below links to a real
              transaction.
            </p>

            <DemoConsole />
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
