// POST /api/maker/match — triggers matching for a maker-mode RFQ (waiting out the auction window
// first, if this server itself opened it), then locks the enclave-signed MatchInstruction on-chain.
// Returns exactly what the maker must pay on XRPL.
import { NextResponse } from "next/server";
import { errMessage } from "@/lib/demo/http";
import { triggerMatchAndLock } from "@/lib/demo/maker";
import { getMakerEnv } from "@/lib/demo/makerEnv";
import { checkAndConsume, clientIpFromHeaders } from "@/lib/demo/ratelimit";
import { releaseRunLock } from "@/lib/demo/state";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getMakerEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  const ip = clientIpFromHeaders(request.headers);
  const limit = checkAndConsume("maker-match", ip);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "maker-mode rate limit hit for this deployment — try again later", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429 }
    );
  }

  let rfqId: string;
  try {
    const body = await request.json();
    if (typeof body?.rfqId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.rfqId)) {
      return NextResponse.json({ error: "body.rfqId must be a 0x-hex 32-byte string" }, { status: 400 });
    }
    rfqId = body.rfqId;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const outcome = await triggerMatchAndLock(env, rfqId);
    if (outcome.outcome === "NO_MATCH") {
      return NextResponse.json({ outcome: "NO_MATCH", reasons: outcome.reasons ?? {} });
    }
    return NextResponse.json({
      outcome: "MATCHED",
      matchId: outcome.matchId,
      xrpDrops: outcome.xrpDrops,
      destinationTag: String(outcome.destinationTag),
      xrplDestination: outcome.xrplDestination,
      paymentDeadline: String(outcome.paymentDeadline),
    });
  } catch (err) {
    // A failed match ends the run — release the lock open-rfq took, or the next visitor is blocked
    // for the full TTL by a run that can no longer continue. NO_MATCH deliberately does NOT release:
    // the maker can re-quote against the same RFQ, so that run is still alive.
    releaseRunLock();
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
