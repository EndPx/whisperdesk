"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

// ShapeGrid touches window/canvas — keep it fully client-only so SSR never
// tries to render a <canvas> animation loop.
const ShapeGrid = dynamic(() => import("@/components/react-bits/ShapeGrid"), {
  ssr: false,
});

/**
 * Full-page machined-metal backdrop. Sits fixed behind every section; panels
 * with an opaque `.panel` fill read as raised surfaces above it.
 *
 * Respects prefers-reduced-motion by swapping the animated canvas for a
 * static CSS grid — no rAF loop runs at all in that case.
 */
export default function VaultBackground() {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(mq.matches);
    const onChange = () => setReduceMotion(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <div className="fixed inset-0 z-0" aria-hidden="true">
      {/* machined grid */}
      {reduceMotion ? (
        <div
          className="w-full h-full"
          style={{
            backgroundColor: "#06080b",
            backgroundImage:
              "linear-gradient(rgba(155,170,185,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(155,170,185,0.14) 1px, transparent 1px)",
            backgroundSize: "40px 40px",
          }}
        />
      ) : (
        <ShapeGrid
          shape="square"
          direction="diagonal"
          speed={0.16}
          squareSize={40}
          borderColor="rgba(158, 172, 186, 0.17)"
          hoverFillColor="rgba(127, 227, 240, 0.16)"
          hoverTrailAmount={12}
          vignetteColor="#06080b"
        />
      )}
      {/* ambient light — cold steel wash spilling from top, one faint ice glow at the hero */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 70% at 50% -10%, rgba(158,172,186,0.09) 0%, rgba(158,172,186,0.03) 34%, transparent 60%)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(46% 40% at 20% 26%, rgba(127,227,240,0.08) 0%, transparent 62%)",
        }}
      />
    </div>
  );
}
