// GET /api/maker/payment-status?matchId=.. — polls XRPL for a payment matching the exact
// drops+destinationTag recorded at match time, so a maker who paid MANUALLY (not via
// POST /api/maker/pay) is also detected.
import { NextRequest, NextResponse } from "next/server";
import { errMessage } from "@/lib/demo/http";
import { checkMakerPaymentStatus } from "@/lib/demo/maker";
import { getMakerEnv } from "@/lib/demo/makerEnv";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const env = getMakerEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  const matchId = request.nextUrl.searchParams.get("matchId");
  if (!matchId) {
    return NextResponse.json({ error: "matchId query param is required" }, { status: 400 });
  }

  try {
    const result = await checkMakerPaymentStatus(matchId);
    return NextResponse.json(result);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const status = code === "UNKNOWN_MATCH" ? 404 : 500;
    return NextResponse.json({ error: errMessage(err) }, { status });
  }
}
