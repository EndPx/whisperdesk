"use client";

/* ---------------------------------------------------------------------------
   DeskHome — one panel. No seats, no role picked at a door.

   This replaces a full-page chooser that asked "are you the taker or the
   maker?" before showing anything. No exchange asks that. You do not tell a
   swap venue whether you are a liquidity provider; you take an action and the
   role follows from it. Asking first is a walkthrough's habit — it front-loads
   a concept the product should simply demonstrate.

   So the desk shows what a desk shows: a ticket to write an order, and the book
   of orders already open. Write one and you are the taker. Quote one and you
   are the maker. Same screen, same session, and those two words appear only
   where they describe what already happened.

   The wallet gates the content, never the frame. The shell — sections, network,
   connect — stays visible while disconnected, because hiding an application
   behind a splash makes a visitor prove intent before they can see what they
   are agreeing to.
--------------------------------------------------------------------------- */

import { useCallback, useEffect, useState } from "react";
import { formatUnits } from "ethers";
import { connect, ensureCoston2, WalletRejectionError } from "@/lib/wallet-client";

interface OpenOrder {
  rfqId: string;
  windowEndsAt: number; // epoch SECONDS, straight from the enclave
}

function short(id: string) {
  return `${id.slice(0, 10)}…${id.slice(-6)}`;
}

/** Seconds left, or null once the quoting window has shut. */
function secondsLeft(windowEndsAt: number): number | null {
  const s = windowEndsAt - Math.floor(Date.now() / 1000);
  return s > 0 ? s : null;
}

/** The book, on its own, so it can stay on screen while a trade is running.
 *
 *  Split out for exactly that reason: losing sight of the book the moment you start trading is what
 *  made the old screen feel like a wizard — you were somewhere else now, and the desk had gone.
 *  Here it narrows and stays put.
 *
 *  `compact` drops the explanatory empty state, which earns its space on an idle desk and is noise
 *  beside a running trade. */
export function OpenOrdersBook({
  gated,
  onFillOrder,
  compact = false,
}: {
  gated: boolean;
  onFillOrder: () => void;
  compact?: boolean;
}) {
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [, forceTick] = useState(0);

  const hasCountdown = orders.length > 0;
  useEffect(() => {
    if (!hasCountdown) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [hasCountdown]);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const res = await fetch("/api/maker/open-rfqs");
        if (!res.ok) return;
        const data: { rfqs?: OpenOrder[] } = await res.json();
        if (!cancelled && Array.isArray(data.rfqs)) setOrders(data.rfqs);
      } catch {
        /* transient — keep the last book */
      }
    };
    void read();
    const t = setInterval(() => void read(), 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const live = orders.filter((o) => secondsLeft(o.windowEndsAt) !== null);

  return (
    <section className="panel overflow-hidden flex flex-col">
      <div className="px-5 py-3.5 border-b border-steel-line flex items-baseline justify-between gap-3">
        <p className="mono-label text-[0.6rem] text-ice">Open orders</p>
        <p className="mono-label text-[0.5rem] text-ink-3 tabular-nums">{live.length} quoting now</p>
      </div>

      <div className="flex-1">
        {live.length === 0 ? (
          <div className="px-5 py-8">
            <p className="mono-data text-[0.8rem] text-ink-3">The book is empty.</p>
            {!compact && (
              <p className="mono-label text-[0.54rem] text-ink-3 mt-2 leading-relaxed max-w-[44ch]">
                Orders appear here the moment anyone writes one, in this browser or another. Write
                one yourself and it shows on every other desk within five seconds.
              </p>
            )}
          </div>
        ) : (
          <ul>
            {live.map((o) => {
              const left = secondsLeft(o.windowEndsAt);
              return (
                <li
                  key={o.rfqId}
                  className="px-5 py-3.5 border-b border-steel-line last:border-b-0 flex items-center gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="mono-data text-[0.78rem] text-ink truncate">{short(o.rfqId)}</p>
                    {/* Deliberately nothing else. Size, limit, side and author stay inside the
                        enclave — a book that showed them would be an order book, not a dark one. */}
                    <p className="mono-label text-[0.5rem] text-ink-3 mt-1.5">
                      sealed · you price it blind
                    </p>
                  </div>
                  <p className="mono-data text-[0.72rem] text-ice tabular-nums shrink-0">
                    {left !== null
                      ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
                      : "—"}
                  </p>
                  <button
                    type="button"
                    onClick={onFillOrder}
                    disabled={gated}
                    className="mono-label text-[0.58rem] px-3.5 py-2 border border-ice/50 text-ice hover:bg-ice/10 transition-colors duration-300 shrink-0 disabled:opacity-30 disabled:pointer-events-none"
                  >
                    Quote it
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

export default function DeskHome({
  address,
  hasProvider,
  onConnected,
  onPlaceOrder,
  onFillOrder,
  tradeOpen = false,
}: {
  address: string | null;
  hasProvider: boolean | null;
  onConnected: (addr: string) => void;
  onPlaceOrder: () => void;
  onFillOrder: () => void;
  /** A trade is running below. The ticket stays visible — it is where you just were — but stops
   *  offering to start another, which would read as a second, competing action. */
  tradeOpen?: boolean;
}) {
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [terms, setTerms] = useState<{ minBlockRaw: string; midUsdE18: string } | null>(null);

  // The book's own state moved into OpenOrdersBook — it is the same component the running trade
  // keeps beside it, so there is one implementation of the book rather than two that can drift.

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/taker/rfq/prepare");
        if (!res.ok) return;
        const data: { minBlockRaw?: string; midUsdE18?: string } = await res.json();
        if (!cancelled && data.minBlockRaw && data.midUsdE18) {
          setTerms({ minBlockRaw: data.minBlockRaw, midUsdE18: data.midUsdE18 });
        }
      } catch {
        /* the ticket still opens; only the hint under it goes missing */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const addr = await connect();
      await ensureCoston2();
      onConnected(addr);
    } catch (err) {
      setConnectError(
        err instanceof WalletRejectionError
          ? "You rejected the connection in your wallet."
          : err instanceof Error
            ? err.message
            : "could not connect"
      );
    } finally {
      setConnecting(false);
    }
  }, [onConnected]);

  const gated = !address;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-3">
      {/* --- Ticket: write an order ------------------------------------------------------ */}
      <section className="panel overflow-hidden flex flex-col">
        <div className="px-5 py-3.5 border-b border-steel-line flex items-baseline justify-between gap-3">
          <p className="mono-label text-[0.6rem] text-ice">Sell FXRP for XRP</p>
          <p className="mono-label text-[0.5rem] text-ink-3">sealed · block</p>
        </div>

        <div className="px-5 py-5 flex-1">
          <p className="text-[0.9rem] leading-[1.55] text-ink-2 max-w-[46ch]">
            Write your own size and limit. The desk seals it before anyone sees it — including the
            desk — and a maker you never meet prices it blind.
          </p>

          {terms && (
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 max-w-[30ch]">
              <dt className="mono-label text-[0.5rem] text-ink-3">Minimum block</dt>
              <dd className="mono-data text-[0.72rem] text-ink tabular-nums text-right">
                {formatUnits(terms.minBlockRaw, 6)} FXRP
              </dd>
              <dt className="mono-label text-[0.5rem] text-ink-3">Reference mid</dt>
              <dd className="mono-data text-[0.72rem] text-ink tabular-nums text-right">
                {Number(formatUnits(terms.midUsdE18, 18)).toFixed(6)}
              </dd>
            </dl>
          )}
        </div>

        <div className="px-5 py-4 border-t border-steel-line">
          {gated ? (
            <WalletGate
              hasProvider={hasProvider}
              connecting={connecting}
              error={connectError}
              onConnect={handleConnect}
              what="to write an order"
            />
          ) : tradeOpen ? (
            /* The ticket does not disappear while a trade runs — it is where you just were, and
               removing it is exactly the page-change this layout exists to avoid. It simply stops
               inviting a second order. */
            <p className="mono-label text-[0.58rem] text-ink-3 text-center py-1.5 leading-relaxed">
              Your trade is running below.
            </p>
          ) : (
            <button
              type="button"
              onClick={onPlaceOrder}
              className="mono-label text-[0.66rem] w-full px-5 py-2.5 bg-ice text-vault-0 hover:bg-ice-deep hover:text-ink transition-colors duration-300"
            >
              Write an order
            </button>
          )}
        </div>
      </section>

      {/* The same component the running trade keeps beside it — one book, not two that drift. */}
      <OpenOrdersBook gated={gated} onFillOrder={onFillOrder} />
    </div>
  );
}

/** The gate. Content only — the shell around it stays visible while disconnected. */
function WalletGate({
  hasProvider,
  connecting,
  error,
  onConnect,
  what,
}: {
  hasProvider: boolean | null;
  connecting: boolean;
  error: string | null;
  onConnect: () => void;
  what: string;
}) {
  if (hasProvider === false) {
    return (
      <p className="mono-label text-[0.58rem] text-ink-3 leading-relaxed">
        No wallet in this browser. Both sides of a trade here sign their own transactions, so this
        needs an injected wallet on Coston2.
      </p>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={onConnect}
        disabled={connecting || hasProvider === null}
        className="mono-label text-[0.66rem] w-full px-5 py-2.5 bg-ice text-vault-0 hover:bg-ice-deep hover:text-ink transition-colors duration-300 disabled:opacity-40 disabled:pointer-events-none"
      >
        {connecting ? "Check your wallet…" : "Connect wallet"}
      </button>
      <p className="mono-label text-[0.5rem] text-ink-3 mt-2.5 leading-relaxed">
        Connect {what}. Coston2 testnet — nothing here touches mainnet funds.
      </p>
      {error && <p className="mono-label text-[0.58rem] text-iron-red mt-2">{error}</p>}
    </>
  );
}
