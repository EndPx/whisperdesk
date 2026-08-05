"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LogoMark } from "@/components/Logo";

const CLOSE_MS = 1400;

/**
 * DeskCurtain — the transition into the live desk.
 *
 * Two panels close from the top and bottom edges like vault doors, the mark and a status line
 * fade in behind them, then the route changes. It is theatre, but the theatre is the product's
 * own metaphor: the desk seals before it will trade.
 *
 * Implemented as ONE delegated click listener rather than a wrapper component, so every existing
 * `/demo` link — the nav CTA, the hero CTA, anything added later — gets the transition without
 * being rewritten, and TopBar/Hero stay server components. Everything degrades cleanly: with JS
 * off, or on a middle-click, or for a visitor who asked for reduced motion, the links are plain
 * links and navigate immediately.
 */
export default function DeskCurtain() {
  const router = useRouter();
  const [closing, setClosing] = useState(false);
  const timer = useRef<number | null>(null);

  const isPlainLeftClick = useCallback(
    (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey,
    []
  );

  useEffect(() => {
    router.prefetch("/demo");

    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const link = target?.closest?.('a[href="/demo"]') as HTMLAnchorElement | null;
      if (!link || !isPlainLeftClick(e)) return;

      // Respect the OS setting rather than overriding it — a vestibular trigger is not decoration.
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

      e.preventDefault();
      setClosing(true);
      timer.current = window.setTimeout(() => router.push("/demo"), CLOSE_MS);
    };

    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [router, isPlainLeftClick]);

  return (
    <div
      aria-hidden="true"
      className={`fixed inset-0 z-[200] grid place-items-center transition-opacity duration-300 ${
        closing ? "visible opacity-100" : "invisible opacity-0 pointer-events-none"
      }`}
    >
      <div
        className={`absolute inset-x-0 top-0 h-1/2 origin-top bg-vault-0 transition-transform duration-[550ms] ease-[cubic-bezier(.7,0,.3,1)] ${
          closing ? "scale-y-100" : "scale-y-0"
        }`}
      />
      <div
        className={`absolute inset-x-0 bottom-0 h-1/2 origin-bottom bg-vault-0 transition-transform duration-[550ms] ease-[cubic-bezier(.7,0,.3,1)] ${
          closing ? "scale-y-100" : "scale-y-0"
        }`}
      />

      <div
        className={`relative z-10 flex flex-col items-center gap-5 transition-all duration-500 delay-[350ms] ${
          closing ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-2 scale-95"
        }`}
      >
        <LogoMark size={54} className="text-ink-2 drop-shadow-[0_0_22px_rgba(127,227,240,0.45)]" />
        <p className="mono-label text-[0.72rem] text-ink tracking-[0.2em]">WhisperDesk</p>
        <p className="mono-label text-[0.6rem] text-ink-3">Sealing the desk</p>
        <div className="h-px w-40 bg-steel-line overflow-hidden">
          <div
            className={`h-full bg-ice transition-[width] ease-out ${
              closing ? "w-full duration-[1200ms]" : "w-0 duration-0"
            }`}
          />
        </div>
      </div>
    </div>
  );
}
