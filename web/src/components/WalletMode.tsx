"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BalanceRow, IconCheck, PartyCard, Rail, type PillSpec } from "@/components/flow/parts";
import Holdings from "@/components/Holdings";
import MarketReference from "@/components/MarketReference";
import AuctionRule from "@/components/AuctionRule";
import WithheldPanel, { TAKER_WITHHELD } from "@/components/WithheldPanel";
import { useWalletAccount } from "@/lib/useWalletAccount";
import {
  connect,
  ensureCoston2,
  sendApprove,
  sendDeposit,
  sendLock,
  sendSubmitRfq,
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
/** /api/wallet/gas. `skipped` comes back when the address could already pay its own way, in which
 *  case there is no txHash — the balance is still authoritative and worth showing. */
type GasResponse = {
  txHash?: string;
  sent?: string;
  balance: string;
  skipped?: boolean;
  reason?: string;
  error?: string;
  enabled?: boolean;
};
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

  // S1 — gas drip (sits inside step 1: you cannot sign anything without it)
  const [gasBusy, setGasBusy] = useState(false);
  const [gasError, setGasError] = useState<string | null>(null);

  // Publishing to the open desk — the path where a real maker, not the desk, fills you.
  const [publishStage, setPublishStage] = useState<
    "idle" | "sealing" | "approving" | "depositing" | "submitting" | "confirming" | "waiting"
  >("idle");
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishedRfqId, setPublishedRfqId] = useState<string | null>(null);
  const [fill, setFill] = useState<{ maker: string; xrpDrops: string } | null>(null);

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

  // Funding is no longer a numbered step, but it still gates: an unfunded wallet holds the flow at
  // step 1 rather than advancing into a trade it cannot pay for. The Holdings card carries the
  // action, so nothing is unreachable while this sits at 1.
  // Funded means HOLDS FXRP, not "clicked the faucet this session". Gating on faucetDone told a
  // judge who already held a balance — from an earlier run, or a previous visit — to go and mint
  // more, while the Holdings panel beside it displayed the balance they supposedly did not have.
  const funded = faucetDone || toNum(fxrp) > 0;

  // 0 means "not ready to trade yet" — no wallet, or nothing to trade with. Both are handled by
  // their own cards rather than by an inert numbered step, so the trade itself starts at 1.
  const currentStep = !address || !funded ? 0 : !xrplAddress ? 1 : s4Stage !== "done" ? 2 : 3;

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
     S1b — C2FLR gas drip.

     Gas was the only funding step that used to send a judge off the site
     mid-run. The desk covers it now; the route decides whether to, and the
     external faucet stays on screen as the fallback when it declines.
  ------------------------------------------------------------------------ */

  const handleGas = useCallback(async () => {
    if (!address) return;
    setGasBusy(true);
    setGasError(null);
    try {
      const res = await postJSON<GasResponse>("/api/wallet/gas", { address });
      if (res.status === 429) {
        setGasError(res.data?.error ?? "gas already sent to this address in the last 10 minutes");
        return;
      }
      if (res.status === 503 || res.data?.enabled === false) {
        setEnabled(false);
        return;
      }
      if (!res.ok || !res.data) {
        throw new Error(res.data?.error ?? "gas drip failed");
      }
      setC2flr(res.data.balance);
      // Already funded: the balance is worth updating, but there is no transaction to announce.
      if (res.data.skipped || !res.data.txHash) return;
      addLog(`Desk sent ${res.data.sent} C2FLR for gas`, {
        href: COSTON2_TX(res.data.txHash),
        linkText: shortHash(res.data.txHash),
        tone: "success",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "gas drip failed";
      setGasError(msg);
      addLog(msg, { tone: "error" });
    } finally {
      if (mountedRef.current) setGasBusy(false);
    }
  }, [address, addLog]);

  /* ------------------------------------------------------------------------
     Publish to the open desk.

     The other path in this seat trades against the desk: /api/wallet/prepare
     has the desk sign the match as maker. This one puts the order in the
     shared queue instead, so whoever is sitting in a maker seat can quote it —
     which is the only way two independent people end up on one trade.

     submitRfq goes out from the judge's own wallet on purpose. The sender
     contract stamps the taker from msg.sender, and that stamp is what makes a
     taker's identity unforgeable; relaying it from a desk key would hand back
     the property the whole on-chain ingress exists to provide.
  ------------------------------------------------------------------------ */

  const runPublishRfq = useCallback(async () => {
    if (!address || !xrplAddress) return;
    setPublishError(null);
    try {
      setPublishStage("sealing");
      const prep = await postJSON<{
        ciphertext: string;
        senderAddress: string;
        relayFeeWei: string;
        escrow: string;
        approve: { token: string; spender: string; amount: string };
        deposit: { amount: string; armedUntil: string };
        error?: string;
        enabled?: boolean;
      }>("/api/taker/rfq/prepare", { taker: address, xrplAddress });
      if (prep.status === 503 || prep.data?.enabled === false) {
        setEnabled(false);
        setPublishStage("idle");
        return;
      }
      if (!prep.ok || !prep.data) throw new Error(prep.data?.error ?? "could not seal the RFQ");
      addLog("RFQ sealed to the enclave — its contents never touch this browser.", { tone: "muted" });

      // The open desk settles on a DIFFERENT escrow from this seat's default path, and that escrow
      // has its own MockFXRP. Holdings mints the other one, so a judge who minted there arrived
      // here holding a balance this escrow cannot see — "MockFXRP: insufficient balance", with the
      // balance visibly sitting in the rail beside the error. Top up the right token first.
      // A 429 means they already hold some from an earlier run: success, not failure.
      const topUp = await postJSON<{ minted?: string; error?: string }>("/api/maker/faucet", {
        address,
      });
      if (topUp.ok && topUp.data?.minted) {
        addLog(`Topped up ${topUp.data.minted} FXRP for the open-desk escrow`, { tone: "muted" });
      }

      setPublishStage("approving");
      await sendApprove(prep.data.approve);

      setPublishStage("depositing");
      const depositTx = await sendDeposit(prep.data.escrow, prep.data.deposit);
      addLog("FXRP deposited and armed", {
        href: COSTON2_TX(depositTx),
        linkText: shortHash(depositTx),
      });

      setPublishStage("submitting");
      const rfqTx = await sendSubmitRfq({
        senderAddress: prep.data.senderAddress,
        ciphertext: prep.data.ciphertext,
        relayFeeWei: prep.data.relayFeeWei,
      });
      addLog("submitRfq() sent from your wallet — the taker is stamped from msg.sender", {
        href: COSTON2_TX(rfqTx),
        linkText: shortHash(rfqTx),
        tone: "success",
      });

      setPublishStage("confirming");
      const conf = await postJSON<{ rfqId: string; windowEndsAt: number; error?: string }>(
        "/api/taker/rfq/confirm",
        { txHash: rfqTx, taker: address }
      );
      if (!conf.ok || !conf.data?.rfqId) throw new Error(conf.data?.error ?? "the enclave did not ack the RFQ");

      setPublishedRfqId(conf.data.rfqId);
      setPublishStage("waiting");
      addLog(
        `Live on the desk — rfqId ${shortHash(conf.data.rfqId)}. Any maker can now quote it, and none of them can read it.`,
        { tone: "success" }
      );
    } catch (err) {
      const msg =
        err instanceof WalletRejectionError
          ? "you rejected the transaction in your wallet"
          : err instanceof Error
            ? err.message
            : "publishing failed";
      setPublishError(msg);
      addLog(msg, { tone: "error" });
      setPublishStage("idle");
    }
  }, [address, xrplAddress, addLog]);

  // Watch the chain for a fill. The answer only counts if the escrow says it, so this reads
  // matches(rfqId) rather than trusting any server-side record of what happened.
  useEffect(() => {
    if (!publishedRfqId || fill) return;
    let cancelled = false;
    const poll = async () => {
      const res = await getJSON<{ filled?: boolean; maker?: string; xrpDrops?: string }>(
        `/api/taker/rfq/status?rfqId=${publishedRfqId}`
      );
      if (cancelled || !res.ok || !res.data?.filled || !res.data.maker) return;
      setFill({ maker: res.data.maker, xrpDrops: res.data.xrpDrops ?? "0" });
      addLog(
        `Filled by ${shortHash(res.data.maker)} — a maker you have never seen, who never saw your order.`,
        { tone: "success" }
      );
    };
    void poll();
    const t = setInterval(() => void poll(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [publishedRfqId, fill, addLog]);

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

  // Left column is the work; the right rail is standing context — reference price, what the enclave
  // withholds, what you hold. Stacked above the steps those three scrolled away the moment a judge
  // started working. Pinned beside the flow they stay answerable at a glance, which is the whole
  // reason a trading screen has a rail at all.
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start">
      <div className="min-w-0 space-y-6">
      {/* The party-and-rails diagram lived here. It restated what the Holdings rail and the console
          log already say, cost roughly 200px above the fold, and animated while a judge was trying
          to read. The landing page is where the mechanism gets explained; this is where it runs. */}

      {/* Connecting happens at the door now, so it is no longer a stage of the trade — it only
          reappears if the wallet was disconnected mid-run, which is a recovery, not a step. */}
      {!address && (
        <div className="panel px-6 py-5">
          <p className="mono-label text-[0.6rem] text-ice">Wallet disconnected</p>
          <p className="text-[0.9rem] text-ink mt-1.5">Reconnect to pick the run back up.</p>
          <button
            type="button"
            onClick={handleConnect}
            disabled={connecting}
            className="mono-label text-[0.64rem] mt-4 px-5 py-2.5 border border-ice/50 text-ice hover:bg-ice/10 transition-colors duration-300 disabled:opacity-30 disabled:pointer-events-none"
          >
            {connecting ? "Connecting…" : "Reconnect MetaMask"}
          </button>
          {connectError && <p className="mono-label text-[0.6rem] text-iron-red mt-3">{connectError}</p>}
        </div>
      )}

      {/* Nothing can be signed without FXRP, and the mint lives in the rail — so say that, rather
          than showing an inert step the judge cannot act on. */}
      {address && !funded && (
        <div className="panel px-6 py-5">
          <p className="mono-label text-[0.6rem] text-ice">One thing first</p>
          <p className="text-[0.9rem] text-ink mt-1.5">
            Mint your demo FXRP in <span className="text-ice">Holdings</span> — the desk pays for it.
          </p>
        </div>
      )}

      {/* Only what can be acted on now, plus what already happened. Future stages stay out of the
          way entirely: a ladder of greyed-out boxes describes the plumbing, not the trade. */}
      {currentStep >= 1 && (
      <StepShell n={1} title="Your receive address" done={!!xrplAddress} active={currentStep === 1}>
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
      )}

      {/* The open desk. Everything below this panel trades against the house; this one puts the
          order where a stranger can fill it. Shown once an XRPL address exists, because that
          address is what the maker's XRP has to land on. */}
      {xrplAddress && !publishedRfqId && (
        <div className="panel px-6 py-5">
          <div className="flex items-baseline justify-between gap-3">
            <p className="mono-label text-[0.6rem] text-ice">Publish to the open desk</p>
            <p className="mono-label text-[0.5rem] text-ink-3">optional</p>
          </div>
          <p className="text-[0.88rem] leading-[1.55] text-ink-2 mt-2 max-w-[62ch]">
            Put your sealed order in the shared queue instead of trading against the house. A maker
            in another window can quote it — without reading your side, size, or limit — and the
            enclave awards it to the best price.
          </p>
          <button
            type="button"
            onClick={runPublishRfq}
            disabled={publishStage !== "idle"}
            className="mono-label text-[0.64rem] mt-4 px-5 py-2.5 border border-ice/50 text-ice hover:bg-ice/10 transition-colors duration-300 disabled:opacity-30 disabled:pointer-events-none"
          >
            {publishStage === "idle"
              ? publishError
                ? "Retry publish"
                : "Publish my RFQ"
              : publishStage === "sealing"
                ? "Sealing to the enclave…"
                : publishStage === "approving"
                  ? "Confirm approve in wallet…"
                  : publishStage === "depositing"
                    ? "Confirm deposit in wallet…"
                    : publishStage === "submitting"
                      ? "Confirm submitRfq in wallet…"
                      : "Waiting for the enclave…"}
          </button>
          {publishError && <p className="mono-label text-[0.6rem] text-iron-red mt-3">{publishError}</p>}
        </div>
      )}

      {publishedRfqId && (
        <div className="panel px-6 py-5">
          <p className="mono-label text-[0.6rem] text-ice">
            {fill ? "Filled by an independent maker" : "Live on the open desk"}
          </p>
          <p className="mono-data text-[0.85rem] text-ink mt-2">
            <span className="text-ink-3">rfqId </span>
            {shortHash(publishedRfqId)}
          </p>
          {fill ? (
            <p className="mono-data text-[0.85rem] text-ink mt-1.5">
              <span className="text-ink-3">maker </span>
              {shortHash(fill.maker)}
              <span className="mono-label text-[0.56rem] text-ink-3 block mt-2 leading-relaxed">
                Someone you have never seen priced your order without reading it. They now owe the
                XRP leg to your address, and the escrow will not release your FXRP until the Flare
                Data Connector proves it arrived.
              </span>
            </p>
          ) : (
            <p className="mono-label text-[0.56rem] text-ink-3 mt-2 leading-relaxed">
              Open a maker seat in another window and quote this id. Nobody quoting it can see your
              side, size, or limit — and no maker is told whether another maker is on it.
            </p>
          )}
        </div>
      )}

      {currentStep >= 2 && (
      <StepShell n={2} title="Open the trade" done={s4Stage === "done"} active={currentStep === 2}>
        {s4Stage !== "done" ? (
          <div className="space-y-3">
            <button
              type="button"
              onClick={s4Stage === "idle" ? runPrepare : s4Stage === "approve" ? () => runApprove(prepareData!) : s4Stage === "deposit" ? () => runDeposit(prepareData!) : s4Stage === "lock" ? () => runLock(prepareData!) : undefined}
              disabled={currentStep < 2 || (s4Stage !== "idle" && !s4Error)}
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
      )}

      {currentStep >= 3 && (
      <StepShell n={3} title="Settlement" done={s5Stage === "done"} active={currentStep === 3}>
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
              disabled={currentStep < 3 || (s5Stage !== "idle" && !s5Error)}
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
      )}

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
            <p className="mono-data text-[0.8rem] text-ink-3">Idle — nothing sent yet.</p>
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

      {/* The rail. Sticky on wide screens so it survives the scroll through five steps; on narrow
          ones the grid collapses and it simply follows the flow, which is the right fallback —
          there is no room to pin anything on a phone. */}
      <aside className="space-y-4 lg:sticky lg:top-6">
        <MarketReference />

        {/* A taker not being offered a list of quotes to choose from looks like a missing feature
            until the reason is on screen. It belongs in this seat more than the maker's. */}
        <AuctionRule />

        {address && (
          <Holdings
            address={address}
            fxrp={fxrp}
            c2flr={c2flr}
            xrp={xrplBalance}
            onFaucet={handleFaucet}
            faucetBusy={faucetBusy}
            faucetDone={funded}
            faucetError={faucetError}
            onGas={handleGas}
            gasBusy={gasBusy}
            gasError={gasError}
            /* Threshold, not zero: dust is as unspendable as an empty wallet, and it matches the
               route's GAS_ENOUGH_WEI so the button never offers a drip that would be skipped. */
            needsGas={toNum(c2flr) < 0.1}
          />
        )}

        {/* The taker's blindness is narrower than the maker's — they authored the order, so they
            know their own side and size — but who is pricing them, and how many, stays inside the
            enclave until it signs a match. Naming that explicitly beats leaving it implied. */}
        <WithheldPanel
          title="The enclave withholds"
          tagline="You set the terms. You never see who competes for them."
          items={TAKER_WITHHELD}
          footer="Not hidden by this screen — never sent to it. You learn a counterparty only once the enclave has signed the match that binds them to pay you."
        />
      </aside>
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
  // A stage you cannot reach yet is not information, it is furniture. `active` is already true for
  // the current stage and every finished one, so dropping the rest leaves exactly the trade: what
  // you are doing, above the receipts of what you already did.
  if (!active) return null;

  // No number on the badge any more. With only the current stage rendered, a numeral answered a
  // question nobody was asking — "which of seven forms am I on" — and made a desk read like an
  // onboarding wizard. A live dot or a tick says the same thing a terminal would: this is what is
  // happening, or this is done. The ordinal stays in the DOM as data-stage for tests, which is the
  // only reader that ever needed it.
  return (
    <div className="panel overflow-hidden" data-stage={n}>
      <div className="px-6 py-3.5 border-b border-steel-line flex items-center gap-2.5">
        {done ? (
          <IconCheck className="h-3 w-3 text-ice shrink-0" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-ice animate-pulse shrink-0" aria-hidden="true" />
        )}
        <p className="mono-label text-[0.6rem] text-ice">{title}</p>
      </div>
      <div className="px-6 py-5">{children}</div>
    </div>
  );
}
