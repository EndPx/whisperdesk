// POST /api/maker/join-rfq — quote against an RFQ another maker already opened.
//
// The counterpart to /api/maker/open-rfq. That route seals a fresh RFQ and funds a desk taker
// deposit behind it, so calling it twice makes two unrelated orders rather than a contest. This one
// reuses an existing rfqId from the shared queue, which is how two independent wallets end up
// quoting ONE sealed RFQ and letting the enclave choose between them on price.
//
// It reveals nothing the queue did not already: the id, the deadline, and escrow constants. The
// side, size, limit and taker stay inside the enclave, and no rival count is returned.
import { NextResponse } from "next/server";
import { buildJoinRfq } from "@/lib/demo/maker";
import { getMakerEnv } from "@/lib/demo/makerEnv";
import { errMessage } from "@/lib/demo/http";
import { checkAndConsume, clientIpFromHeaders } from "@/lib/demo/ratelimit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getMakerEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  // Own budget: it reads several contract constants per call, and is cheap enough to invite
  // hammering from a poll loop in a way open-rfq never was.
  const ip = clientIpFromHeaders(request.headers);
  const limit = checkAndConsume("maker-join-rfq", ip);
  if (!limit.ok) {
    return NextResponse.json({ error: "rate limited — try again shortly" }, { status: 429 });
  }

  let rfqId: string;
  try {
    const body = await request.json();
    if (typeof body?.rfqId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.rfqId)) {
      return NextResponse.json({ error: "body.rfqId must be a 32-byte hex string" }, { status: 400 });
    }
    rfqId = body.rfqId;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    return NextResponse.json(await buildJoinRfq(env, rfqId));
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
