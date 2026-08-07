// POST /api/taker/rfq/prepare — the escrow parameters a taker funds before publishing.
//
// Funding comes first for a reason: an RFQ with no deposit behind it can be matched but never
// locked, because lock() reserves the FXRP from the taker's own armed balance. Arming it up front is
// what makes the published order real rather than a claim.
//
// Nothing order-shaped crosses this route. It returns the token, the escrow, and MIN_BLOCK_FXRP —
// the same three constants every RFQ on this desk uses — so a network observer learns that someone
// is about to trade, and nothing whatsoever about what.
import { NextResponse } from "next/server";
import { buildTakerRfqPrepare } from "@/lib/demo/maker";
import { getMakerEnv } from "@/lib/demo/makerEnv";
import { errMessage } from "@/lib/demo/http";
import { checkAndConsume, clientIpFromHeaders } from "@/lib/demo/ratelimit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getMakerEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  const ip = clientIpFromHeaders(request.headers);
  const limit = checkAndConsume("taker-open-rfq", ip);
  if (!limit.ok) {
    return NextResponse.json({ error: "rate limited — try again shortly" }, { status: 429 });
  }

  try {
    return NextResponse.json(await buildTakerRfqPrepare(env));
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
