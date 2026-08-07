"use client";

/* ---------------------------------------------------------------------------
   MarketReference — the reference price, shown where the trade is happening.

   A desk that claims its matches are bounded by an oracle should show that
   oracle. This is the number the escrow re-reads inside lock(): if a quote
   sits more than 1% away from it, the contract refuses the match no matter
   what the enclave signed. Putting it beside the flow turns the ±1% band from
   a documented promise into something a judge can watch move.

   It refreshes on a slow interval rather than per action: FTSOv2 publishes on
   its own cadence, and polling harder would only add RPC load to make the same
   number arrive no sooner.
--------------------------------------------------------------------------- */

import { useEffect, useState } from "react";

const REFRESH_MS = 30_000;

export default function MarketReference() {
  const [xrpUsd, setXrpUsd] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const read = async () => {
      try {
        const res = await fetch("/api/price");
        if (!res.ok) throw new Error(String(res.status));
        const data: { xrpUsd?: string } = await res.json();
        if (cancelled) return;
        if (data.xrpUsd && Number(data.xrpUsd) > 0) {
          setXrpUsd(data.xrpUsd);
          setStale(false);
        }
      } catch {
        // Keep the last good number but say so: a price presented as current when it may not be
        // is worse than one openly labelled as possibly behind.
        if (!cancelled) setStale(true);
      }
    };

    read();
    const t = setInterval(read, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // Band edges, derived the way lock() derives them — inclusive on both sides.
  const mid = xrpUsd === null ? null : Number(xrpUsd);
  const lo = mid === null ? null : mid * 0.99;
  const hi = mid === null ? null : mid * 1.01;

  return (
    <div className="panel overflow-hidden">
      <div className="px-5 py-3.5 border-b border-steel-line flex items-center justify-between gap-3">
        <p className="mono-label text-[0.6rem] text-ice">Market reference</p>
        <p className="mono-label text-[0.54rem] text-ink-3">XRP / USD</p>
      </div>

      <div className="px-5 py-4">
        <p className="mono-data text-[1.6rem] text-ink leading-none tabular-nums">
          {mid === null ? "—" : mid.toFixed(6)}
        </p>

        <div className="flex items-center gap-2 mt-3">
          <span
            className={`h-1.5 w-1.5 rounded-full ${stale ? "bg-ink-3" : "bg-ice animate-pulse"}`}
            aria-hidden="true"
          />
          <p className="mono-label text-[0.54rem] text-ink-3">
            {stale ? "Last known · feed unreachable" : "Live · FTSOv2 onchain feed"}
          </p>
        </div>
      </div>

      {lo !== null && hi !== null && (
        <div className="px-5 py-3.5 border-t border-steel-line bg-vault-2/60">
          <p className="mono-label text-[0.54rem] text-ink-3">Match must land inside ±1%</p>
          <p className="mono-data text-[0.72rem] text-ink mt-1.5 tabular-nums">
            {lo.toFixed(4)} – {hi.toFixed(4)}
          </p>
          {/* Shortened so the rail's three panels clear the fold together. */}
          <p className="mono-label text-[0.5rem] text-ink-3 mt-1.5 leading-snug">
            Re-read by the escrow in <span className="text-ink">lock()</span> — holds even if the
            enclave lies.
          </p>
        </div>
      )}
    </div>
  );
}
