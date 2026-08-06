import type { Metadata } from "next";
import Link from "next/link";
import DemoConsole from "@/components/DemoConsole";

export const metadata: Metadata = {
  title: "WhisperDesk — terminal",
  description: "Run a real DvP settlement on Coston2 + XRPL testnet, with real transaction links.",
};

/* ---------------------------------------------------------------------------
   /demo is a terminal, not another page of the site.

   It carried the marketing TopBar and the site Footer, so the working screen
   opened under a row of links back to the pitch and closed with another. A desk
   should feel like an application you are inside of, so this route drops the
   site chrome and keeps exactly one way back.
--------------------------------------------------------------------------- */

export default function DemoPage() {
  return (
    <main className="min-h-screen flex flex-col">
      {/* Terminal chrome: an identity, a context line, an exit. Nothing to browse. */}
      <header className="border-b border-steel-line px-5 sm:px-8 py-3 flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <span className="font-display font-semibold text-[0.95rem] tracking-tight text-ink">
            WhisperDesk
          </span>
          <span className="mono-label text-[0.54rem] text-ink-3">
            OTC block · Coston2 + XRPL testnet
          </span>
        </div>
        <Link
          href="/"
          className="mono-label text-[0.54rem] text-ink-3 hover:text-ice transition-colors duration-300"
        >
          ← Back to site
        </Link>
      </header>

      <div className="flex-1 px-5 sm:px-8 py-5">
        <div className="mx-auto max-w-[1600px]">
          <DemoConsole />
        </div>
      </div>
    </main>
  );
}
