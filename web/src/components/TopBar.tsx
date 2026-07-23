import Logo from "@/components/Logo";

const NAV = [
  { label: "Product", href: "#without-with" },
  { label: "Flow", href: "#flow" },
  { label: "Trust", href: "#trust" },
  { label: "Proof", href: "#proof" },
];

export default function TopBar() {
  return (
    <header className="border-b border-steel-line/70">
      <div className="mx-auto max-w-[1120px] px-6 sm:px-8 h-16 flex items-center justify-between">
        <a href="#top" className="shrink-0">
          <Logo />
        </a>
        <nav className="hidden md:flex items-center gap-8">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="mono-label text-[0.7rem] text-ink-2 hover:text-ink transition-colors duration-300"
            >
              {item.label}
            </a>
          ))}
        </nav>
        <a
          href="#flow"
          className="mono-label text-[0.68rem] px-4 py-2 border border-steel-line-2 text-ink-2 hover:text-ink hover:border-ice-deep/60 transition-colors duration-300"
        >
          See it settle
        </a>
      </div>
    </header>
  );
}
