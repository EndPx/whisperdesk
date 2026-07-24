import Logo from "@/components/Logo";

const LINKS = [
  { label: "GitHub", href: "https://github.com/EndPx/whisperdesk" },
  { label: "Live enclave", href: "https://fce.endpx.cloud/info" },
];

export default function Footer() {
  return (
    <footer className="border-t border-steel-line/70 py-10">
      <div className="mx-auto max-w-[1120px] px-6 sm:px-8 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <Logo />
        <p className="mono-label text-[0.66rem] text-ink-3">
          Flare Summer Signal · Bounty 2 (Confidential Compute) · live on Coston2
        </p>
        <nav className="flex items-center gap-6">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="mono-label text-[0.68rem] text-ink-2 hover:text-ink transition-colors duration-300"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
