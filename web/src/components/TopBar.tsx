import Link from "next/link";
import Logo from "@/components/Logo";

// Labelled by what the reader gets, not by what the section is made of. "Product" and "Flow"
// described our own structure; "Why" and "How it settles" answer the questions a visitor
// actually arrives with.
const NAV = [
  { label: "Why", href: "/#without-with" },
  { label: "How it settles", href: "/#flow" },
  { label: "Trust model", href: "/#trust" },
  { label: "Receipts", href: "/#proof" },
];

export default function TopBar() {
  return (
    <header className="sticky top-0 z-40 border-b border-steel-line/70 bg-vault-0/80 backdrop-blur-md">
      <div className="mx-auto max-w-[1120px] px-6 sm:px-8 h-16 flex items-center justify-between">
        <Link href="/#top" className="shrink-0">
          <Logo />
        </Link>
        <nav className="hidden md:flex items-center gap-8">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="mono-label text-[0.7rem] text-ink-2 hover:text-ink transition-colors duration-300"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        {/* Primary, not a bordered afterthought: once a visitor has scrolled past the hero this
            is the only door to the live demo, so it must outweigh the section links beside it. */}
        <Link
          href="/demo"
          className="mono-label text-[0.68rem] px-4 py-2.5 bg-ice text-vault-0 hover:bg-ice-deep hover:text-ink transition-colors duration-300 shrink-0"
        >
          Enter the desk
        </Link>
      </div>
    </header>
  );
}
