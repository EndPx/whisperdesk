"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BalanceRow, IconCheck, PartyCard, Rail, type PillSpec } from "@/components/flow/parts";
import WithheldPanel, { TAKER_WITHHELD } from "@/components/WithheldPanel";
import { useWalletAccount } from "@/lib/useWalletAccount";
import {
  connect,
  ensureCoston2,
  sendApprove,
  sendDeposit,
  sendLock,
  WalletRejectionError,
} from "@/lib/wallet-client";

/* ---------------------------------------------------------------------------
   WalletMode — "Be the taker". A judge connects their own MetaMask and walks a
   five-step stepper that ends with real XRP landing on their own XRPL testnet
   address. Drives the fixed wallet-mode API contract (web/src/app/api/wallet/*)
   for steps 1-4, then reuses the SAME /api/demo/attest -> proof -> release
   orchestration DemoConsole.tsx uses for step 5, so both modes settle through
   the identical FDC-proven path.

   Mirrors DemoConsole.tsx's console-log style, stage handling, and error
   surfacing exactly. Small helpers below (shortHash, formatXrp, toneClass,
   callApi, ...) are intentionally duplicated from DemoConsole.tsx — that
   file doesn't export them, and this component must reproduce their
   behavior byte-for-byte rather than approximate it.
--------------------------------------------------------------------------- */

const COSTON2_TX = (hash: string) => `https://coston2-explorer.flare.network/tx/${hash}`;
const XRPL_TX = (hash: string) => `https://testnet.xrpl.org/transactions/${hash}`;
const XRPL_ACCOUNT = (address: string) => `https://testnet.xrpl.org/accounts/${address}`;

const PILL_MS = 1300; // mirrors --pill-ms in globals.css / DemoConsole.tsx
const PROOF_POLL_MS = 10_000;
const PROOF_CAP_MS = 10 * 60 * 1000;
const XRPL_BALANCE_POLL_MS = 4_000;
const XRPL_BALANCE_CAP_MS = 60 * 1000;

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
   API response shapes — WALLET-MODE API CONTRACT (fixed)
--------------------------------------------------------------------------- */

type StatusResponse = { enabled: boolean; fxrp: string; c2flr: string };
type FaucetResponse = { txHash: string; minted: string; balance: string; error?: string; enabled?: boolean };
type XrplAccountResponse = { address: string; seed: string; funded: boolean; error?: string; enabled?: boolean };
type XrplBalanceResponse = { exists: boolean; balanceXrp: string; error?: string; enabled?: boolean };
type PrepareResponse = {
  matchId: string;
  approve: { token: string; spender: string; amount: string };
  deposit: { amount: string; armedUntil: string };
  lock: { to: string; instructionData: string; teeSignature: string; valueWei: string };
  xrpDrops: string;
  destinationTag: string;
  paymentDeadline: string;
  refundAfter: string;
  error?: string;
  busy?: boolean;
  enabled?: boolean;
};
type PayResponse = { xrplTx: string; error?: string; enabled?: boolean };
type AttestResponse = { roundId: string; requestHex: string; error?: string; enabled?: boolean };
type ProofResponse = { ready: boolean; proof?: unknown; error?: string };
type ReleaseResponse = { releaseTx: string; error?: string };

type S4Stage = "idle" | "preparing" | "approve" | "deposit" | "lock" | "done";
type S5Stage = "idle" | "paying" | "attesting" | "proving" | "releasing" | "balance" | "done";

export default function WalletMode({
  onSwitchToOneClick,
  onBusyChange,
}: {
  onSwitchToOneClick?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const mountedRef = useRef(true);
  const logIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // S1 — connect
  // Provider detection + the connected account both live in useWalletAccount, so the connection
  // survives a switch to maker mode instead of being thrown away with this component's state.
  const { hasProvider, address, setAddress } = useWalletAccount();
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null); // null until first /api/wallet/status call
  const [c2flr, setC2flr] = useState("0");
  const [fxrp, setFxrp] = useState("0");

  // S2 — faucet
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const [faucetDone, setFaucetDone] = useState(false);

  // S3 — XRPL receive address
  const [xrplAddressInput, setXrplAddressInput] = useState("");
  const [xrplAddress, setXrplAddress] = useState<string | null>(null);
  const [xrplSeed, setXrplSeed] = useState<string | null>(null); // only set when generated for the judge
  const [xrplGenBusy, setXrplGenBusy] = useState(false);
  const [xrplError, setXrplError] = useState<string | null>(null);
  const [xrplBalance, setXrplBalance] = useState<string | null>(null);

  // S4 — prepare + three wallet confirmations
  const [s4Stage, setS4Stage] = useState<S4Stage>("idle");
  const [s4Error, setS4Error] = useState<string | null>(null);
  const [prepareData, setPrepareData] = useState<PrepareResponse | null>(null);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [lockTx, setLockTx] = useState<string | null>(null);
  const [prepareBusy, setPrepareBusy] = useState(false);

  // S5 — settle. Each stage is resumable independently (retrying never re-sends a step that
  // already succeeded — mirrors S4's approve/deposit/lock granularity) via the intermediate
  // results captured here.
  const [s5Stage, setS5Stage] = useState<S5Stage>("idle");
  const [s5Error, setS5Error] = useState<string | null>(null);
  const [xrplPayTx, setXrplPayTx] = useState<string | null>(null);
  const [attestRound, setAttestRound] = useState<{ roundId: string; requestHex: string } | null>(null);
  const [proofData, setProofData] = useState<unknown | null>(null);
  const [finalXrplBalance, setFinalXrplBalance] = useState<string | null>(null);

  const [log, setLog] = useState<LogLine[]>([]);
  const [lockPill, setLockPill] = useState<PillSpec>(null);
  const [payPill, setPayPill] = useState<PillSpec>(null);
  const [pillTick, setPillTick] = useState(0);

  // Keep the in-flight pill glide replaying while a stage is still pending — a real wallet
  // confirmation or XRPL send can take far longer than one 1300ms glide. Same mechanism as
  // DemoConsole.tsx.
  useEffect(() => {
    if (!lockPill && !payPill) return;
    const id = setInterval(() => setPillTick((t) => t + 1), PILL_MS);
    return () => clearInterval(id);
  }, [lockPill, payPill]);

  const addLog = useCallback((text: string, opts?: { href?: string; linkText?: string; tone?: LogTone }) => {
    if (!mountedRef.current) return;
    logIdRef.current += 1;
    setLog((prev) => [
      ...prev,
      {
        id: `w${logIdRef.current}`,
        ts: nowTs(),
        text,
        href: opts?.href,
        linkText: opts?.linkText,
        tone: opts?.tone ?? "normal",
      },
    ]);
  }, []);

  const currentStep = !address ? 1 : !faucetDone ? 2 : !xrplAddress ? 3 : s4Stage !== "done" ? 4 : 5;

  const walletBusy =
    connecting ||
    faucetBusy ||
    xrplGenBusy ||
    (s4Stage !== "idle" && s4Stage !== "done") ||
    (s5Stage !== "idle" && s5Stage !== "done");

  useEffect(() => {
    onBusyChange?.(walletBusy);
  }, [walletBusy, onBusyChange]);

  /* ------------------------------------------------------------------------
     S1 — connect wallet
  ------------------------------------------------------------------------ */

  const refreshStatus = useCallback(async (addr: string) => {
    const res = await getJSON<StatusResponse>(`/api/wallet/status?taker=${encodeURIComponent(addr)}`);
    if (res.status === 503 || res.data?.enabled === false) {
      if (mountedRef.current) setEnabled(false);
      return;
    }
    if (!res.ok || !res.data) {
      addLog("could not load wallet status", { tone: "error" });
      return;
    }
    if (!mountedRef.current) return;
    setEnabled(true);
    setC2flr(res.data.c2flr);
    setFxrp(res.data.fxrp);
  }, [addLog]);

  // Load balances whenever an account appears — whether from an explicit connect or from
  // useWalletAccount restoring one silently. Owning the refresh here rather than inside
  // handleConnect is what gives the restored path the same status the clicked path always had.
  useEffect(() => {
    if (!address) return;
    void refreshStatus(address);
  }, [address, refreshStatus]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const addr = await connect();
      setAddress(addr);
      addLog(`Wallet connected — ${shortHash(addr)}`, { tone: "success" });
      try {
        await ensureCoston2();
      } catch (netErr) {
        const msg = netErr instanceof Error ? netErr.message : "could not switch to Coston2";
        addLog(`Network switch: ${msg}`, { tone: "error" });
      }
      // No refreshStatus() call here — the effect above owns it, for both connect and restore.
    } catch (err) {
      const msg = err instanceof WalletRejectionError ? err.message : err instanceof Error ? err.message : "wallet connection failed";
      setConnectError(msg);
      addLog(msg, { tone: "error" });
    } finally {
      if (mountedRef.current) setConnecting(false);
    }
  }, [addLog, refreshStatus]);

  /* ------------------------------------------------------------------------
     S2 — demo FXRP faucet
  ------------------------------------------------------------------------ */

  const handleFaucet = useCallback(async () => {
    if (!address) return;
    setFaucetBusy(true);
    setFaucetError(null);
    try {
      const res = await postJSON<FaucetResponse>("/api/wallet/faucet", { address });
      if (res.status === 429) {
        setFaucetError(res.data?.error ?? "rate limited — 1 mint per address per 10 minutes");
        addLog(res.data?.error ?? "faucet rate limited — try again in a few minutes", { tone: "error" });
        return;
      }
      if (res.status === 503 || res.data?.enabled === false) {
        setEnabled(false);
        return;
      }
      if (!res.ok || !res.data) {
        throw new Error(res.data?.error ?? "faucet mint failed");
      }
      setFxrp(res.data.balance);
      setFaucetDone(true);
      addLog(`Faucet minted ${res.data.minted} FXRP`, {
        href: COSTON2_TX(res.data.txHash),
        linkText: shortHash(res.data.txHash),
        tone: "success",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "faucet mint failed";
      setFaucetError(msg);
      addLog(msg, { tone: "error" });
    } finally {
      if (mountedRef.current) setFaucetBusy(false);
    }
  }, [address, addLog]);

  /* ------------------------------------------------------------------------
     S3 — XRPL receive address
  ------------------------------------------------------------------------ */

  const fetchXrplBalance = useCallback(async (addr: string) => {
    const res = await getJSON<XrplBalanceResponse>(`/api/wallet/xrpl-balance?address=${encodeURIComponent(addr)}`);
    if (res.ok && res.data) {
      if (mountedRef.current) setXrplBalance(res.data.balanceXrp);
      return res.data.balanceXrp;
    }
    return null;
  }, []);

  const usePastedAddress = useCallback(async () => {
    const addr = xrplAddressInput.trim();
    if (!addr.startsWith("r") || addr.length < 20) {
      setXrplError("that doesn't look like an XRPL testnet address (should start with r…)");
      return;
    }
    setXrplError(null);
    setXrplAddress(addr);
    addLog(`XRPL receive address set — ${shortHash(addr)}`, { tone: "success" });
    await fetchXrplBalance(addr);
  }, [xrplAddressInput, addLog, fetchXrplBalance]);

  const generateXrplAccount = useCallback(async () => {
    setXrplGenBusy(true);
    setXrplError(null);
    try {
      const res = await postJSON<XrplAccountResponse>("/api/wallet/xrpl-account", {});
      if (res.status === 503 || res.data?.enabled === false) {
        setEnabled(false);
        return;
      }
      if (!res.ok || !res.data) {
        throw new Error(res.data?.error ?? "could not generate an XRPL account");
      }
      setXrplAddress(res.data.address);
      setXrplSeed(res.data.seed);
      addLog(`Generated + funded a throwaway XRPL account — ${shortHash(res.data.address)}`, {
        href: XRPL_ACCOUNT(res.data.address),
        linkText: "view on testnet.xrpl.org",
        tone: "success",
      });
      await fetchXrplBalance(res.data.address);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "could not generate an XRPL account";
      setXrplError(msg);
      addLog(msg, { tone: "error" });
    } finally {
      if (mountedRef.current) setXrplGenBusy(false);
    }
  }, [addLog, fetchXrplBalance]);

  /* ------------------------------------------------------------------------
     S4 — prepare, then approve -> deposit -> lock via the judge's own wallet
  ------------------------------------------------------------------------ */

  const runLock = useCallback(async (data: PrepareResponse) => {
    setS4Stage("lock");
    setS4Error(null);
    try {
      setLockPill({ token: "lock" });
      const hash = await sendLock(data.lock);
      setLockTx(hash);
      addLog("lock() confirmed — funds sealed in escrow", {
        href: COSTON2_TX(hash),
        linkText: shortHash(hash),
        tone: "success",
      });
      setLockPill(null);
      if (mountedRef.current) setS4Stage("done");
    } catch (err) {
      setLockPill(null);
      const msg = err instanceof WalletRejectionError ? err.message : err instanceof Error ? err.message : "lock() failed";
      setS4Error(msg);
      addLog(msg, { tone: "error" });
    }
  }, [addLog]);

  const runDeposit = useCallback(async (data: PrepareResponse) => {
    setS4Stage("deposit");
    setS4Error(null);
    try {
      const hash = await sendDeposit(data.lock.to, data.deposit);
      addLog("deposit() confirmed", { href: COSTON2_TX(hash), linkText: shortHash(hash) });
      await runLock(data);
    } catch (err) {
      const msg = err instanceof WalletRejectionError ? err.message : err instanceof Error ? err.message : "deposit() failed";
      setS4Error(msg);
      addLog(msg, { tone: "error" });
    }
  }, [addLog, runLock]);

  const runApprove = useCallback(async (data: PrepareResponse) => {
    setS4Stage("approve");
    setS4Error(null);
    try {
      const hash = await sendApprove(data.approve);
      addLog("approve() confirmed", { href: COSTON2_TX(hash), linkText: shortHash(hash) });
      await runDeposit(data);
    } catch (err) {
      const msg = err instanceof WalletRejectionError ? err.message : err instanceof Error ? err.message : "approve() failed";
      setS4Error(msg);
      addLog(msg, { tone: "error" });
    }
  }, [addLog, runDeposit]);

  const runPrepare = useCallback(async () => {
    if (!address || !xrplAddress) return;
    setS4Stage("preparing");
    setS4Error(null);
    setPrepareBusy(false);
    try {
      const res = await postJSON<PrepareResponse>("/api/wallet/prepare", { taker: address, xrplAddress });
      if (res.status === 409) {
        setPrepareBusy(true);
        setS4Stage("idle");
        return;
      }
      if (res.status === 503 || res.data?.enabled === false) {
        setEnabled(false);
        setS4Stage("idle");
        return;
      }
      if (!res.ok || !res.data) {
        throw new Error(res.data?.error ?? "prepare() failed");
      }
      setPrepareData(res.data);
      setMatchId(res.data.matchId);
      addLog(
        `prepare() ready — matchId ${shortHash(res.data.matchId)} · sending ${formatXrp(res.data.xrpDrops)} to destination tag ${res.data.destinationTag}`,
        { tone: "muted" },
      );
      await runApprove(res.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "prepare() failed";
      setS4Error(msg);
      addLog(msg, { tone: "error" });
      setS4Stage("idle");
    }
  }, [address, xrplAddress, addLog, runApprove]);

  /* ------------------------------------------------------------------------
     S5 — pay, then reuse DemoConsole's exact attest -> poll proof -> release
  ------------------------------------------------------------------------ */

  const pollProof = useCallback(async (roundId: string, requestHex: string) => {
    const start = Date.now();
    while (Date.now() - start < PROOF_CAP_MS) {
      if (!mountedRef.current) return null;
      const res = await getJSON<ProofResponse>(
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

  const pollFinalXrplBalance = useCallback(async (addr: string, before: string | null) => {
    const start = Date.now();
    const beforeNum = toNum(before);
    let last: string | null = before;
    while (Date.now() - start < XRPL_BALANCE_CAP_MS) {
      if (!mountedRef.current) return last;
      const bal = await fetchXrplBalance(addr);
      if (bal !== null) {
        last = bal;
        if (toNum(bal) > beforeNum) return bal;
      }
      await sleep(XRPL_BALANCE_POLL_MS);
    }
    return last;
  }, [fetchXrplBalance]);

  const runBalance = useCallback(async () => {
    if (!xrplAddress) return;
    setS5Stage("balance");
    const finalBal = await pollFinalXrplBalance(xrplAddress, xrplBalance);
    if (mountedRef.current) setFinalXrplBalance(finalBal);
    addLog("XRP landed on your address — settled.", { tone: "success" });
    if (mountedRef.current) setS5Stage("done");
  }, [xrplAddress, xrplBalance, addLog, pollFinalXrplBalance]);

  const runRelease = useCallback(async (proof: unknown) => {
    if (!matchId) return;
    setS5Stage("releasing");
    setS5Error(null);
    try {
      const releaseRes = await postJSON<ReleaseResponse>("/api/demo/release", { matchId, proof });
      if (!releaseRes.ok || !releaseRes.data) {
        throw new Error(releaseRes.data?.error ?? "release() failed");
      }
      addLog("release() confirmed — FXRP settled to the desk", {
        href: COSTON2_TX(releaseRes.data.releaseTx),
        linkText: shortHash(releaseRes.data.releaseTx),
        tone: "success",
      });
      await runBalance();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "release() failed";
      setS5Error(msg);
      addLog(msg, { tone: "error" });
    }
  }, [matchId, addLog, runBalance]);

  const runProve = useCallback(async (roundId: string, requestHex: string) => {
    setS5Stage("proving");
    setS5Error(null);
    try {
      const proof = await pollProof(roundId, requestHex);
      if (proof === null) {
        throw new Error("proof did not become ready within 10 minutes");
      }
      setProofData(proof);
      addLog("proof ready");
      await runRelease(proof);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "proof check failed";
      setS5Error(msg);
      addLog(msg, { tone: "error" });
    }
  }, [addLog, pollProof, runRelease]);

  const runAttest = useCallback(async (xrplTx: string) => {
    setS5Stage("attesting");
    setS5Error(null);
    try {
      const attestRes = await postJSON<AttestResponse>("/api/demo/attest", { xrplTx });
      if (!attestRes.ok || !attestRes.data) {
        throw new Error(attestRes.data?.error ?? "attest() failed");
      }
      addLog(`FDC round ${attestRes.data.roundId} — waiting for finality`, { tone: "muted" });
      setAttestRound({ roundId: attestRes.data.roundId, requestHex: attestRes.data.requestHex });
      await runProve(attestRes.data.roundId, attestRes.data.requestHex);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "attest() failed";
      setS5Error(msg);
      addLog(msg, { tone: "error" });
    }
  }, [addLog, runProve]);

  const runPay = useCallback(async () => {
    if (!matchId) return;
    setS5Stage("paying");
    setS5Error(null);
    try {
      setPayPill({ token: "XRP", reverse: true });
      const payRes = await postJSON<PayResponse>("/api/wallet/pay", { matchId });
      if (payRes.status === 404) {
        const msg = payRes.data?.error ?? "unknown matchId — prepare again";
        setPayPill(null);
        setS5Error(msg);
        addLog(msg, { tone: "error" });
        setS5Stage("idle");
        // the prepared instruction expired server-side — walk the judge back to step 4.
        setS4Stage("idle");
        setPrepareData(null);
        setMatchId(null);
        setLockTx(null);
        return;
      }
      if (payRes.status === 503 || payRes.data?.enabled === false) {
        setPayPill(null);
        setEnabled(false);
        setS5Stage("idle");
        return;
      }
      if (!payRes.ok || !payRes.data) {
        throw new Error(payRes.data?.error ?? "XRPL payment failed");
      }
      addLog("XRPL payment sent", { href: XRPL_TX(payRes.data.xrplTx), linkText: shortHash(payRes.data.xrplTx) });
      setPayPill(null);
      setXrplPayTx(payRes.data.xrplTx);
      await runAttest(payRes.data.xrplTx);
    } catch (err) {
      setPayPill(null);
      const msg = err instanceof Error ? err.message : "XRPL payment failed";
      setS5Error(msg);
      addLog(msg, { tone: "error" });
    }
  }, [matchId, addLog, runAttest]);

  /* ------------------------------------------------------------------------
     Render
  ------------------------------------------------------------------------ */

  if (hasProvider === null) {
    return (
      <div className="panel mt-6 px-6 py-8 sm:px-8 sm:py-10">
        <p className="mono-label text-[0.68rem] text-ink-3 flex items-center gap-2">
          <span className="ice-dot" />
          Checking for a wallet…
        </p>
      </div>
    );
  }

  if (hasProvider === false) {
    return (
      <div className="panel mt-6 px-6 py-8 sm:px-8 sm:py-10">
        <p className="mono-label text-[0.68rem] text-ink-3 mb-3">Be the taker</p>
        <h3 className="font-display font-semibold text-[1.3rem] text-ink mb-3">No wallet detected.</h3>
        <p className="max-w-[54ch] text-[0.95rem] leading-[1.65] text-ink-2 mb-6">
          This mode needs a browser wallet — you&apos;ll sign your own approve, deposit, and lock
          transactions on Coston2, and the settlement pays out to an XRPL address you control. No
          wallet in this browser? A real settlement is still one click away.
        </p>
        <div className="flex flex-col gap-4">
          {onSwitchToOneClick && (
            <div>
              <button
                type="button"
                onClick={onSwitchToOneClick}
                className="mono-label text-[0.68rem] px-5 py-2.5 border border-ice/50 text-ice hover:bg-ice/10 transition-colors duration-300"
              >
                Run the one-click demo — settles now
              </button>
              <p className="mono-label text-[0.56rem] text-ink-3 mt-2 max-w-[46ch] leading-relaxed">
                Runs the same lock → pay → attest → release flow on the desk&apos;s own testnet
                keys, not yours — limited to a few runs a day.
              </p>
            </div>
          )}
          <a
            href="https://metamask.io/download/"
            target="_blank"
            rel="noopener noreferrer"
            className="mono-label text-[0.62rem] text-ink-3 hover:text-ink underline underline-offset-4 w-fit"
          >
            or install MetaMask to run this mode with your own wallet
          </a>
        </div>
      </div>
    );
  }

  if (enabled === false) {
    return (
      <div className="panel mt-6 px-6 py-8 sm:px-8 sm:py-10">
        <p className="mono-label text-[0.68rem] text-ink-3 mb-3">Be the taker</p>
        <h3 className="font-display font-semibold text-[1.3rem] text-ink mb-3">Wallet mode is sleeping.</h3>
        <p className="max-w-[54ch] text-[0.95rem] leading-[1.65] text-ink-2 mb-6">
          The wallet-mode backend isn&apos;t running right now.
        </p>
        {onSwitchToOneClick && (
          <button
            type="button"
            onClick={onSwitchToOneClick}
            className="mono-label text-[0.68rem] px-5 py-2.5 border border-steel-line-2 text-ink-2 hover:text-ink hover:border-ice-deep/60 transition-colors duration-300"
          >
            Switch to one-click demo
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-6">
      {/* diagram — same visual vocabulary as DemoConsole */}
      <div className="overflow-x-auto">
        <div className="min-w-[480px] sm:min-w-0 px-2 pt-4 pb-2">
          <div className="flex items-center gap-2 sm:gap-5">
            <PartyCard sub="Taker" label="You">
              <BalanceRow token="FXRP" value={toNum(fxrp)} />
            </PartyCard>
            <Rail key={`lock-${pillTick}`} pill={lockPill} />
            <PartyCard sub="Escrow" label="WhisperDesk Vault">
              <p className="mono-data text-[0.78rem] text-ink-3">
                {matchId ? shortHash(matchId) : "—"}
              </p>
            </PartyCard>
          </div>
          <div className="mt-8 sm:mt-10 flex items-center gap-3 px-1">
            <span className="mono-label text-[0.56rem] text-ink-3 shrink-0">You</span>
            <Rail key={`pay-${pillTick}`} pill={payPill} dashed />
            <span className="mono-label text-[0.56rem] text-ink-3 shrink-0">XRP Ledger — direct payment</span>
            <Rail pill={null} dashed />
            <span className="mono-label text-[0.56rem] text-ink-3 shrink-0">Maker (desk)</span>
          </div>
        </div>
      </div>

      {/* S1 */}
      {/* The taker's blindness is narrower than the maker's — they authored the order, so they know
          their own side and size — but who is pricing them, and how many, stays inside the enclave
          until it signs a match. Naming that explicitly is worth more than leaving it implied. */}
      <WithheldPanel
        title="The enclave withholds"
        tagline="You set the terms. You never see who competes for them."
        items={TAKER_WITHHELD}
        footer="Not hidden by this screen — never sent to it. You learn a counterparty only once the enclave has signed the match that binds them to pay you."
      />

      <StepShell n={1} title="Connect wallet" done={!!address} active>
        {!address ? (
          <>
            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting}
              className="mono-label text-[0.68rem] px-5 py-2.5 border border-ice/50 text-ice hover:bg-ice/10 transition-colors duration-300 disabled:opacity-30 disabled:pointer-events-none"
            >
              {connecting ? "Connecting…" : "Connect MetaMask"}
            </button>
            {connectError && <p className="mono-label text-[0.64rem] text-iron-red mt-3">{connectError}</p>}
          </>
        ) : (
          <div className="space-y-1.5">
            <p className="mono-data text-[0.85rem] text-ink">
              <span className="text-ink-3">Address </span>
              {shortHash(address)}
            </p>
            <p className="mono-data text-[0.85rem] text-ink">
              <span className="text-ink-3">C2FLR gas </span>
              {c2flr}
            </p>
            {toNum(c2flr) === 0 && (
              <a
                href="https://faucet.flare.network"
                target="_blank"
                rel="noopener noreferrer"
                className="mono-label text-[0.62rem] text-ice hover:underline block mt-1"
              >
                Need Coston2 gas — faucet.flare.network
              </a>
            )}
          </div>
        )}
      </StepShell>

      {/* S2 */}
      <StepShell n={2} title="Get demo FXRP" done={faucetDone} active={currentStep >= 2}>
        {!faucetDone ? (
          <>
            <button
              type="button"
              onClick={handleFaucet}
              disabled={faucetBusy || currentStep < 2}
              className="mono-label text-[0.68rem] px-5 py-2.5 border border-ice/50 text-ice hover:bg-ice/10 transition-colors duration-300 disabled:opacity-30 disabled:pointer-events-none"
            >
              {faucetBusy ? "Minting…" : "Mint 2 demo FXRP"}
            </button>
            {faucetError && <p className="mono-label text-[0.64rem] text-iron-red mt-3">{faucetError}</p>}
          </>
        ) : (
          <p className="mono-data text-[0.85rem] text-ink">
            <span className="text-ink-3">FXRP balance </span>
            {fxrp}
          </p>
        )}
      </StepShell>

      {/* S3 */}
      <StepShell n={3} title="XRPL receive address" done={!!xrplAddress} active={currentStep >= 3}>
        {!xrplAddress ? (
          <div className="space-y-4">
            {/* Generate goes FIRST. Most judges have no XRPL testnet address, so this is the path
                actually taken. The earlier layout led with the paste field, which meant the first
                thing most people met was a button disabled until they typed something they did not
                have — it read as broken rather than as waiting. */}
            <button
              type="button"
              onClick={generateXrplAccount}
              disabled={xrplGenBusy}
              className="mono-label text-[0.68rem] px-5 py-2.5 border border-ice/50 text-ice hover:bg-ice/10 transition-colors duration-300 disabled:opacity-30 disabled:pointer-events-none"
            >
              {/* Named in full: reordering left "Generate one for me" with nothing to refer back to. */}
              {xrplGenBusy ? "Generating…" : "Generate an XRPL testnet address for me"}
            </button>
            <p className="mono-label text-[0.56rem] text-ink-3">
              or paste one you already control — the settlement pays out to it
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={xrplAddressInput}
                onChange={(e) => setXrplAddressInput(e.target.value)}
                placeholder="rYourTestnetAddress…"
                className="mono-data text-[0.82rem] bg-vault-2 border border-steel-line px-3 py-2 text-ink placeholder:text-ink-3 flex-1 min-w-[220px]"
              />
              <button
                type="button"
                onClick={usePastedAddress}
                disabled={!xrplAddressInput.trim()}
                className="mono-label text-[0.64rem] px-4 py-2.5 border border-steel-line-2 text-ink-2 hover:text-ink hover:border-ice-deep/60 transition-colors duration-300 disabled:opacity-30 disabled:pointer-events-none"
              >
                Use this address
              </button>
            </div>
            {xrplError && <p className="mono-label text-[0.64rem] text-iron-red">{xrplError}</p>}
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="mono-data text-[0.85rem] text-ink break-all">
              <span className="text-ink-3">Address </span>
              {xrplAddress}
            </p>
            {xrplSeed && (
              <>
                <p className="mono-data text-[0.85rem] text-ink break-all">
                  <span className="text-ink-3">Seed </span>
                  {xrplSeed}
                </p>
                <p className="mono-label text-[0.56rem] text-ink-3">
                  Throwaway testnet account — the seed is yours.
                </p>
              </>
            )}
            <p className="mono-data text-[0.85rem] text-ink">
              <span className="text-ink-3">XRPL balance </span>
              {xrplBalance ?? "—"}
            </p>
          </div>
        )}
      </StepShell>

      {/* S4 */}
      <StepShell n={4} title="Prepare + wallet confirmations" done={s4Stage === "done"} active={currentStep >= 4}>
        {s4Stage !== "done" ? (
          <div className="space-y-3">
            <button
              type="button"
              onClick={s4Stage === "idle" ? runPrepare : s4Stage === "approve" ? () => runApprove(prepareData!) : s4Stage === "deposit" ? () => runDeposit(prepareData!) : s4Stage === "lock" ? () => runLock(prepareData!) : undefined}
              disabled={currentStep < 4 || (s4Stage !== "idle" && !s4Error)}
              className="mono-label text-[0.68rem] px-5 py-2.5 border border-ice/50 text-ice hover:bg-ice/10 transition-colors duration-300 disabled:opacity-30 disabled:pointer-events-none"
            >
              {s4Stage === "idle"
                ? s4Error
                  ? "Retry prepare()"
                  : "Prepare + lock"
                : s4Stage === "preparing"
                  ? "Preparing…"
                  : s4Stage === "approve"
                    ? s4Error
                      ? "Retry approve()"
                      : "Confirm approve in wallet…"
                    : s4Stage === "deposit"
                      ? s4Error
                        ? "Retry deposit()"
                        : "Confirm deposit in wallet…"
                      : s4Error
                        ? "Retry lock()"
                        : "Confirm lock in wallet…"}
            </button>
            {prepareBusy && (
              <p className="mono-label text-[0.64rem] text-iron-red">
                Another wallet-mode run is in progress — try again in a few minutes.
              </p>
            )}
            {s4Error && <p className="mono-label text-[0.64rem] text-iron-red">{s4Error}</p>}
          </div>
        ) : (
          <p className="mono-data text-[0.85rem] text-ink">
            <span className="text-ink-3">lock() </span>
            {lockTx ? shortHash(lockTx) : "—"}
          </p>
        )}
      </StepShell>

      {/* S5 */}
      <StepShell n={5} title="Watch settlement" done={s5Stage === "done"} active={currentStep >= 5}>
        {s5Stage !== "done" ? (
          <div className="space-y-3">
            <button
              type="button"
              onClick={
                s5Stage === "idle"
                  ? runPay
                  : s5Stage === "paying"
                    ? runPay
                    : s5Stage === "attesting"
                      ? () => runAttest(xrplPayTx!)
                      : s5Stage === "proving"
                        ? () => runProve(attestRound!.roundId, attestRound!.requestHex)
                        : s5Stage === "releasing"
                          ? () => runRelease(proofData)
                          : undefined
              }
              disabled={currentStep < 5 || (s5Stage !== "idle" && !s5Error)}
              className="mono-label text-[0.68rem] px-5 py-2.5 border border-ice/50 text-ice hover:bg-ice/10 transition-colors duration-300 disabled:opacity-30 disabled:pointer-events-none"
            >
              {s5Stage === "idle" && !s5Error
                ? "Settle"
                : s5Stage === "paying"
                  ? s5Error
                    ? "Retry XRPL payment"
                    : "Sending XRPL payment…"
                  : s5Stage === "attesting"
                    ? s5Error
                      ? "Retry attest()"
                      : "Requesting FDC attestation…"
                    : s5Stage === "proving"
                      ? s5Error
                        ? "Retry proof check"
                        : "Waiting for proof…"
                      : s5Stage === "releasing"
                        ? s5Error
                          ? "Retry release()"
                          : "Releasing…"
                        : "Checking your XRPL balance…"}
            </button>
            {s5Error && <p className="mono-label text-[0.64rem] text-iron-red">{s5Error}</p>}
          </div>
        ) : (
          <p className="mono-data text-[0.85rem] text-ice">
            Final XRPL balance {finalXrplBalance ?? "—"} — settled.
          </p>
        )}
      </StepShell>

      {/* console log */}
      <div className="panel px-6 py-6 sm:px-8 sm:py-7">
        <p className="mono-label text-[0.6rem] text-ink-3 mb-3">Console</p>
        <p className="mono-label text-[0.56rem] text-ink-3 mb-4 leading-relaxed">
          Real transactions · testnet only · you sign approve, deposit, and lock with your own
          wallet — the desk signs your lock instruction with a simulated-TEE key, and relays attest
          + release.
        </p>
        <div
          aria-live="polite"
          className="max-h-[360px] overflow-y-auto space-y-2 border-t border-steel-line pt-4"
        >
          {log.length === 0 ? (
            <p className="mono-data text-[0.8rem] text-ink-3">Waiting for step 1…</p>
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
}

/* ---------------------------------------------------------------------------
   StepShell — numbered panel wrapper shared by all five steps.
--------------------------------------------------------------------------- */

function StepShell({
  n,
  title,
  done,
  active,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`panel px-6 py-6 sm:px-8 sm:py-7 transition-opacity duration-300 ${
        active ? "" : "opacity-40 pointer-events-none"
      }`}
    >
      <div className="flex items-center gap-3 mb-4">
        <span
          className={`mono-label text-[0.6rem] w-6 h-6 rounded-full border grid place-items-center shrink-0 ${
            done ? "border-ice/60 text-ice" : "border-steel-line-2 text-ink-3"
          }`}
        >
          {done ? <IconCheck className="h-3 w-3" /> : n}
        </span>
        <p className="mono-label text-[0.68rem] text-ink-2">{title}</p>
      </div>
      {children}
    </div>
  );
}
