// POST /api/demo/lock — funds the taker deposit + maker bond and calls DvPEscrow.lock() on
// Coston2. See src/lib/demo/flow.ts (fundAndLock) for the ported e2e logic and its one deliberate
// deviation (lock() is submitted by the taker wallet, not the owner).
import { NextResponse } from "next/server";
import { getDemoEnv } from "@/lib/demo/env";
import { fundAndLock, setupClients } from "@/lib/demo/flow";
import { errMessage } from "@/lib/demo/http";
import { attachMatchId, releaseRunLock, tryAcquireRunLock } from "@/lib/demo/state";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getDemoEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
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
