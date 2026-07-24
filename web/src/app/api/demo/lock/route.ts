// POST /api/demo/lock — funds the taker deposit + maker bond and calls DvPEscrow.lock() on
// Coston2. See src/lib/demo/flow.ts (fundAndLock) for the ported e2e logic and its one deliberate
// deviation (lock() is submitted by the taker wallet, not the owner).
import { NextResponse } from "next/server";
import { getDemoEnv } from "@/lib/demo/env";
import { fundAndLock, setupClients } from "@/lib/demo/flow";
import { errMessage } from "@/lib/demo/http";
import { checkAndConsume, clientIpFromHeaders } from "@/lib/demo/ratelimit";
import { attachMatchId, releaseRunLock, tryAcquireRunLock } from "@/lib/demo/state";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getDemoEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  // Abuse guard — see ratelimit.ts. This is the one-click run's entry point and the only place
  // that spends the DESK's own testnet keys unauthenticated; the other one-click routes below it
  // (pay/attest/proof/release/refund) are continuations of an already-authorised run, and
  // /api/wallet/* spends the JUDGE's own funds so it stays unlimited (aside from its own faucet
  // limiter).
  const ip = clientIpFromHeaders(request.headers);
  const limit = checkAndConsume("demo-lock", ip);
  if (!limit.ok) {
    const scopeMsg =
      limit.scope === "ip"
        ? "You've hit the per-visitor limit for the shared one-click demo today."
        : "The shared one-click demo has hit its daily limit across all visitors.";
    return NextResponse.json(
      { error: `${scopeMsg} Try again later, or use "Be the taker" to run it with your own wallet.`, retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429 },
    );
  }

  let path: "happy" | "default";
  try {
    const body = await request.json();
    if (body?.path !== "happy" && body?.path !== "default") {
      return NextResponse.json({ error: 'body.path must be "happy" or "default"' }, { status: 400 });
    }
    path = body.path;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!tryAcquireRunLock(path)) {
    return NextResponse.json({ busy: true }, { status: 409 });
  }

  try {
    const clients = await setupClients(env);
    const result = await fundAndLock(clients, env);
    attachMatchId(result.matchId);

    return NextResponse.json({
      matchId: result.matchId,
      lockTx: result.lockTx,
      destinationTag: String(result.destinationTag),
      xrpDrops: result.xrpDrops.toString(),
      paymentDeadline: String(result.paymentDeadline),
      refundAfter: String(result.refundAfter),
    });
  } catch (err) {
    releaseRunLock();
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
