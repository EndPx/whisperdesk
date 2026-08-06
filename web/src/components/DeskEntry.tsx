"use client";

import { useCallback, useState } from "react";
import { connect, ensureCoston2 } from "@/lib/wallet-client";
import { useWalletAccount } from "@/lib/useWalletAccount";

export type DeskRole = "one-click" | "wallet" | "maker";

/**
 * DeskEntry — the desk's front door: pick the seat you want to sit in.
 *
 * The console previously opened straight into one mode with the other two seats reduced to small
 * chips, which left the most interesting one — quoting blind against a sealed RFQ — looking like a
 * secondary option. Each card now states what that seat can SEE, and the maker card shows the
 * blindness rather than describing it: the RFQ's fields are drawn as redacted blocks with the
 * reason underneath.
 *
 * Purely presentational. It picks a mode and hands it back; every existing flow downstream is
 * untouched, and the in-console switcher still works for changing seats afterwards.
 */

type Seat = {
  role: DeskRole;
  tag: string;
  name: string;
  sees: string;
  visibleLabel: string;
  visibleValue: string;
  sealedLabel: string;
  sealedBlocks: number;
  sealedNote: string;
  cta: string;
  accent: "ice" | "amber";
};

const SEATS: Seat[] = [
  {
    role: "one-click",
    tag: "No setup",
    name: "Watch the desk trade",
    sees: "Sees the whole trade, both sides.",
    visibleLabel: "You provide",
    visibleValue: "Nothing — the desk's own testnet keys",
    sealedLabel: "Time to settle",
    sealedBlocks: 0,
    sealedNote: "about 4 minutes, FDC round included",
    cta: "Watch it settle",
    accent: "ice",
  },
  {
    role: "wallet",
    tag: "Your wallet",
    name: "Sit as the taker",
    sees: "Sees its own side, and the XRP arrive.",
    visibleLabel: "You receive",
    visibleValue: "Real XRP, on an address you control",
    sealedLabel: "Who fills you",
    sealedBlocks: 7,
    sealedNote: "matched inside the enclave · never on your feed",
    cta: "Enter as the taker",
    accent: "ice",
  },
  {
    role: "maker",
    tag: "Your wallet",
    name: "Sit as the maker",
    sees: "Sees only the price it names.",
    visibleLabel: "Your quote",
    visibleValue: "The price you set, against the FTSOv2 band",
    sealedLabel: "Side · size · limit",
    sealedBlocks: 9,
    sealedNote: "sealed in the enclave · never disclosed to you",
    cta: "Enter as the maker",
    accent: "amber",
  },
];

function RedactedBlocks({ count }: { count: number }) {
  return (
    <span className="inline-flex gap-[3px] py-1" aria-label="sealed">
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className="block h-[10px] w-[7px] rounded-[1px] bg-ink-3/45 animate-pulse"
          style={{ animationDelay: `${i * 90}ms`, animationDuration: "3.2s" }}
        />
      ))}
    </span>
  );
}

export default function DeskEntry({ onPick }: { onPick: (role: DeskRole) => void }) {
  // The wallet is asked for at the door rather than inside the seat. Entering a wallet seat without
  // one used to drop you on a bare "No wallet detected." panel — no rail, no price, no way forward
  // except back — and that dead end was one click from the front page. Connecting here means a seat
  // is only ever entered in a state it can actually run in.
  const { hasProvider, address, setAddress } = useWalletAccount();
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const addr = await connect();
      // Same order the seats themselves used: authorize, then move the wallet to Coston2, so a
      // judge never signs the first transaction against whatever chain they happened to be on.
      await ensureCoston2();
      setAddress(addr);
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "could not connect");
    } finally {
      setConnecting(false);
    }
  }, [setAddress]);

  return (
    <div className="mt-6">
      {address && (
        <div className="panel px-5 py-2.5 mb-4 flex items-center justify-between gap-3">
          <p className="mono-label text-[0.56rem] text-ink-3">Wallet connected · Coston2</p>
          <p className="mono-data text-[0.7rem] text-ink" title={address}>
            {`${address.slice(0, 6)}…${address.slice(-4)}`}
          </p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        {SEATS.map((s) => {
          const accentText = s.accent === "ice" ? "text-ice" : "text-[#e0a33b]";
          // The one-click seat runs on the desk's own keys and needs nothing from the visitor.
          const needsWallet = s.role !== "one-click";
          const blocked = needsWallet && hasProvider === false;
          const mustConnect = needsWallet && hasProvider !== false && !address;
          return (
            <div key={s.role} className="panel flex flex-col p-5">
              <p className={`mono-label text-[0.56rem] ${accentText}`}>{s.tag}</p>
              <p className="font-display font-semibold text-[1.1rem] tracking-tight text-ink mt-2">
                {s.name}
              </p>
              <p className="text-[0.82rem] leading-[1.5] text-ink-2 mt-1">{s.sees}</p>

              <div className="mt-4 border border-steel-line bg-vault-2/60 px-3.5 py-3">
                <p className="mono-label text-[0.52rem] text-ink-3">{s.visibleLabel}</p>
                <p className="mono-data text-[0.72rem] text-ink mt-1 leading-snug">
                  {s.visibleValue}
                </p>

                <div className="my-2.5 border-t border-steel-line" />

                <p className="mono-label text-[0.52rem] text-ink-3">{s.sealedLabel}</p>
                {s.sealedBlocks > 0 ? (
                  <RedactedBlocks count={s.sealedBlocks} />
                ) : (
                  <p className="mono-data text-[0.72rem] text-ice mt-1">~4 min</p>
                )}
                <p className="mono-label text-[0.5rem] text-ink-3 mt-1 leading-snug">
                  {s.sealedNote}
                </p>
              </div>

              <button
                type="button"
                onClick={blocked ? undefined : mustConnect ? handleConnect : () => onPick(s.role)}
                disabled={blocked || (mustConnect && connecting)}
                className={`mono-label text-[0.62rem] mt-4 w-full px-4 py-2.5 transition-colors duration-300 disabled:opacity-30 disabled:pointer-events-none ${
                  s.role === "one-click"
                    ? "bg-ice text-vault-0 hover:bg-ice-deep hover:text-ink"
                    : "border border-steel-line-2 text-ink-2 hover:text-ink hover:border-ice-deep/60"
                }`}
              >
                {blocked
                  ? "No wallet in this browser"
                  : mustConnect
                    ? connecting
                      ? "Connecting…"
                      : "Connect MetaMask to enter"
                    : s.cta}
              </button>

              {blocked && (
                <p className="mono-label text-[0.52rem] text-ink-3 mt-2.5 leading-relaxed">
                  This seat signs its own transactions. The no-setup seat settles for real without
                  one.
                </p>
              )}
              {mustConnect && connectError && (
                <p className="mono-label text-[0.52rem] text-iron-red mt-2.5">{connectError}</p>
              )}
            </div>
          );
        })}
      </div>

      <p className="mono-label text-[0.54rem] text-ink-3 mt-4 max-w-[80ch] leading-snug">
        All three run a real lock → pay → attest → release on Coston2 + XRPL testnet. Open the maker
        seat in a second window to watch two independent parties get matched without either seeing
        the other&apos;s order.
      </p>
    </div>
  );
}
