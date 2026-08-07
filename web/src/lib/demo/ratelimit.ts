// ratelimit.ts — in-memory, process-local abuse guard for the public one-click demo entry point
// (POST /api/demo/lock). The one-click path spends the DESK's own testnet keys server-side; on a
// public URL that's an unauthenticated spend, so this caps how many times a single IP (and the
// whole deployment) can kick one off per rolling 24h.
//
// NOT a security boundary — a demo guard only:
//   - Module-level Map, so it resets on every redeploy / cold start / dev-server hot reload.
//   - Does not span multiple server instances (no shared store) — a multi-instance deployment
//     gets one independent limiter per instance, not one true global limit.
//   - Keyed by a client-supplied header (x-forwarded-for / x-real-ip), which is trivially
//     spoofable by anyone not sitting behind a trusted reverse proxy that overwrites it.
//   - Funds safety does NOT depend on this file: DvPEscrow enforces every settlement rule
//     on-chain regardless of how many (or few) lock() calls this limiter lets through. This exists
//     purely so the desk doesn't get drained / the demo doesn't go quiet during judging.
const WINDOW_MS = 24 * 60 * 60 * 1000;

export type RateLimitKind =
  | "demo-lock"
  | "demo-attest"
  | "demo-pay"
  | "maker-faucet"
  | "maker-open-rfq"
  | "maker-join-rfq"
  | "taker-open-rfq"
  | "maker-quote"
  | "maker-match"
  | "maker-settle"
  | "maker-xrpl-account"
  | "maker-pay";

interface Limits {
  perIp: number;
  global: number;
}

// Distinct kind per route so one route's budget can't starve another (e.g. a burst of
// lock() calls exhausting global headroom shouldn't also block attest()/pay() for a run
// that's already past lock()). A legitimate one-click run consumes exactly one unit of
// each kind, so these are sized well above one but far below what a drain loop needs to
// do real damage: demo-attest spends real Coston2 gas + an FDC request fee from the owner
// key; demo-pay sends real testnet XRP from the maker seed.
const LIMITS: Record<RateLimitKind, Limits> = {
  "demo-lock": { perIp: 3, global: 20 },
  "demo-attest": { perIp: 5, global: 30 },
  "demo-pay": { perIp: 5, global: 30 },
  // join-rfq spends no funds at all — it only reads escrow constants for an RFQ that already
  // exists — so it is the one maker route that can afford a generous budget. It still needs one,
  // because the queue polls and a second maker will hit it repeatedly while deciding.
  "maker-join-rfq": { perIp: 30, global: 200 },
  // A taker publishing their own RFQ spends the enclave's attention and a queue slot, but no desk
  // funds — the judge's own wallet pays the relay fee and posts the deposit. Tighter than join,
  // looser than open-rfq, which spends the desk's taker deposit every call.
  "taker-open-rfq": { perIp: 5, global: 40 },
  // Maker mode (api/maker/*) — same reasoning, own budgets so a maker-mode abuse loop can't starve
  // (or be starved by) the one-click/wallet-mode budgets above. open-rfq spends the desk's own
  // taker-funded deposit + a relay fee; match spends a relay fee + the FTSOv2 fee on lock(); settle
  // spends real Coston2 gas + an FDC request fee (same shape as demo-attest); faucet mints from the
  // owner key (also has its own per-address 10-min limiter, see wallet-mode.ts's
  // checkAndRecordFaucetClaim — this IP budget is an additional abuse guard, not a replacement);
  // xrpl-account calls the external XRPL testnet faucet, not the desk's own funds, but is still
  // metered to avoid hammering that shared external resource.
  "maker-faucet": { perIp: 5, global: 30 },
  "maker-open-rfq": { perIp: 3, global: 20 },
  // quote spawns a wd-client child process for EVERY call (encrypt + a POST /direct submit gated
  // by the shared DIRECT_API_KEY) and, unlike open-rfq/match, is reachable without ever holding
  // the run lock — an unauthenticated caller replaying a valid {rfqId, sig} could otherwise spawn
  // unbounded child processes / hammer the tee-proxy's API-key budget in a tight loop. Sized a bit
  // above open-rfq's since re-quoting mid-window is an expected, legitimate part of the flow.
  "maker-quote": { perIp: 8, global: 40 },
  "maker-match": { perIp: 5, global: 30 },
  "maker-settle": { perIp: 5, global: 30 },
  "maker-xrpl-account": { perIp: 5, global: 30 },
  // pay only spends the maker's own throwaway XRPL account (funded via maker-xrpl-account, which
  // has its own budget), never desk funds — but it still submits real XRPL transactions from this
  // server's infra, so it gets a budget too rather than being left uncapped.
  "maker-pay": { perIp: 5, global: 30 },
};

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number; scope: "ip" | "global" };

// kind -> ip -> timestamps (ms) of consumed hits still inside the rolling window.
const ipHits = new Map<RateLimitKind, Map<string, number[]>>();
// kind -> timestamps (ms) of every consumed hit globally, still inside the rolling window.
const globalHits = new Map<RateLimitKind, number[]>();

function pruneOld(timestamps: number[], now: number): number[] {
  return timestamps.filter((t) => now - t < WINDOW_MS);
}

function retryAfterFrom(timestamps: number[], now: number): number {
  if (timestamps.length === 0) return 0;
  const oldest = Math.min(...timestamps);
  return Math.max(0, Math.ceil((oldest + WINDOW_MS - now) / 1000));
}

/// Extracts the client IP for rate-limit keying: first hop of x-forwarded-for, falling back to
/// x-real-ip, falling back to "unknown" (which just means every un-proxied/unknown-IP caller
/// shares one bucket — acceptable for a demo guard, not a security property).
export function clientIpFromHeaders(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

/// Checks both the per-IP and global rolling-24h caps for `kind` and, if both currently have
/// headroom, atomically consumes one unit from each. Returns {ok:false, retryAfterSeconds, scope}
/// naming whichever cap is blocking (global checked after ip; ip reported first since it's the
/// more actionable/specific limit for that caller).
export function checkAndConsume(kind: RateLimitKind, ip: string): RateLimitResult {
  const now = Date.now();
  const limits = LIMITS[kind];

  if (!ipHits.has(kind)) ipHits.set(kind, new Map());
  const perKindIpHits = ipHits.get(kind)!;
  const ipTimestamps = pruneOld(perKindIpHits.get(ip) ?? [], now);

  const globalTimestamps = pruneOld(globalHits.get(kind) ?? [], now);

  if (ipTimestamps.length >= limits.perIp) {
    perKindIpHits.set(ip, ipTimestamps);
    return { ok: false, retryAfterSeconds: retryAfterFrom(ipTimestamps, now), scope: "ip" };
  }
  if (globalTimestamps.length >= limits.global) {
    globalHits.set(kind, globalTimestamps);
    return { ok: false, retryAfterSeconds: retryAfterFrom(globalTimestamps, now), scope: "global" };
  }

  ipTimestamps.push(now);
  perKindIpHits.set(ip, ipTimestamps);
  globalTimestamps.push(now);
  globalHits.set(kind, globalTimestamps);

  return { ok: true };
}
