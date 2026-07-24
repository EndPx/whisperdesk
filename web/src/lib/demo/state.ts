// state.ts — best-effort in-memory run lock for the demo console, so a second concurrent
// POST /api/demo/lock while a run is in flight gets a clean 409 {busy:true} instead of two judges'
// runs interleaving confusingly on screen.
//
// This is a UX nicety, not a safety boundary: funds stay safe regardless of whether this lock is
// bypassed (e.g. by a server restart clearing it, or a race between two requests) — DvPEscrow
// enforces every settlement rule on-chain (signature check, FTSOv2 band, one-time destinationTag,
// FDC proof-owner binding, refund grace window, ...). A tampered or duplicated client payload can
// only ever cause a revert, never an unsafe transfer.
//
// Module-level singleton: persists for the life of this server process. A dev-server hot reload or
// a serverless cold start resets it, which is acceptable for a demo console.
const RUN_LOCK_TTL_MS = 10 * 60 * 1000;

interface RunLock {
  path: "happy" | "default";
  matchId?: string;
  startedAt: number;
}

let currentRun: RunLock | null = null;

/// Returns true and acquires the lock if no run is in flight (or the previous one is older than
/// the TTL, treated as abandoned). Returns false if a run is already active.
export function tryAcquireRunLock(path: "happy" | "default"): boolean {
  const now = Date.now();
  if (currentRun && now - currentRun.startedAt < RUN_LOCK_TTL_MS) {
    return false;
  }
  currentRun = { path, startedAt: now };
  return true;
}

export function attachMatchId(matchId: string): void {
  if (currentRun) currentRun.matchId = matchId;
}

/// Clears the run lock, freeing the console for the next run. Called both when /lock itself fails
/// (so a failed attempt doesn't block the next try for the full TTL) and when a run concludes
/// (release() or refund() succeeds).
export function releaseRunLock(): void {
  currentRun = null;
}

export function getCurrentRun(): Readonly<RunLock> | null {
  return currentRun;
}
