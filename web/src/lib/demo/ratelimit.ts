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

export type RateLimitKind = "demo-lock";

interface Limits {
  perIp: number;
  global: number;
}

const LIMITS: Record<RateLimitKind, Limits> = {
  "demo-lock": { perIp: 3, global: 20 },
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
