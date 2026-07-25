"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PartyCard, BalanceRow, Rail, type PillSpec, type Ring } from "@/components/flow/parts";
import WalletMode from "@/components/WalletMode";
import { detectProvider } from "@/lib/wallet-client";

/* ---------------------------------------------------------------------------
   DemoConsole — the live judge-facing console at /demo.

   Drives the fixed API contract (web/src/app/api/demo/*) through a real
   happy-path settlement or the default-path (refund + bond slash) safety
   net, narrating every stage into a mono console log with real tx links,
   and animating the same party-card / rail vocabulary as the landing
   page's DvpFlow (see ./flow/parts.tsx).
--------------------------------------------------------------------------- */

const COSTON2_TX = (hash: string) => `https://coston2-explorer.flare.network/tx/${hash}`;
const XRPL_TX = (hash: string) => `https://testnet.xrpl.org/transactions/${hash}`;

const FALLBACK_RECEIPTS = [
  {
    label: "release() → maker received FXRP",
    href: "https://coston2-explorer.flare.network/tx/0x2c162613abea611d7b09c50251b35936b6d7c8599daea17016d952591a17202f",
  },
  {
    label: "default path · refund() → taker",
    href: "https://coston2-explorer.flare.network/tx/0x1605a2ced9852f9caefebf6339cac3d294758f9d5e30c968208d2a4c0cc1feed",
  },
];

const PILL_MS = 1300; // mirrors --pill-ms in globals.css
const PROOF_POLL_MS = 10_000;
const PROOF_CAP_MS = 10 * 60 * 1000;
const REFUND_POLL_MS = 15_000;
const REFUND_CAP_MS = 10 * 60 * 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortHash(hash: string) {
  if (!hash) return hash;
  if (hash.length <= 16) return hash;
  const head = hash.startsWith("0x") ? 10 : 8;
  return `${hash.slice(0, head)}…${hash.slice(-6)}`;
}

function formatXrp(dropsStr: string | undefined) {
  const n = Number(dropsStr);
  if (!Number.isFinite(n)) return dropsStr ?? "—";
  return `${(n / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })} XRP`;
}

function toNum(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function nowTs() {
  return new Date().toTimeString().slice(0, 8);
}

/* ---------------------------------------------------------------------------
   Tiny fetch wrapper — never throws, always resolves to {ok, status, data}.
--------------------------------------------------------------------------- */

type ApiResult<T> = { ok: boolean; status: number; data: T | null };

async function callApi<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    let data: T | null = null;
    try {
      data = (await res.json()) as T;
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: { error: err instanceof Error ? err.message : "network error" } as T,
    };
  }
}

const getJSON = <T,>(path: string) => callApi<T>(path, { method: "GET" });
const postJSON = <T,>(path: string, body: unknown) =>
  callApi<T>(path, { method: "POST", body: JSON.stringify(body) });

/* ---------------------------------------------------------------------------
   Console log
--------------------------------------------------------------------------- */

type LogTone = "normal" | "muted" | "success" | "error";
type LogLine = { id: string; ts: string; text: string; href?: string; linkText?: string; tone: LogTone };

function toneClass(tone: LogTone) {
  switch (tone) {
    case "error":
      return "text-iron-red";
    case "success":
      return "text-ice";
    case "muted":
      return "text-ink-3";
    default:
      return "text-ink-2";
  }
}

/* ---------------------------------------------------------------------------
   Demo state
--------------------------------------------------------------------------- */

type DemoState = {
  enabled: boolean;
  escrow?: string;
  taker?: { fxrp: string };
  maker?: { fxrp: string };
  vault?: { fxrp: string };
};

type Countdown = { nowChain: number; refundAfter: number; graceSeconds: number; fetchedAt: number };

export default function DemoConsole() {
  const [enabled, setEnabled] = useState<boolean | null>(null); // null = still checking
  const [escrow, setEscrow] = useState<string | null>(null);
  const [takerFxrp, setTakerFxrp] = useState(0);
  const [makerFxrp, setMakerFxrp] = useState(0);
  const [vaultFxrp, setVaultFxrp] = useState(0);

  const [mode, setMode] = useState<"one-click" | "wallet">("wallet");
  const [walletBusy, setWalletBusy] = useState(false);

  const [runPath, setRunPath] = useState<"happy" | "default" | null>(null);
  const [busy, setBusy] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [countdown, setCountdown] = useState<Countdown | null>(null);

  const [railAPill, setRailAPill] = useState<PillSpec>(null);
  const [railBPill, setRailBPill] = useState<PillSpec>(null);
  const [paymentPill, setPaymentPill] = useState<PillSpec>(null);
  const [vaultRing, setVaultRing] = useState<Ring>("none");
  const [pillTick, setPillTick] = useState(0);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  const mountedRef = useRef(true);
  const logIdRef = useRef(0);
  const userPickedModeRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Wallet-aware default: the server can't know whether a browser wallet is present, so we render
  // the stable "wallet" tab first (matches server + first client paint — no hydration mismatch),
  // then flip to the one-click tab post-mount if detection comes back empty. Reuses the same
  // detectProvider() signal WalletMode.tsx uses for its own no-wallet fallback. If the judge has
  // already clicked a tab by the time detection resolves, their choice wins.
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled || userPickedModeRef.current) return;
      if (!detectProvider()) setMode("one-click");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the in-flight pill glide replaying while a stage is still pending —
  // otherwise a single 1300ms glide would finish long before a real tx does.
  useEffect(() => {
    if (!railAPill && !railBPill && !paymentPill) return;
    const id = setInterval(() => setPillTick((t) => t + 1), PILL_MS);
    return () => clearInterval(id);
  }, [railAPill, railBPill, paymentPill]);

  // Tick the refund countdown once a second — Date.now() stays inside the
  // deferred interval callback (never called synchronously in the effect
  // body) so the component body remains pure.
  useEffect(() => {
    if (!countdown) return;
    const compute = () => {
      const elapsed = (Date.now() - countdown.fetchedAt) / 1000;
      const remaining = Math.max(
        0,
        countdown.refundAfter + countdown.graceSeconds - (countdown.nowChain + elapsed),
      );
      setRemainingSeconds(remaining);
    };
    const id = setInterval(compute, 1000);
    return () => clearInterval(id);
  }, [countdown]);

  const addLog = useCallback((text: string, opts?: { href?: string; linkText?: string; tone?: LogTone }) => {
    if (!mountedRef.current) return;
    logIdRef.current += 1;
    setLog((prev) => [
      ...prev,
      {
        id: `l${logIdRef.current}`,
        ts: nowTs(),
        text,
        href: opts?.href,
        linkText: opts?.linkText,
        tone: opts?.tone ?? "normal",
      },
    ]);
  }, []);

  const applyState = useCallback((data: DemoState) => {
    if (!mountedRef.current) return;
    setEscrow(data.escrow ?? null);
    setTakerFxrp(toNum(data.taker?.fxrp));
    setMakerFxrp(toNum(data.maker?.fxrp));
    setVaultFxrp(toNum(data.vault?.fxrp));
  }, []);

  const refreshState = useCallback(async () => {
    const res = await getJSON<DemoState>("/api/demo/state");
    if (res.ok && res.data) {
      if (res.data.enabled === false) {
        if (mountedRef.current) setEnabled(false);
        return;
      }
      applyState(res.data);
    }
  }, [applyState]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await getJSON<DemoState>("/api/demo/state");
      if (cancelled) return;
      if (!res.ok || !res.data || res.data.enabled !== true) {
        setEnabled(false);
        return;
      }
      setEnabled(true);
      applyState(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyState]);

  const clearPills = useCallback(() => {
    setRailAPill(null);
    setRailBPill(null);
    setPaymentPill(null);
    setVaultRing("none");
  }, []);

  const pollProof = useCallback(async (roundId: string, requestHex: string) => {
    const start = Date.now();
    while (Date.now() - start < PROOF_CAP_MS) {
      if (!mountedRef.current) return null;
      const res = await getJSON<{ ready: boolean; proof?: unknown; error?: string }>(
        `/api/demo/proof?roundId=${encodeURIComponent(roundId)}&requestHex=${encodeURIComponent(requestHex)}`,
      );
      if (!res.ok || !res.data) {
        throw new Error(res.data?.error ?? "proof check failed");
      }
      if (res.data.ready) return res.data.proof;
      await sleep(PROOF_POLL_MS);
    }
    return null;
  }, []);

  const pollRefund = useCallback(async (matchId: string) => {
    const start = Date.now();
    let loggedWaiting = false;
    while (Date.now() - start < REFUND_CAP_MS) {
      if (!mountedRef.current) return null;
      const res = await postJSON<{
        refundTx?: string;
        notYet?: boolean;
        nowChain?: number;
        refundAfter?: number;
        graceSeconds?: number;
        error?: string;
      }>("/api/demo/refund", { matchId });
      if (!res.ok || !res.data) {
        throw new Error(res.data?.error ?? "refund check failed");
      }
      if (res.data.notYet) {
        if (!loggedWaiting) {
          addLog("refund() not yet — waiting for the payment deadline + grace period to pass", {
            tone: "muted",
          });
          loggedWaiting = true;
        }
        setCountdown({
          nowChain: toNum(res.data.nowChain),
          refundAfter: toNum(res.data.refundAfter),
          graceSeconds: toNum(res.data.graceSeconds),
          fetchedAt: Date.now(),
        });
        await sleep(REFUND_POLL_MS);
        continue;
      }
      setCountdown(null);
      return res.data.refundTx ?? null;
    }
    return null;
  }, [addLog]);

  const runHappy = useCallback(async () => {
    if (runPath) return;
    setRunPath("happy");
    setError(null);
    setBusy(false);
    setRateLimited(false);
    addLog("Starting live settlement — happy path", { tone: "muted" });
    try {
      setRailAPill({ token: "lock" });
      const lockRes = await postJSON<{
        matchId: string;
        lockTx: string;
        destinationTag: string;
        xrpDrops: string;
        paymentDeadline: string;
        refundAfter: string;
        error?: string;
        busy?: boolean;
        enabled?: boolean;
        retryAfterSeconds?: number;
      }>("/api/demo/lock", { path: "happy" });

      if (lockRes.status === 409) {
        setBusy(true);
        clearPills();
        return;
      }
      if (lockRes.status === 429) {
        setRateLimited(true);
        clearPills();
        return;
      }
      if (lockRes.status === 503) {
        setEnabled(false);
        clearPills();
        return;
      }
      if (!lockRes.ok || !lockRes.data) {
        throw new Error(lockRes.data?.error ?? "lock() failed");
      }
      const { matchId, lockTx, destinationTag, xrpDrops } = lockRes.data;
      addLog("lock() confirmed", { href: COSTON2_TX(lockTx), linkText: shortHash(lockTx) });
      await refreshState();
      setRailAPill(null);

      setPaymentPill({ token: "XRP", reverse: true });
      const payRes = await postJSON<{ xrplTx: string; error?: string }>("/api/demo/pay", {
        destinationTag,
        xrpDrops,
      });
      if (!payRes.ok || !payRes.data) {
        throw new Error(payRes.data?.error ?? "XRPL payment failed");
      }
      addLog(`XRPL payment sent — ${formatXrp(xrpDrops)}`, {
        href: XRPL_TX(payRes.data.xrplTx),
        linkText: shortHash(payRes.data.xrplTx),
      });
      setPaymentPill(null);

      const attestRes = await postJSON<{ roundId: string; requestHex: string; error?: string }>(
        "/api/demo/attest",
        { xrplTx: payRes.data.xrplTx },
      );
      if (!attestRes.ok || !attestRes.data) {
        throw new Error(attestRes.data?.error ?? "attest() failed");
      }
      addLog(`FDC round ${attestRes.data.roundId} — waiting for finality`, { tone: "muted" });
      setVaultRing("ice");

      const proof = await pollProof(attestRes.data.roundId, attestRes.data.requestHex);
      if (proof === null) {
        throw new Error("proof did not become ready within 10 minutes");
      }
      addLog("proof ready");
      setVaultRing("none");

      setRailBPill({ token: "FXRP" });
      const releaseRes = await postJSON<{ releaseTx: string; error?: string }>("/api/demo/release", {
        matchId,
        proof,
      });
      if (!releaseRes.ok || !releaseRes.data) {
        throw new Error(releaseRes.data?.error ?? "release() failed");
      }
      addLog("release() confirmed — maker received FXRP", {
        href: COSTON2_TX(releaseRes.data.releaseTx),
        linkText: shortHash(releaseRes.data.releaseTx),
        tone: "success",
      });
      await refreshState();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "settlement failed";
      setError(msg);
      addLog(msg, { tone: "error" });
    } finally {
      clearPills();
      if (mountedRef.current) setRunPath(null);
    }
  }, [runPath, addLog, clearPills, pollProof, refreshState]);

  const runDefault = useCallback(async () => {
    if (runPath) return;
    setRunPath("default");
    setError(null);
    setBusy(false);
    setRateLimited(false);
    addLog("Starting live settlement — default path (no payment)", { tone: "muted" });
    try {
      setRailAPill({ token: "lock" });
      const lockRes = await postJSON<{
        matchId: string;
        lockTx: string;
        destinationTag: string;
        xrpDrops: string;
        paymentDeadline: string;
        refundAfter: string;
        error?: string;
        busy?: boolean;
        enabled?: boolean;
        retryAfterSeconds?: number;
      }>("/api/demo/lock", { path: "default" });

      if (lockRes.status === 409) {
        setBusy(true);
        clearPills();
        return;
      }
      if (lockRes.status === 429) {
        setRateLimited(true);
        clearPills();
        return;
      }
      if (lockRes.status === 503) {
        setEnabled(false);
        clearPills();
        return;
      }
      if (!lockRes.ok || !lockRes.data) {
        throw new Error(lockRes.data?.error ?? "lock() failed");
      }
      const { matchId, lockTx } = lockRes.data;
      addLog("lock() confirmed", { href: COSTON2_TX(lockTx), linkText: shortHash(lockTx) });
      await refreshState();
      setRailAPill(null);
      setVaultRing("iron");

      const refundTx = await pollRefund(matchId);
      if (!refundTx) {
        throw new Error("refund() did not become available within 10 minutes");
      }
      setRailAPill({ token: "FXRP", reverse: true });
      setPaymentPill({ token: "bond", reverse: true });
      addLog("refund() confirmed — principal + slashed bond returned to you", {
        href: COSTON2_TX(refundTx),
        linkText: shortHash(refundTx),
        tone: "success",
      });
      await refreshState();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "default path failed";
      setError(msg);
      addLog(msg, { tone: "error" });
    } finally {
      clearPills();
      if (mountedRef.current) setRunPath(null);
    }
  }, [runPath, addLog, clearPills, pollRefund, refreshState]);

  /* ------------------------------------------------------------------------
     Render
  ------------------------------------------------------------------------ */

  const switcherDisabled = !!runPath || walletBusy;

  const oneClickBody = enabled === null ? (
    <div className="panel mt-6 px-6 py-8 sm:px-8 sm:py-10">
      <p className="mono-label text-[0.68rem] text-ink-3 flex items-center gap-2">
        <span className="ice-dot" />
        Connecting to the live console…
      </p>
    </div>
  ) : enabled === false ? (
    <div className="panel mt-6 px-6 py-8 sm:px-8 sm:py-10">
      <p className="mono-label text-[0.68rem] text-ink-3 mb-3">Live console</p>
      <h3 className="font-display font-semibold text-[1.3rem] text-ink mb-3">
        The live console is sleeping.
      </h3>
      <p className="max-w-[54ch] text-[0.95rem] leading-[1.65] text-ink-2 mb-6">
        The demo backend isn&apos;t running right now. You can run the identical settlement yourself from
        the command line — it drives the same lock → pay → attest → release flow this console would.
      </p>
      <pre className="mono-data text-[0.82rem] text-ink-2 bg-vault-2 border border-steel-line px-4 py-3 overflow-x-auto mb-6 whitespace-pre">
{`cd scripts/e2e && npm install
npm run happy-path`}
      </pre>
      <p className="mono-label text-[0.6rem] text-ink-3 mb-3">Proven receipts from a real run</p>
      <div className="flex flex-col gap-2">
        {FALLBACK_RECEIPTS.map((r) => (
          <a
            key={r.href}
            href={r.href}
            target="_blank"
            rel="noopener noreferrer"
            className="mono-data text-[0.82rem] text-ice hover:underline break-all"
          >
            {r.label} → {shortHash(r.href.split("/").pop() ?? "")}
          </a>
        ))}
      </div>
    </div>
  ) : (
    <div className="mt-6 space-y-8">
      {escrow && (
        <p className="mono-label text-[0.56rem] text-ink-3">
          Escrow <span className="text-ink-2">{shortHash(escrow)}</span>
        </p>
      )}

      {/* diagram */}
      <div className="overflow-x-auto">
        <div className="min-w-[560px] sm:min-w-0 px-2 pt-4 pb-2">
          <div className="flex items-center gap-2 sm:gap-5">
            <PartyCard sub="Taker" label="You">
              <BalanceRow token="FXRP" value={takerFxrp} />
            </PartyCard>

            <Rail key={`ra-${pillTick}`} pill={railAPill} />

            <PartyCard sub="Escrow" label="WhisperDesk Vault" ring={vaultRing}>
              <BalanceRow token="FXRP" value={vaultFxrp} />
            </PartyCard>

            <Rail key={`rb-${pillTick}`} pill={railBPill} />

            <PartyCard sub="Maker" label="Counterparty">
              <BalanceRow token="FXRP" value={makerFxrp} />
            </PartyCard>
          </div>

          <div className="mt-8 sm:mt-10 flex items-center gap-3 px-1">
            <span className="mono-label text-[0.56rem] text-ink-3 shrink-0">You</span>
            <Rail key={`pay-${pillTick}`} pill={paymentPill} dashed />
            <span className="mono-label text-[0.56rem] text-ink-3 shrink-0">XRP Ledger — direct payment</span>
            <Rail pill={null} dashed />
            <span className="mono-label text-[0.56rem] text-ink-3 shrink-0">Maker</span>
          </div>
        </div>
      </div>

      {/* CTAs */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={runHappy}
          disabled={!!runPath}
          className="mono-label text-[0.68rem] px-5 py-2.5 border border-ice/50 text-ice hover:bg-ice/10 transition-colors duration-300 disabled:opacity-30 disabled:pointer-events-none"
        >
          {runPath === "happy" ? "Running…" : "Run live settlement"}
        </button>
        <button
          type="button"
          onClick={runDefault}
          disabled={!!runPath}
          className="mono-label text-[0.68rem] px-5 py-2.5 border border-steel-line-2 text-ink-2 hover:text-ink hover:border-ice-deep/60 transition-colors duration-300 disabled:opacity-30 disabled:pointer-events-none"
        >
          {runPath === "default" ? "Running…" : "Run the default path"}
        </button>
      </div>

      <p className="mono-label text-[0.56rem] text-ink-3">
        Runs on the desk&apos;s testnet keys — limited to a few runs a day.
      </p>

      {busy && (
        <p className="mono-label text-[0.66rem] text-iron-red">
          Another run is in progress — try again in a few minutes.
        </p>
      )}
      {rateLimited && (
        <p className="mono-label text-[0.66rem] text-iron-red">
          The shared one-click demo has hit its daily limit. Use &quot;Be the taker&quot; to run it with
          your own wallet, or check the receipts below.
        </p>
      )}
      {error && <p className="mono-label text-[0.66rem] text-iron-red">{error}</p>}

      {countdown && remainingSeconds !== null && (
        <div className="panel px-5 py-4 inline-block">
          <p className="mono-label text-[0.6rem] text-ink-3 mb-1">Refund unlocks in</p>
          <p className="mono-data text-[1.1rem] text-ice tabular-nums">
            {Math.floor(remainingSeconds / 60)}:{String(Math.floor(remainingSeconds % 60)).padStart(2, "0")}
          </p>
        </div>
      )}

      {/* console log — centerpiece */}
      <div className="panel px-6 py-6 sm:px-8 sm:py-7">
        <p className="mono-label text-[0.6rem] text-ink-3 mb-3">Console</p>
        <p className="mono-label text-[0.56rem] text-ink-3 mb-4 leading-relaxed">
          Real transactions · desk demo keys · simulated-TEE signer · a full run takes roughly 3–6 minutes
          (FDC round finality).
        </p>
        <div
          aria-live="polite"
          className="max-h-[360px] overflow-y-auto space-y-2 border-t border-steel-line pt-4"
        >
          {log.length === 0 ? (
            <p className="mono-data text-[0.8rem] text-ink-3">Waiting for a run to start…</p>
          ) : (
            log.map((line) => (
              <div key={line.id} className="mono-data text-[0.8rem] flex flex-wrap items-baseline gap-x-2">
                <span className="text-ink-3">{line.ts}</span>
                <span className={toneClass(line.tone)}>{line.text}</span>
                {line.href && (
                  <a
                    href={line.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ice hover:underline"
                  >
                    {line.linkText}
                  </a>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="mt-10">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            userPickedModeRef.current = true;
            setMode("one-click");
          }}
          disabled={switcherDisabled}
          aria-pressed={mode === "one-click"}
          className={`mono-label text-[0.62rem] px-4 py-2 border transition-colors duration-300 disabled:opacity-30 disabled:pointer-events-none ${
            mode === "one-click"
              ? "border-ice/50 text-ice bg-ice/10"
              : "border-steel-line-2 text-ink-2 hover:text-ink hover:border-ice-deep/60"
          }`}
        >
          One-click (desk wallet) — settles now
        </button>
        <button
          type="button"
          onClick={() => {
            userPickedModeRef.current = true;
            setMode("wallet");
          }}
          disabled={switcherDisabled}
          aria-pressed={mode === "wallet"}
          className={`mono-label text-[0.62rem] px-4 py-2 border transition-colors duration-300 disabled:opacity-30 disabled:pointer-events-none ${
            mode === "wallet"
              ? "border-ice/50 text-ice bg-ice/10"
              : "border-steel-line-2 text-ink-2 hover:text-ink hover:border-ice-deep/60"
          }`}
        >
          Be the taker (your wallet)
        </button>
      </div>
      <p className="mono-label text-[0.56rem] text-ink-3 mt-3 max-w-[62ch]">
        Either tab runs a real lock → pay → attest → release settlement on Coston2 + XRPL — one-click
        spends the desk&apos;s testnet keys, taker mode spends your own.
      </p>

      {mode === "one-click" ? (
        oneClickBody
      ) : (
        <WalletMode onSwitchToOneClick={() => setMode("one-click")} onBusyChange={setWalletBusy} />
      )}
    </div>
  );
}
