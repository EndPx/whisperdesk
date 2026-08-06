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
            {/* No headline, no standfirst. A trading screen opens on the instrument, not on a title
                card — and everything this page could say about itself is one click back on the
                landing page the judge just came from. */}
            <DemoConsole />
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
