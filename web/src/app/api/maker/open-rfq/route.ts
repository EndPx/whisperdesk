// POST /api/maker/open-rfq — the desk acts as TAKER: funds + deposits the taker side, seals an RFQ
// (limit struck 3% below the live FTSOv2 mid — see maker.ts), submits it onchain via
// WhisperDeskInstructionSender.submitRfq, and returns the rfqId the maker must quote against. The
// maker never sees the RFQ's side/size/limit — those stay inside the sealed ciphertext end to end.
//
// Shares state.ts's single run lock with /api/demo/lock and /api/wallet/prepare (see state.ts's
// updated doc comment) — a maker-mode run can't overlap a one-click or wallet-mode run, since all
// three touch the same desk keys / escrow destinationTag counter.
import { NextResponse } from "next/server";
import { errMessage } from "@/lib/demo/http";
import { buildOpenRfq } from "@/lib/demo/maker";
import { getMakerEnv } from "@/lib/demo/makerEnv";
import { checkAndConsume, clientIpFromHeaders } from "@/lib/demo/ratelimit";
import { releaseRunLock, tryAcquireRunLock } from "@/lib/demo/state";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getMakerEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  const ip = clientIpFromHeaders(request.headers);
  const limit = checkAndConsume("maker-open-rfq", ip);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "maker-mode rate limit hit for this deployment — try again later", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    // `maker` isn't needed to open the RFQ itself (the desk is always the taker here) — validated
    // for shape only, per the fixed API contract's body {maker}.
    if (typeof body?.maker !== "string" || !body.maker) {
      return NextResponse.json({ error: "body.maker (string) is required" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!tryAcquireRunLock("maker")) {
    return NextResponse.json({ busy: true }, { status: 409 });
  }

  try {
    const result = await buildOpenRfq(env);
    return NextResponse.json(result);
  } catch (err) {
    releaseRunLock();
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
