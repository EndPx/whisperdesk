"use client";

/* ---------------------------------------------------------------------------
   Holdings — what this wallet actually holds, and the two ways the desk tops
   it up.

   Funding used to be step 2 of the trade ("Get demo FXRP for the bond"), which
   framed a housekeeping chore as part of the deal. It isn't. It is wallet
   state, and it is the desk's problem rather than the judge's. Pulling it out
   leaves the numbered steps describing only the trade — connect, receive,
   lock, pay, settle — and gives every balance one place that stays on screen
   for the whole run, so "how much do I hold" is never a question you have to
   scroll to answer.

   The token marks are drawn here rather than imported: an official asset logo
   is someone else's trademark, and a coloured disc keyed to our own palette
   says everything a judge needs (which asset, which chain) without borrowing
   one.
--------------------------------------------------------------------------- */

import { useEffect, useState } from "react";

export type HoldingToken = "FXRP" | "XRP" | "C2FLR";

/** Only the XRP-denominated assets carry a value. C2FLR is testnet gas — pricing it would invent a
 *  market that does not exist, and the one number on this panel that isn't real would undermine
 *  every number that is. */
const PRICED: HoldingToken[] = ["FXRP", "XRP"];

function usd(amount: string | null, xrpUsd: number | null): string | null {
  if (amount === null || xrpUsd === null) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return (n * xrpUsd).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

/** Palette per asset. FXRP takes the desk's ice because it is the asset being traded; XRP the
 *  neutral steel of the payment leg; C2FLR an amber that reads as "fuel", not "position". */
const TOKEN_COLOR: Record<HoldingToken, string> = {
  FXRP: "var(--color-ice)",
  XRP: "#c9d2dc",
  C2FLR: "#e8b657",
};

// This label was briefly a lie and is now simply true: every seat settles the genuine FAssets asset
// (FTestXRP, 0x0b6A3645…3dc7). The mock is gone — both escrows were redeployed against the real
// token once Flare's faucet turned out to hand it out, which was the only thing the mock ever
// existed to work around.
const TOKEN_SUB: Record<HoldingToken, string> = {
  FXRP: "FAssets · Coston2",
  XRP: "XRPL Testnet",
  C2FLR: "Coston2 · gas",
};

export function TokenMark({ token, className = "" }: { token: HoldingToken; className?: string }) {
  const c = TOKEN_COLOR[token];
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="color-mix(in oklab, currentColor 12%, transparent)"
        stroke={c}
        strokeWidth="1.4"
      />
      {token === "C2FLR" ? (
        /* A diamond for the native unit — it fuels the chain, it is not a position. */
        <path d="M12 6.6 15.6 12 12 17.4 8.4 12Z" fill={c} />
      ) : (
        /* The XRP family shares a crossed mark; FXRP is the same asset, wrapped. */
        <>
          <path d="M8.2 8.4 15.8 15.6M15.8 8.4 8.2 15.6" stroke={c} strokeWidth="1.9" strokeLinecap="round" />
          {token === "FXRP" && (
            /* The wrap: a minted badge, so FXRP is never mistaken for native XRP at a glance. */
            <circle cx="18.4" cy="5.6" r="3.1" fill="var(--color-vault-0)" stroke={c} strokeWidth="1.2" />
          )}
        </>
      )}
    </svg>
  );
}

function Row({
  token,
  value,
  xrpUsd,
}: {
  token: HoldingToken;
  value: string | null;
  xrpUsd: number | null;
}) {
  const worth = PRICED.includes(token) ? usd(value, xrpUsd) : null;
  return (
    <div className="flex items-center gap-3 py-3 border-t border-steel-line first:border-t-0 first:pt-0">
      <TokenMark token={token} className="h-6 w-6 shrink-0 text-ink" />
      <div className="min-w-0 flex-1">
        <p className="mono-label text-[0.66rem] text-ink leading-none">{token}</p>
        <p className="mono-label text-[0.54rem] text-ink-3 mt-1.5 leading-none">{TOKEN_SUB[token]}</p>
      </div>
      <div className="text-right">
        {/* A dash, never a zero, while a balance is still in flight — a stale number reads as fact. */}
        <p className="mono-data text-[0.95rem] text-ink tabular-nums leading-none">{value ?? "—"}</p>
        {worth && (
          <p className="mono-label text-[0.56rem] text-ink-3 mt-1.5 leading-none tabular-nums">{worth}</p>
        )}
      </div>
    </div>
  );
}

export default function Holdings({
  address,
  fxrp,
  c2flr,
  xrp,
  freeBond,
  onFaucet,
  faucetBusy,
  faucetDone,
  faucetError,
  onGas,
  gasBusy,
  gasError,
  needsGas,
}: {
  address: string;
  fxrp: string | null;
  c2flr: string | null;
  xrp?: string | null;
  freeBond?: string | null;
  onFaucet: () => void;
  faucetBusy: boolean;
  faucetDone: boolean;
  faucetError: string | null;
  onGas: () => void;
  gasBusy: boolean;
  gasError: string | null;
  needsGas: boolean;
}) {
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  const showActions = !faucetDone || needsGas;

  // Priced off FTSOv2 — the same feed lock() re-checks the ±1% band against, so the valuation here
  // and the protection on the trade come from one source. Re-read when a balance moves; a failure
  // simply leaves the figures unpriced rather than showing a stale one.
  const [xrpUsd, setXrpUsd] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/price");
        if (!res.ok) return;
        const data: { xrpUsd?: string } = await res.json();
        const n = Number(data.xrpUsd);
        if (!cancelled && Number.isFinite(n) && n > 0) setXrpUsd(n);
      } catch {
        /* unpriced is an honest state; a stale price is not */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fxrp, xrp]);

  const total = usd(
    String((Number(fxrp ?? 0) || 0) + (Number(xrp ?? 0) || 0)),
    xrpUsd,
  );

  return (
    <div className="panel overflow-hidden">
      <div className="px-5 py-3.5 border-b border-steel-line flex items-center justify-between gap-3">
        <div>
          <p className="mono-label text-[0.6rem] text-ice">Holdings</p>
          {total && (
            <p className="mono-data text-[0.8rem] text-ink mt-1.5 tabular-nums leading-none">{total}</p>
          )}
        </div>
        <p className="mono-data text-[0.66rem] text-ink-3" title={address}>
          {short}
        </p>
      </div>

      <div className="px-5 py-3">
        <Row token="FXRP" value={fxrp} xrpUsd={xrpUsd} />
        {xrp !== undefined && <Row token="XRP" value={xrp} xrpUsd={xrpUsd} />}
        <Row token="C2FLR" value={c2flr} xrpUsd={xrpUsd} />
      </div>

      {xrpUsd !== null && (
        <div className="px-5 pb-3 -mt-1">
          <p className="mono-label text-[0.5rem] text-ink-3 leading-relaxed">
            Valued at the live FTSOv2 XRP/USD mid — the same feed the escrow re-checks the ±1% band
            against. C2FLR is testnet gas and carries no price.
          </p>
        </div>
      )}

      {freeBond != null && (
        <div className="px-5 py-3 border-t border-steel-line flex items-center justify-between gap-3">
          <p className="mono-label text-[0.56rem] text-ink-3">Bond posted</p>
          <p className="mono-data text-[0.8rem] text-ink tabular-nums">{freeBond}</p>
        </div>
      )}

      {showActions && (
        <div className="px-5 py-4 border-t border-steel-line bg-vault-2/60 space-y-2.5">
          <p className="mono-label text-[0.54rem] text-ink-3 leading-relaxed">
            The desk funds both of these. Nothing here costs you anything.
          </p>

          {!faucetDone && (
            <>
              {/* No mint button any more, because there is nothing left to mint. The desk settles
                  genuine FAssets FXRP now, and genuine FXRP exists only against XRP locked in the
                  FAssets system — no contract we control can conjure it. Flare's own faucet hands
                  out 10 per address per day, which is what made dropping the mock possible at all. */}
              <a
                href="https://faucet.flare.network/"
                target="_blank"
                rel="noopener noreferrer"
                className="mono-label text-[0.62rem] w-full px-3 py-2 border border-ice/50 text-ice hover:bg-ice/10 transition-colors duration-300 block text-center"
              >
                Get FXRP — faucet.flare.network
              </a>
              <p className="mono-label text-[0.5rem] text-ink-3 leading-relaxed">
                Real FAssets FXRP, 10 per address per day. Nobody can mint it on demand — it exists
                only against XRP locked in FAssets, which is the whole point of the asset.
              </p>
            </>
          )}

          {needsGas && (
            <>
              {/* Flare's own faucet leads now. The desk drip spends the same key that pays for every
                  settlement the desk runs, so each visitor topped up here is reserve it cannot use
                  to finish a trade — and Coston2 gas is free from the source anyway. The drip stays
                  as a second line for the case that genuinely needs it: running dry mid-run, where
                  leaving the page is how a judge abandons the demo. */}
              <a
                href="https://faucet.flare.network/"
                target="_blank"
                rel="noopener noreferrer"
                className="mono-label text-[0.62rem] w-full px-3 py-2 border border-ice/50 text-ice hover:bg-ice/10 transition-colors duration-300 block text-center"
              >
                Get C2FLR — faucet.flare.network
              </a>
              <button
                type="button"
                onClick={onGas}
                disabled={gasBusy}
                className="mono-label text-[0.54rem] text-ink-3 hover:text-ice hover:underline block disabled:opacity-30 disabled:pointer-events-none"
              >
                {/* No amount in the label: the drip size lives in wallet-mode.ts and this is a client
                    component, so a number here would be a copy that silently goes stale. */}
                {gasBusy ? "Sending…" : "or let the desk send you a little"}
              </button>
              {gasError && <p className="mono-label text-[0.58rem] text-iron-red">{gasError}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
