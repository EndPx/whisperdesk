"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { BalanceRow, IconCheck, PartyCard, Rail, type PillSpec } from "@/components/flow/parts";
import { useWalletAccount } from "@/lib/useWalletAccount";
import {
  connect,
  detectProvider,
  ensureCoston2,
  COSTON2_CHAIN_PARAMS,
} from "@/lib/wallet-client";
import { BOND_LEDGER_ABI, DVP_ESCROW_ABI, FTSOV2_ABI, MOCK_FXRP_ABI, XRP_USD_FEED_ID } from "@/lib/demo/abi";

/* ---------------------------------------------------------------------------
   MakerMode — "Be the maker". The judge connects their own MetaMask and plays
   the OTHER side of the trade: the desk seals an RFQ (acting as taker, funding
   + depositing + locking its own side), and the judge quotes blind against it,
   never seeing the RFQ's side/size/limit. If the enclave crosses the quote,
   the judge pays the XRP leg and watches their own wallet receive the released
   FXRP. This is the only demo path where two independent parties are actually
   matched inside the enclave — WalletMode.tsx shows the mirror image (judge as
   taker, desk as maker) and this file intentionally mirrors its structure,
   stage handling, and console-log conventions rather than inventing a new one.

   Drives the fixed maker-mode API contract (web/src/app/api/maker/*) for steps
   1-6, then reuses the SAME /api/demo/proof -> /api/maker/release orchestration
   WalletMode.tsx uses for step 7, so every demo path settles through the
   identical FDC-proven release.

   Small helpers below (shortHash, formatXrp, toneClass, callApi, StepShell, a
   local getSigner/rejection check, ...) are intentionally duplicated from
   WalletMode.tsx / DemoConsole.tsx — those files don't export them, and this
   component must reproduce their behavior byte-for-byte rather than
   approximate it.
--------------------------------------------------------------------------- */

const COSTON2_TX = (hash: string) => `https://coston2-explorer.flare.network/tx/${hash}`;
const XRPL_TX = (hash: string) => `https://testnet.xrpl.org/transactions/${hash}`;
const XRPL_ACCOUNT = (address: string) => `https://testnet.xrpl.org/accounts/${address}`;

const PILL_MS = 1300; // mirrors --pill-ms in globals.css / WalletMode.tsx
const PROOF_POLL_MS = 10_000;
const PROOF_CAP_MS = 10 * 60 * 1000;
const PAYMENT_POLL_MS = 5_000;
const PAYMENT_CAP_MS = 10 * 60 * 1000;
const FXRP_BALANCE_POLL_MS = 4_000;
const FXRP_BALANCE_CAP_MS = 60 * 1000;

// FXRP is fixed at 6 decimals on Coston2 (contracts/src/mocks/MockFXRP.sol) — never hand-parsed
// from the chain, just pinned here the same way XRP_USD_FEED_ID is pinned in lib/demo/abi.ts.
const FXRP_DECIMALS = 6;

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

function fmtUsdMid(mid18: bigint | null) {
  if (mid18 === null) return "—";
  return Number(ethers.formatUnits(mid18, 18)).toLocaleString(undefined, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  });
}

function fmtCountdown(totalSeconds: number | null) {
  if (totalSeconds === null) return "—";
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
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
   Local wallet helpers — duplicated from wallet-client.ts (which doesn't
   export a generic signer or EIP-712 helper) rather than widening that
   module's surface for one caller.
--------------------------------------------------------------------------- */

async function getMakerSigner() {
  const eth = detectProvider();
  if (!eth) throw new Error("no wallet detected");
  const provider = new ethers.BrowserProvider(eth);
  return provider.getSigner();
}

function isUserRejection(err: unknown): boolean {
  const e = err as { code?: number | string; info?: { error?: { code?: number } } };
  return e?.code === 4001 || e?.code === "ACTION_REJECTED" || e?.info?.error?.code === 4001;
}

function walletErrorMessage(err: unknown, fallback: string): string {
  if (isUserRejection(err)) return "Rejected in wallet — try again.";
  return err instanceof Error ? err.message : fallback;
}

// Mirrors extension/fcewire/quoteauth.go's domain + Quote type exactly (also mirrored in
// scripts/enclave-loop/sign-quote.mjs) — do not change field order or types independently of that.
const QUOTE_TYPES: Record<string, { name: string; type: string }[]> = {
  Quote: [
    { name: "rfqId", type: "bytes32" },
    { name: "maker", type: "address" },
    { name: "priceUsdE18", type: "uint256" },
    { name: "maxFxrpRaw", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

function quoteDomain(escrowAddress: string) {
  return {
    name: "WhisperDesk",
    version: "1",
    chainId: 114,
    verifyingContract: ethers.getAddress(escrowAddress),
  };
}

/// Reads the live FTSOv2 XRP/USD mid (18-dec) via a read-only public RPC call — no wallet/signer
/// needed, mirrors web/src/lib/demo/flow.ts's readLiveFtsoMid (server-side) but client-side against
/// the escrow this RFQ is sealed on, discovering ftsoV2() from the escrow itself rather than from
/// an env var.
async function readFtsoMidClient(escrowAddress: string): Promise<bigint> {
  const provider = new ethers.JsonRpcProvider(COSTON2_CHAIN_PARAMS.rpcUrls[0], 114);
  const escrow = new ethers.Contract(escrowAddress, DVP_ESCROW_ABI, provider);
  const ftsoAddress: string = await escrow.ftsoV2();
  const ftso = new ethers.Contract(ftsoAddress, FTSOV2_ABI, provider);
  const fee: bigint = await ftso.calculateFeeById(XRP_USD_FEED_ID);
  const [mid18]: [bigint, bigint] = await ftso.getFeedByIdInWei.staticCall(XRP_USD_FEED_ID, { value: fee });
  return mid18;
}

function bandOf(mid18: bigint) {
  return { lower: (mid18 * BigInt(99)) / BigInt(100), upper: (mid18 * BigInt(101)) / BigInt(100) };
}

function formatReasons(reasons: unknown): string[] {
  if (!reasons) return [];
  if (Array.isArray(reasons)) return reasons.map((r) => String(r));
  if (typeof reasons === "object") {
    return Object.entries(reasons as Record<string, unknown>).map(([k, v]) =>
      typeof v === "number" && v !== 1 ? `${k} (×${v})` : k
    );
  }
  return [String(reasons)];
}

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
   API response shapes — MAKER-MODE API CONTRACT (fixed)
--------------------------------------------------------------------------- */

type StatusResponse = { enabled: boolean; fxrp: string; c2flr: string; freeBond: string };
type FaucetResponse = { txHash: string; minted: string; balance: string; error?: string; enabled?: boolean };
type OpenRfqResponse = {
  rfqId: string;
  windowEndsAt: string;
  escrow: string;
  bondLedger: string;
  bondAmount: string;
  approve: { token: string; spender: string; amount: string };
  depositBond: { amount: string };
  error?: string;
  busy?: boolean;
  enabled?: boolean;
};
type QuoteResponse = { accepted: boolean; replaced?: boolean; error?: string; enabled?: boolean };
type MatchResponse = {
  outcome: string;
  matchId?: string;
  xrpDrops?: string;
  destinationTag?: string;
  xrplDestination?: string;
  paymentDeadline?: string;
  reasons?: unknown;
  error?: string;
  enabled?: boolean;
};
type XrplAccountResponse = { address: string; seed: string; funded: boolean; error?: string; enabled?: boolean };
type PayResponse = { xrplTx: string; error?: string; enabled?: boolean };
type PaymentStatusResponse = { paid: boolean; xrplTx?: string; error?: string };

/// "expired" is distinct from "timeout" on purpose: a timeout can be retried, an expired payment
/// window cannot — the escrow will refuse the payment outright.
type PollOutcome = { status: "paid"; tx: string | null } | { status: "expired" } | { status: "timeout" };
type SettleResponse = { attested: boolean; roundId: string; requestHex: string; error?: string; enabled?: boolean };
type ProofResponse = { ready: boolean; proof?: unknown; error?: string };
type ReleaseResponse = { releaseTx: string; error?: string };

type S3Stage = "idle" | "opening" | "approve" | "depositBond" | "done";
type S4Stage = "idle" | "signing" | "submitting" | "done";
type S6Stage = "idle" | "funding" | "paying" | "polling" | "done";
type S7Stage = "idle" | "settling" | "proving" | "releasing" | "balance" | "done";

export default function MakerMode({
  onSwitchToOneClick,
  onBusyChange,
}: {
  onSwitchToOneClick?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const mountedRef = useRef(true);
  const logIdRef = useRef(0);
  const nonceRef = useRef(1);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // S1 — connect
  // Shared with taker mode via useWalletAccount, so switching between the two own-wallet modes
  // keeps the connection instead of dropping it with this component's state.
  const { hasProvider, address, setAddress } = useWalletAccount();
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [c2flr, setC2flr] = useState("0");
  const [fxrp, setFxrp] = useState("0");
  const [freeBond, setFreeBond] = useState("0");

  // S2 — faucet
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const [faucetDone, setFaucetDone] = useState(false);

  // S3 — open RFQ + approve + depositBond
  const [s3Stage, setS3Stage] = useState<S3Stage>("idle");
  const [s3Error, setS3Error] = useState<string | null>(null);
  const [rfqBusy, setRfqBusy] = useState(false);
  const [rfqData, setRfqData] = useState<OpenRfqResponse | null>(null);
  const [rfqWindowMs, setRfqWindowMs] = useState<number | null>(null);
  const [bondTx, setBondTx] = useState<string | null>(null);

  // S4 — quote
  const [ftsoMid18, setFtsoMid18] = useState<bigint | null>(null);
  const [ftsoError, setFtsoError] = useState<string | null>(null);
  const [ftsoBusy, setFtsoBusy] = useState(false);
  const [priceInput, setPriceInput] = useState("");
  const [maxFxrpInput, setMaxFxrpInput] = useState("1000");
  const [s4Stage, setS4Stage] = useState<S4Stage>("idle");
  const [s4Error, setS4Error] = useState<string | null>(null);
  const [quoteAccepted, setQuoteAccepted] = useState(false);
  const [quoteReplaced, setQuoteReplaced] = useState(false);

  // S5 — match
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [noMatchReasons, setNoMatchReasons] = useState<string[] | null>(null);
  const [xrpDrops, setXrpDrops] = useState<string | null>(null);
  const [destinationTag, setDestinationTag] = useState<string | null>(null);
  const [xrplDestination, setXrplDestination] = useState<string | null>(null);
  const [paymentDeadlineMs, setPaymentDeadlineMs] = useState<number | null>(null);

  // S6 — pay the XRP leg
  const [payMethod, setPayMethod] = useState<"auto" | "manual" | null>(null);
  const [s6Stage, setS6Stage] = useState<S6Stage>("idle");
  const [s6Error, setS6Error] = useState<string | null>(null);
  const [payXrplAddress, setPayXrplAddress] = useState<string | null>(null);
  const [payXrplSeed, setPayXrplSeed] = useState<string | null>(null);
  const [payXrplTx, setPayXrplTx] = useState<string | null>(null);

  // S7 — settle: attest -> poll proof -> release -> poll final balance
  const [s7Stage, setS7Stage] = useState<S7Stage>("idle");
  const [s7Error, setS7Error] = useState<string | null>(null);
  const [attestRound, setAttestRound] = useState<{ roundId: string; requestHex: string } | null>(null);
  const [proofData, setProofData] = useState<unknown | null>(null);
  const [releaseTx, setReleaseTx] = useState<string | null>(null);
  const [finalFxrp, setFinalFxrp] = useState<string | null>(null);

  const [log, setLog] = useState<LogLine[]>([]);
  const [bondPill, setBondPill] = useState<PillSpec>(null);
  const [payPill, setPayPill] = useState<PillSpec>(null);
  const [pillTick, setPillTick] = useState(0);

  useEffect(() => {
    if (!bondPill && !payPill) return;
    const id = setInterval(() => setPillTick((t) => t + 1), PILL_MS);
    return () => clearInterval(id);
  }, [bondPill, payPill]);

  const addLog = useCallback((text: string, opts?: { href?: string; linkText?: string; tone?: LogTone }) => {
    if (!mountedRef.current) return;
    logIdRef.current += 1;
    setLog((prev) => [
      ...prev,
      {
        id: `m${logIdRef.current}`,
        ts: nowTs(),
        text,
        href: opts?.href,
        linkText: opts?.linkText,
        tone: opts?.tone ?? "normal",
      },
    ]);
  }, []);

  // Ticks the RFQ-window and payment-deadline countdowns once a second. Date.now() stays inside
  // the deferred interval callback (never called synchronously in the render body).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (rfqWindowMs === null && paymentDeadlineMs === null) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [rfqWindowMs, paymentDeadlineMs]);

  const rfqRemainingSeconds = rfqWindowMs === null ? null : Math.floor((rfqWindowMs - Date.now()) / 1000);
  const paymentRemainingSeconds =
    paymentDeadlineMs === null ? null : Math.floor((paymentDeadlineMs - Date.now()) / 1000);

  /// The on-chain payment window has closed with no payment landed. Derived rather than stored, so
  /// it is true the instant the countdown hits zero — whether or not a poll happened to be running.
  const paymentExpired =
    s6Stage !== "done" && paymentRemainingSeconds !== null && paymentRemainingSeconds <= 0;

  const currentStep = !address
    ? 1
    : !faucetDone
      ? 2
      : s3Stage !== "done"
        ? 3
        : !quoteAccepted
          ? 4
          : !matchId
            ? 5
            : s6Stage !== "done"
              ? 6
              : 7;

  const makerBusy =
    connecting ||
    faucetBusy ||
    (s3Stage !== "idle" && s3Stage !== "done") ||
    (s4Stage !== "idle" && s4Stage !== "done") ||
    matching ||
    (s6Stage !== "idle" && s6Stage !== "done") ||
    (s7Stage !== "idle" && s7Stage !== "done");

  useEffect(() => {
    onBusyChange?.(makerBusy);
  }, [makerBusy, onBusyChange]);

  /* ------------------------------------------------------------------------
     S1 — connect wallet
  ------------------------------------------------------------------------ */

  const refreshStatus = useCallback(async (addr: string) => {
    const res = await getJSON<StatusResponse>(`/api/maker/status?maker=${encodeURIComponent(addr)}`);
    if (res.status === 503 || res.data?.enabled === false) {
      if (mountedRef.current) setEnabled(false);
      return;
    }
    if (!res.ok || !res.data) {
      addLog("could not load maker status", { tone: "error" });
      return;
    }
    if (!mountedRef.current) return;
    setEnabled(true);
    setC2flr(res.data.c2flr);
    setFxrp(res.data.fxrp);
    setFreeBond(res.data.freeBond);
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
      const msg = walletErrorMessage(err, "wallet connection failed");
      setConnectError(msg);
      addLog(msg, { tone: "error" });
    } finally {
      if (mountedRef.current) setConnecting(false);
    }
  }, [addLog, refreshStatus]);

  /* ------------------------------------------------------------------------
     S2 — demo FXRP faucet (funds the bond)
  ------------------------------------------------------------------------ */

  const handleFaucet = useCallback(async () => {
    if (!address) return;
    setFaucetBusy(true);
    setFaucetError(null);
    try {
      const res = await postJSON<FaucetResponse>("/api/maker/faucet", { address });
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
     S3 — open a sealed RFQ to quote against, then approve + depositBond
  ------------------------------------------------------------------------ */

  const runDepositBond = useCallback(async (data: OpenRfqResponse) => {
    if (!address) return;
    setS3Stage("depositBond");
    setS3Error(null);
    try {
      const signer = await getMakerSigner();
      setBondPill({ token: "bond" });
      const bondLedger = new ethers.Contract(data.bondLedger, BOND_LEDGER_ABI, signer);
      const tx = await bondLedger.depositBond(data.depositBond.amount);
      const receipt = await tx.wait();
      setBondTx(receipt.hash);
      addLog("depositBond() confirmed — bond posted, quoting is live", {
        href: COSTON2_TX(receipt.hash),
        linkText: shortHash(receipt.hash),
        tone: "success",
      });
      setBondPill(null);
      if (mountedRef.current) setS3Stage("done");
      await refreshStatus(address);
    } catch (err) {
      setBondPill(null);
      const msg = walletErrorMessage(err, "depositBond() failed");
      setS3Error(msg);
      addLog(msg, { tone: "error" });
    }
  }, [address, addLog, refreshStatus]);

  const runApprove = useCallback(async (data: OpenRfqResponse) => {
    setS3Stage("approve");
    setS3Error(null);
    try {
      const signer = await getMakerSigner();
      const token = new ethers.Contract(data.approve.token, MOCK_FXRP_ABI, signer);
      const tx = await token.approve(data.approve.spender, data.approve.amount);
      const receipt = await tx.wait();
      addLog("approve() confirmed", { href: COSTON2_TX(receipt.hash), linkText: shortHash(receipt.hash) });
      await runDepositBond(data);
    } catch (err) {
      const msg = walletErrorMessage(err, "approve() failed");
      setS3Error(msg);
      addLog(msg, { tone: "error" });
    }
  }, [addLog, runDepositBond]);

  const runOpenRfq = useCallback(async () => {
    if (!address) return;
    setS3Stage("opening");
    setS3Error(null);
    setRfqBusy(false);
    try {
      const res = await postJSON<OpenRfqResponse>("/api/maker/open-rfq", { maker: address });
      if (res.status === 409) {
        setRfqBusy(true);
        setS3Stage("idle");
        return;
      }
      if (res.status === 503 || res.data?.enabled === false) {
        setEnabled(false);
        setS3Stage("idle");
        return;
      }
      if (!res.ok || !res.data) {
        throw new Error(res.data?.error ?? "open-rfq() failed");
      }
      setRfqData(res.data);
      setRfqWindowMs(Number(res.data.windowEndsAt) * 1000);
      addLog(
        `RFQ sealed — rfqId ${shortHash(res.data.rfqId)}. Its side, size, and limit are inside the enclave only — not shown to you. That's the point.`,
        { tone: "muted" }
      );
      await runApprove(res.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "open-rfq() failed";
      setS3Error(msg);
      addLog(msg, { tone: "error" });
      setS3Stage("idle");
    }
  }, [address, addLog, runApprove]);

  /* ------------------------------------------------------------------------
     S4 — quote it: prefill the live FTSOv2 mid, sign EIP-712 in MetaMask
  ------------------------------------------------------------------------ */

  const refreshFtsoMid = useCallback(async () => {
    if (!rfqData) return;
    setFtsoBusy(true);
    setFtsoError(null);
    try {
      const mid = await readFtsoMidClient(rfqData.escrow);
      if (!mountedRef.current) return;
      setFtsoMid18(mid);
      if (!priceInput) setPriceInput(Number(ethers.formatUnits(mid, 18)).toFixed(6));
    } catch (err) {
      setFtsoError(err instanceof Error ? err.message : "could not read the live FTSOv2 mid");
    } finally {
      if (mountedRef.current) setFtsoBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfqData]);

  useEffect(() => {
    if (s3Stage === "done" && rfqData && ftsoMid18 === null && !ftsoBusy) {
      refreshFtsoMid();
    }
  }, [s3Stage, rfqData, ftsoMid18, ftsoBusy, refreshFtsoMid]);

  const runQuote = useCallback(async () => {
    if (!address || !rfqData) return;
    setS4Stage("signing");
    setS4Error(null);
    try {
      const priceUsdE18 = ethers.parseUnits(priceInput || "0", 18).toString();
      const maxFxrpRaw = ethers.parseUnits(maxFxrpInput || "0", FXRP_DECIMALS).toString();
      const nonce = String(nonceRef.current);
      const signer = await getMakerSigner();
      const value = { rfqId: rfqData.rfqId, maker: address, priceUsdE18, maxFxrpRaw, nonce };
      const sig = await signer.signTypedData(quoteDomain(rfqData.escrow), QUOTE_TYPES, value);

      setS4Stage("submitting");
      const res = await postJSON<QuoteResponse>("/api/maker/quote", {
        rfqId: rfqData.rfqId,
        maker: address,
        priceUsdE18,
        maxFxrpRaw,
        nonce,
        sig,
      });
      if (res.status === 503 || res.data?.enabled === false) {
        setEnabled(false);
        setS4Stage("idle");
        return;
      }
      if (res.status === 400 || !res.ok || !res.data) {
        throw new Error(res.data?.error ?? "quote() rejected");
      }
      nonceRef.current += 1;
      setQuoteAccepted(res.data.accepted);
      setQuoteReplaced(!!res.data.replaced);
      addLog(
        res.data.replaced
          ? `Quote signed and replaced your previous one — ${priceInput} USD / max ${maxFxrpInput} FXRP`
          : `Quote signed and sealed — ${priceInput} USD / max ${maxFxrpInput} FXRP`,
        { tone: "success" }
      );
      setNoMatchReasons(null);
      if (mountedRef.current) setS4Stage("done");
    } catch (err) {
      const msg = walletErrorMessage(err, "quote() failed");
      setS4Error(msg);
      addLog(msg, { tone: "error" });
      setS4Stage("idle");
    }
  }, [address, rfqData, priceInput, maxFxrpInput, addLog]);

  /* ------------------------------------------------------------------------
     S5 — match: trigger the enclave's matching pass
  ------------------------------------------------------------------------ */

  const runMatch = useCallback(async () => {
    if (!rfqData) return;
    setMatching(true);
    setMatchError(null);
    try {
      const res = await postJSON<MatchResponse>("/api/maker/match", { rfqId: rfqData.rfqId });
      if (res.status === 503 || res.data?.enabled === false) {
        setEnabled(false);
        return;
      }
      if (!res.ok || !res.data) {
        throw new Error(res.data?.error ?? "match() failed");
      }
      if (res.data.outcome === "NO_MATCH") {
        const reasons = formatReasons(res.data.reasons);
        setNoMatchReasons(reasons);
        setQuoteAccepted(false); // walk the judge back to S4 to re-quote — not treated as an error
        addLog(
          reasons.length
            ? `No match — the enclave declined: ${reasons.join(", ")}. Re-quote to try again.`
            : "No match — re-quote to try again.",
          { tone: "muted" }
        );
        return;
      }
      setMatchId(res.data.matchId ?? null);
      setXrpDrops(res.data.xrpDrops ?? null);
      setDestinationTag(res.data.destinationTag ?? null);
      setXrplDestination(res.data.xrplDestination ?? null);
      setPaymentDeadlineMs(res.data.paymentDeadline ? Number(res.data.paymentDeadline) * 1000 : null);
      addLog(
        `Matched — send ${formatXrp(res.data.xrpDrops)} to ${shortHash(res.data.xrplDestination ?? "")} (tag ${res.data.destinationTag})`,
        { tone: "success" }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "match() failed";
      setMatchError(msg);
      addLog(msg, { tone: "error" });
    } finally {
      if (mountedRef.current) setMatching(false);
    }
  }, [rfqData, addLog]);

  /* ------------------------------------------------------------------------
     S6 — pay the XRP leg: auto (throwaway account) or manual (pay yourself)
  ------------------------------------------------------------------------ */

  /// Polls until the payment lands, the ON-CHAIN payment window closes, or the cap is hit.
  ///
  /// The deadline check is the important one. DvPEscrow rejects any payment whose ledger timestamp
  /// is past `paymentDeadline` (`PaymentOutsideWindow`), so once that moment passes a payment can
  /// never be released. Polling on regardless — which is what this did before — quietly invites the
  /// maker to send XRP that is already worthless.
  const pollPaymentStatus = useCallback(
    async (id: string, deadlineMs: number | null): Promise<PollOutcome> => {
      const start = Date.now();
      while (Date.now() - start < PAYMENT_CAP_MS) {
        if (!mountedRef.current) return { status: "timeout" };
        if (deadlineMs !== null && Date.now() >= deadlineMs) return { status: "expired" };
        const res = await getJSON<PaymentStatusResponse>(`/api/maker/payment-status?matchId=${encodeURIComponent(id)}`);
        if (!res.ok || !res.data) {
          throw new Error(res.data?.error ?? "payment check failed");
        }
        if (res.data.paid) return { status: "paid", tx: res.data.xrplTx ?? null };
        await sleep(PAYMENT_POLL_MS);
      }
      return { status: "timeout" };
    },
    []
  );

  const runManualPay = useCallback(async () => {
    if (!matchId) return;
    setPayMethod("manual");
    setS6Stage("polling");
    setS6Error(null);
    try {
      const outcome = await pollPaymentStatus(matchId, paymentDeadlineMs);
      if (outcome.status === "expired") {
        // Deliberately not an s6Error: there is nothing to retry, the match is over. The expired
        // panel explains what happens next instead of offering a button that cannot work.
        addLog("Payment window closed before your XRP arrived — this match now takes the default path", {
          tone: "error",
        });
        if (mountedRef.current) setS6Stage("idle");
        return;
      }
      if (outcome.status !== "paid" || !outcome.tx) {
        throw new Error("payment not detected — check the address, drops, and tag");
      }
      const tx = outcome.tx;
      setPayXrplTx(tx);
      addLog("Your XRPL payment was detected", { href: XRPL_TX(tx), linkText: shortHash(tx), tone: "success" });
      if (mountedRef.current) setS6Stage("done");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "payment check failed";
      setS6Error(msg);
      addLog(msg, { tone: "error" });
      setS6Stage("idle");
    }
  }, [matchId, paymentDeadlineMs, addLog, pollPaymentStatus]);

  const runAutoPay = useCallback(async () => {
    if (!matchId) return;
    setPayMethod("auto");
    setS6Stage("funding");
    setS6Error(null);
    try {
      const acctRes = await postJSON<XrplAccountResponse>("/api/maker/xrpl-account", {});
      if (acctRes.status === 503 || acctRes.data?.enabled === false) {
        setEnabled(false);
        setS6Stage("idle");
        return;
      }
      if (!acctRes.ok || !acctRes.data) {
        throw new Error(acctRes.data?.error ?? "could not fund a throwaway XRPL account");
      }
      setPayXrplAddress(acctRes.data.address);
      setPayXrplSeed(acctRes.data.seed);
      addLog(`Funded a throwaway XRPL account — ${shortHash(acctRes.data.address)}`, {
        href: XRPL_ACCOUNT(acctRes.data.address),
        linkText: "view on testnet.xrpl.org",
      });

      setS6Stage("paying");
      setPayPill({ token: "XRP" });
      const payRes = await postJSON<PayResponse>("/api/maker/pay", { matchId });
      setPayPill(null);
      if (payRes.status === 503 || payRes.data?.enabled === false) {
        setEnabled(false);
        setS6Stage("idle");
        return;
      }
      if (!payRes.ok || !payRes.data) {
        throw new Error(payRes.data?.error ?? "XRPL payment failed");
      }
      setPayXrplTx(payRes.data.xrplTx);
      addLog("XRPL payment sent from your throwaway account", {
        href: XRPL_TX(payRes.data.xrplTx),
        linkText: shortHash(payRes.data.xrplTx),
        tone: "success",
      });
      if (mountedRef.current) setS6Stage("done");
    } catch (err) {
      setPayPill(null);
      const msg = err instanceof Error ? err.message : "XRPL payment failed";
      setS6Error(msg);
      addLog(msg, { tone: "error" });
      setS6Stage("idle");
    }
  }, [matchId, addLog]);

  /* ------------------------------------------------------------------------
     S7 — settle: attest -> poll proof -> release -> poll final FXRP balance
     (reuses the exact /api/demo/proof + /api/maker/release orchestration
     WalletMode.tsx uses)
  ------------------------------------------------------------------------ */

  const pollProof = useCallback(async (roundId: string, requestHex: string) => {
    const start = Date.now();
    while (Date.now() - start < PROOF_CAP_MS) {
      if (!mountedRef.current) return null;
      const res = await getJSON<ProofResponse>(
        `/api/demo/proof?roundId=${encodeURIComponent(roundId)}&requestHex=${encodeURIComponent(requestHex)}`
      );
      if (!res.ok || !res.data) {
        throw new Error(res.data?.error ?? "proof check failed");
      }
      if (res.data.ready) return res.data.proof;
      await sleep(PROOF_POLL_MS);
    }
    return null;
  }, []);

  const pollFinalFxrp = useCallback(async (addr: string, before: string) => {
    const start = Date.now();
    const beforeNum = toNum(before);
    let last = before;
    while (Date.now() - start < FXRP_BALANCE_CAP_MS) {
      if (!mountedRef.current) return last;
      const res = await getJSON<StatusResponse>(`/api/maker/status?maker=${encodeURIComponent(addr)}`);
      if (res.ok && res.data) {
        last = res.data.fxrp;
        if (toNum(last) > beforeNum) return last;
      }
      await sleep(FXRP_BALANCE_POLL_MS);
    }
    return last;
  }, []);

  const runBalance = useCallback(async () => {
    if (!address) return;
    setS7Stage("balance");
    const finalBal = await pollFinalFxrp(address, fxrp);
    if (mountedRef.current) setFinalFxrp(finalBal);
    addLog("FXRP landed in your wallet — settled.", { tone: "success" });
    if (mountedRef.current) setS7Stage("done");
  }, [address, fxrp, addLog, pollFinalFxrp]);

  const runRelease = useCallback(async (proof: unknown) => {
    if (!matchId) return;
    setS7Stage("releasing");
    setS7Error(null);
    try {
      const res = await postJSON<ReleaseResponse>("/api/maker/release", { matchId, proof });
      if (!res.ok || !res.data) {
        throw new Error(res.data?.error ?? "release() failed");
      }
      setReleaseTx(res.data.releaseTx);
      addLog("release() confirmed — FXRP settled to you", {
        href: COSTON2_TX(res.data.releaseTx),
        linkText: shortHash(res.data.releaseTx),
        tone: "success",
      });
      await runBalance();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "release() failed";
      setS7Error(msg);
      addLog(msg, { tone: "error" });
    }
  }, [matchId, addLog, runBalance]);

  const runProve = useCallback(async (roundId: string, requestHex: string) => {
    setS7Stage("proving");
    setS7Error(null);
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
      setS7Error(msg);
      addLog(msg, { tone: "error" });
    }
  }, [addLog, pollProof, runRelease]);

  const runSettle = useCallback(async () => {
    if (!matchId) return;
    setS7Stage("settling");
    setS7Error(null);
    try {
      const res = await postJSON<SettleResponse>("/api/maker/settle", { matchId });
      if (res.status === 503 || res.data?.enabled === false) {
        setEnabled(false);
        setS7Stage("idle");
        return;
      }
      if (!res.ok || !res.data) {
        throw new Error(res.data?.error ?? "settle() failed");
      }
      addLog(`FDC round ${res.data.roundId} — waiting for finality`, { tone: "muted" });
      setAttestRound({ roundId: res.data.roundId, requestHex: res.data.requestHex });
      await runProve(res.data.roundId, res.data.requestHex);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "settle() failed";
      setS7Error(msg);
      addLog(msg, { tone: "error" });
    }
  }, [matchId, addLog, runProve]);

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
        <p className="mono-label text-[0.68rem] text-ink-3 mb-3">Be the maker</p>
        <h3 className="font-display font-semibold text-[1.3rem] text-ink mb-3">No wallet detected.</h3>
        <p className="max-w-[54ch] text-[0.95rem] leading-[1.65] text-ink-2 mb-6">
          This mode needs a browser wallet — you&apos;ll sign a sealed EIP-712 quote and post a bond
          from Coston2, then pay the XRP leg of a trade you never fully see. No wallet in this
          browser? A real settlement is still one click away.
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
        <p className="mono-label text-[0.68rem] text-ink-3 mb-3">Be the maker</p>
        <h3 className="font-display font-semibold text-[1.3rem] text-ink mb-3">Maker mode is sleeping.</h3>
        <p className="max-w-[54ch] text-[0.95rem] leading-[1.65] text-ink-2 mb-6">
          The maker-mode backend isn&apos;t running right now.
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

  const band = ftsoMid18 !== null ? bandOf(ftsoMid18) : null;
  const rfqExpired = rfqRemainingSeconds !== null && rfqRemainingSeconds <= 0 && s3Stage !== "done";

  return (
    <div className="mt-6 space-y-6">
      {/* diagram — same visual vocabulary as WalletMode, roles mirrored */}
      <div className="overflow-x-auto">
        <div className="min-w-[480px] sm:min-w-0 px-2 pt-4 pb-2">
          <div className="flex items-center gap-2 sm:gap-5">
            <PartyCard sub="Maker" label="You">
              <BalanceRow token="FXRP" value={toNum(fxrp)} />
            </PartyCard>
            <Rail key={`bond-${pillTick}`} pill={bondPill} />
            <PartyCard sub="Escrow" label="WhisperDesk Vault">
              <p className="mono-data text-[0.78rem] text-ink-3">
                {matchId ? shortHash(matchId) : rfqData ? shortHash(rfqData.rfqId) : "—"}
              </p>
            </PartyCard>
          </div>
          <div className="mt-8 sm:mt-10 flex items-center gap-3 px-1">
            <span className="mono-label text-[0.56rem] text-ink-3 shrink-0">You</span>
            <Rail key={`pay-${pillTick}`} pill={payPill} dashed />
            <span className="mono-label text-[0.56rem] text-ink-3 shrink-0">XRP Ledger — direct payment</span>
            <Rail pill={null} dashed />
            <span className="mono-label text-[0.56rem] text-ink-3 shrink-0">Taker (desk)</span>
          </div>
        </div>
      </div>

      {/* S1 */}
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
            <p className="mono-data text-[0.85rem] text-ink">
              <span className="text-ink-3">Free bond </span>
              {freeBond}
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
      <StepShell n={2} title="Get demo FXRP for the bond" done={faucetDone} active={currentStep >= 2}>
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
      <StepShell n={3} title="Open an RFQ to quote against" done={s3Stage === "done"} active={currentStep >= 3}>
        {s3Stage !== "done" ? (
          <div className="space-y-4">
            {rfqData && (
              <div className="space-y-2 border border-steel-line bg-vault-2 px-4 py-3.5">
                <p className="mono-data text-[0.85rem] text-ink">
                  <span className="text-ink-3">rfqId </span>
                  {shortHash(rfqData.rfqId)}
                </p>
                <p className="mono-data text-[0.85rem] text-ice">
                  Window closes in {fmtCountdown(rfqRemainingSeconds)}
                </p>
                <p className="text-[0.82rem] leading-[1.6] text-ink-2 max-w-[58ch]">
                  This RFQ&apos;s side, size, and limit price live inside the enclave only — sealed,
                  encrypted, never written to a database or a log. You are not seeing a redacted
                  version; there is nothing here to redact. You quote blind, exactly like a real
                  counterparty would.
                </p>
              </div>
            )}
            <button
              type="button"
              onClick={
                s3Stage === "idle"
                  ? runOpenRfq
                  : s3Stage === "approve"
                    ? () => runApprove(rfqData!)
                    : s3Stage === "depositBond"
                      ? () => runDepositBond(rfqData!)
                      : undefined
              }
              disabled={currentStep < 3 || (s3Stage !== "idle" && !s3Error)}
              className="mono-label text-[0.68rem] px-5 py-2.5 border border-ice/50 text-ice hover:bg-ice/10 transition-colors duration-300 disabled:opacity-30 disabled:pointer-events-none"
            >
              {s3Stage === "idle"
                ? s3Error
                  ? "Retry open-rfq()"
                  : "Open a sealed RFQ"
                : s3Stage === "opening"
                  ? "Sealing RFQ…"
                  : s3Stage === "approve"
                    ? s3Error
                      ? "Retry approve()"
                      : "Confirm approve in wallet…"
                    : s3Error
                      ? "Retry depositBond()"
                      : "Confirm depositBond in wallet…"}
            </button>
            {rfqBusy && (
              <p className="mono-label text-[0.64rem] text-iron-red">
                Another maker-mode run is in progress — try again in a few minutes.
              </p>
            )}
            {s3Error && <p className="mono-label text-[0.64rem] text-iron-red">{s3Error}</p>}
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="mono-data text-[0.85rem] text-ink">
              <span className="text-ink-3">rfqId </span>
              {rfqData ? shortHash(rfqData.rfqId) : "—"}
            </p>
            <p className="mono-data text-[0.85rem] text-ink">
              <span className="text-ink-3">Bond posted </span>
              {rfqData?.bondAmount} FXRP
              {bondTx && (
                <>
                  {" — "}
                  <a href={COSTON2_TX(bondTx)} target="_blank" rel="noopener noreferrer" className="text-ice hover:underline">
                    {shortHash(bondTx)}
                  </a>
                </>
              )}
            </p>
          </div>
        )}
      </StepShell>

      {/* S4 */}
      <StepShell n={4} title="Quote it" done={quoteAccepted} active={currentStep >= 4}>
        {noMatchReasons && (
          <div className="mb-4 border border-steel-line-2 bg-vault-2 px-4 py-3">
            <p className="mono-label text-[0.6rem] text-ink-3 mb-1.5">No match — not an error, re-quote below</p>
            <ul className="space-y-1">
              {noMatchReasons.length === 0 ? (
                <li className="mono-data text-[0.82rem] text-ink-2">no reason given</li>
              ) : (
                noMatchReasons.map((r) => (
                  <li key={r} className="mono-data text-[0.82rem] text-ink-2">
                    {r}
                  </li>
                ))
              )}
            </ul>
          </div>
        )}
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <p className="mono-label text-[0.6rem] text-ink-3">
              Live FTSOv2 XRP/USD mid {ftsoBusy ? "…" : fmtUsdMid(ftsoMid18)}
            </p>
            <button
              type="button"
              onClick={refreshFtsoMid}
              disabled={ftsoBusy || currentStep < 4}
              className="mono-label text-[0.56rem] text-ice hover:underline disabled:opacity-30 disabled:pointer-events-none"
            >
              refresh
            </button>
          </div>
          {ftsoError && <p className="mono-label text-[0.6rem] text-iron-red">{ftsoError}</p>}
          {band && (
            <p className="mono-label text-[0.56rem] text-ink-3">
              ±1% band the enclave will accept: {fmtUsdMid(band.lower)} – {fmtUsdMid(band.upper)} USD
              — quote outside it on purpose to watch the enclave decline the match.
            </p>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="mono-label text-[0.56rem] text-ink-3">Your price (USD)</span>
              <input
                type="text"
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
                disabled={currentStep < 4}
                className="mono-data text-[0.82rem] bg-vault-2 border border-steel-line px-3 py-2 text-ink w-[160px] disabled:opacity-40"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="mono-label text-[0.56rem] text-ink-3">Max FXRP you&apos;ll fill</span>
              <input
                type="text"
                value={maxFxrpInput}
                onChange={(e) => setMaxFxrpInput(e.target.value)}
                disabled={currentStep < 4}
                className="mono-data text-[0.82rem] bg-vault-2 border border-steel-line px-3 py-2 text-ink w-[160px] disabled:opacity-40"
              />
            </label>
            <button
              type="button"
              onClick={runQuote}
              disabled={currentStep < 4 || !priceInput || (s4Stage !== "idle" && s4Stage !== "done" && !s4Error)}
              className="mono-label text-[0.68rem] px-5 py-2.5 border border-ice/50 text-ice hover:bg-ice/10 transition-colors duration-300 disabled:opacity-30 disabled:pointer-events-none"
            >
              {s4Stage === "signing"
                ? "Sign in wallet…"
                : s4Stage === "submitting"
                  ? "Submitting…"
                  : quoteAccepted
                    ? "Re-quote"
                    : "Sign + submit quote"}
            </button>
          </div>
          {quoteAccepted && (
            <p className="mono-data text-[0.8rem] text-ice">
              Quote {quoteReplaced ? "replaced" : "accepted"} — sealed and submitted.
            </p>
          )}
          {s4Error && <p className="mono-label text-[0.64rem] text-iron-red">{s4Error}</p>}
        </div>
      </StepShell>

      {/* S5 */}
      <StepShell n={5} title="Match" done={!!matchId} active={currentStep >= 5}>
        {!matchId ? (
          <div className="space-y-3">
            <button
              type="button"
              onClick={runMatch}
              disabled={currentStep < 5 || matching}
              className="mono-label text-[0.68rem] px-5 py-2.5 border border-ice/50 text-ice hover:bg-ice/10 transition-colors duration-300 disabled:opacity-30 disabled:pointer-events-none"
            >
              {matching ? "Asking the enclave to match…" : "Trigger matching"}
            </button>
            {matchError && <p className="mono-label text-[0.64rem] text-iron-red">{matchError}</p>}
          </div>
        ) : (
          <p className="mono-data text-[0.85rem] text-ice">
            Matched — matchId {shortHash(matchId)}
          </p>
        )}
      </StepShell>

      {/* S6 */}
      <StepShell n={6} title="Pay the XRP leg" done={s6Stage === "done"} active={currentStep >= 6}>
        {currentStep >= 6 && s6Stage !== "done" && (
          <div className="space-y-4">
            <div className="space-y-1.5 border border-steel-line bg-vault-2 px-4 py-3.5">
              <p className="mono-data text-[0.85rem] text-ink break-all">
                <span className="text-ink-3">Send exactly </span>
                {formatXrp(xrpDrops ?? undefined)}
              </p>
              <p className="mono-data text-[0.85rem] text-ink break-all">
                <span className="text-ink-3">To </span>
                {xrplDestination}
              </p>
              <p className="mono-data text-[0.85rem] text-ink">
                <span className="text-ink-3">Destination tag </span>
                {destinationTag}
              </p>
              {paymentExpired ? (
                <p className="mono-data text-[0.82rem] text-iron-red">Payment window closed</p>
              ) : (
                <p className="mono-data text-[0.82rem] text-ice">
                  Pay before {fmtCountdown(paymentRemainingSeconds)} remaining
                </p>
              )}
            </div>

            {/* Once the window has closed there is nothing left to do here, so no pay buttons, no
                polling, and no retry — sending XRP now would be refused by the escrow. Say what
                happened instead, including the part that costs the maker money. */}
            {paymentExpired ? (
              <div className="space-y-2 border border-iron-red/40 px-4 py-3.5">
                <p className="mono-label text-[0.64rem] text-iron-red">
                  The XRP never arrived in time, so this match takes the default path.
                </p>
                <p className="mono-label text-[0.58rem] text-ink-3 leading-relaxed">
                  The escrow refuses any payment stamped after the deadline, so do not send it now —
                  it could not be released. The taker&apos;s FXRP is refunded and your bond is slashed
                  to compensate them. That is the protection working exactly as designed; it is the
                  same default path the one-click demo can show on purpose.
                </p>
                <button
                  type="button"
                  onClick={onSwitchToOneClick}
                  className="mono-label text-[0.62rem] px-4 py-2 border border-steel-line-2 text-ink-2 hover:text-ink hover:border-ice-deep/60 transition-colors duration-300"
                >
                  See a settlement that completes
                </button>
              </div>
            ) : (
              payMethod === null && (
                <div className="flex flex-wrap items-center gap-3">
                  {/* Funding a throwaway account leads: it pays within seconds, where paying by hand
                      means opening a wallet and copying an address and a tag against a window that
                      is only PAYMENT_WINDOW seconds wide (180s on the deployed escrow). */}
                  <button
                    type="button"
                    onClick={runAutoPay}
                    className="mono-label text-[0.68rem] px-5 py-2.5 border border-ice/50 text-ice hover:bg-ice/10 transition-colors duration-300"
                  >
                    Fund a throwaway XRPL account for me
                  </button>
                  <button
                    type="button"
                    onClick={runManualPay}
                    className="mono-label text-[0.64rem] px-4 py-2.5 border border-steel-line-2 text-ink-2 hover:text-ink hover:border-ice-deep/60 transition-colors duration-300"
                  >
                    I&apos;ll pay it myself
                  </button>
                  <span className="mono-label text-[0.56rem] text-ink-3 basis-full">
                    Paying it yourself only works if a funded XRPL testnet wallet is already open —
                    the window above is the real on-chain deadline, not a UI timer.
                  </span>
                </div>
              )
            )}
            {payMethod === "manual" && !paymentExpired && (
              <p className="mono-label text-[0.64rem] text-ink-3 flex items-center gap-2">
                <span className="ice-dot" />
                Checking testnet.xrpl.org for your payment…
              </p>
            )}
            {payMethod === "auto" && !paymentExpired && (
              <div className="space-y-1.5">
                {payXrplAddress && (
                  <p className="mono-data text-[0.8rem] text-ink break-all">
                    <span className="text-ink-3">Paying from </span>
                    {shortHash(payXrplAddress)}
                  </p>
                )}
                {payXrplSeed && (
                  <p className="mono-label text-[0.56rem] text-ink-3">
                    Throwaway testnet account — the seed is yours: {payXrplSeed}
                  </p>
                )}
                <p className="mono-label text-[0.64rem] text-ink-3">
                  {s6Stage === "funding" ? "Funding throwaway account…" : "Sending payment…"}
                </p>
              </div>
            )}
            {s6Error && !paymentExpired && (
              <div className="space-y-2">
                <p className="mono-label text-[0.64rem] text-iron-red">{s6Error}</p>
                <button
                  type="button"
                  onClick={payMethod === "auto" ? runAutoPay : runManualPay}
                  className="mono-label text-[0.62rem] px-4 py-2 border border-steel-line-2 text-ink-2 hover:text-ink hover:border-ice-deep/60 transition-colors duration-300"
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        )}
        {s6Stage === "done" && (
          <p className="mono-data text-[0.85rem] text-ink">
            <span className="text-ink-3">XRPL payment </span>
            {payXrplTx ? shortHash(payXrplTx) : "—"}
          </p>
        )}
      </StepShell>

      {/* S7 */}
      <StepShell n={7} title="Watch settlement" done={s7Stage === "done"} active={currentStep >= 7}>
        {s7Stage !== "done" ? (
          <div className="space-y-3">
            <button
              type="button"
              onClick={
                s7Stage === "idle"
                  ? runSettle
                  : s7Stage === "settling"
                    ? runSettle
                    : s7Stage === "proving"
                      ? () => runProve(attestRound!.roundId, attestRound!.requestHex)
                      : s7Stage === "releasing"
                        ? () => runRelease(proofData)
                        : undefined
              }
              disabled={currentStep < 7 || (s7Stage !== "idle" && !s7Error)}
              className="mono-label text-[0.68rem] px-5 py-2.5 border border-ice/50 text-ice hover:bg-ice/10 transition-colors duration-300 disabled:opacity-30 disabled:pointer-events-none"
            >
              {s7Stage === "idle" && !s7Error
                ? "Settle"
                : s7Stage === "settling"
                  ? s7Error
                    ? "Retry settle()"
                    : "Requesting FDC attestation…"
                  : s7Stage === "proving"
                    ? s7Error
                      ? "Retry proof check"
                      : "Waiting for proof…"
                    : s7Stage === "releasing"
                      ? s7Error
                        ? "Retry release()"
                        : "Releasing…"
                      : "Checking your FXRP balance…"}
            </button>
            {s7Error && <p className="mono-label text-[0.64rem] text-iron-red">{s7Error}</p>}
          </div>
        ) : (
          <p className="mono-data text-[0.85rem] text-ice">
            Final FXRP balance {finalFxrp ?? "—"} — settled.
          </p>
        )}
      </StepShell>

      {rfqExpired && (
        <div className="panel px-6 py-5">
          <p className="mono-label text-[0.64rem] text-iron-red mb-3">RFQ window expired.</p>
          <button
            type="button"
            onClick={runOpenRfq}
            className="mono-label text-[0.64rem] px-4 py-2 border border-steel-line-2 text-ink-2 hover:text-ink hover:border-ice-deep/60 transition-colors duration-300"
          >
            Open a new RFQ
          </button>
        </div>
      )}

      {/* console log */}
      <div className="panel px-6 py-6 sm:px-8 sm:py-7">
        <p className="mono-label text-[0.6rem] text-ink-3 mb-3">Console</p>
        <p className="mono-label text-[0.56rem] text-ink-3 mb-4 leading-relaxed">
          Real transactions · testnet only · you sign a sealed EIP-712 quote and your bond deposit
          with your own wallet — the desk seals + submits the counterparty RFQ, matches inside the
          enclave, and relays attest + release.
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
   StepShell — numbered panel wrapper shared by all seven steps. Duplicated
   from WalletMode.tsx (not exported there).
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
