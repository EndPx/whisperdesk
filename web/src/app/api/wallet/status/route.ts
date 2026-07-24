// GET /api/wallet/status?taker=0x... — MockFXRP balance + native C2FLR balance for the judge's own
// address. See getWalletStatus() in wallet-mode.ts.
import { ethers } from "ethers";
import { NextRequest, NextResponse } from "next/server";
import { getDemoEnv } from "@/lib/demo/env";
import { errMessage } from "@/lib/demo/http";
import { getWalletStatus } from "@/lib/demo/wallet-mode";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const env = getDemoEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  const takerRaw = request.nextUrl.searchParams.get("taker");
  if (!takerRaw) {
    return NextResponse.json({ error: "taker query param is required" }, { status: 400 });
  }

  let taker: string;
  try {
    taker = ethers.getAddress(takerRaw);
  } catch {
    return NextResponse.json({ error: "taker is not a valid EVM address" }, { status: 400 });
  }

  try {
    const result = await getWalletStatus(env, taker);
    return NextResponse.json({ enabled: true, fxrp: result.fxrp, c2flr: result.c2flr });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
