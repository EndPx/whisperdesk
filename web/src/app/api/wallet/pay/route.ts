// POST /api/wallet/pay — sends the REAL XRPL maker->taker payment for a match a prior
// /api/wallet/prepare call set up. SECURITY: destination/xrpDrops/destinationTag come ONLY from the
// server-side record /api/wallet/prepare wrote (getPrepareRecord in wallet-mode.ts) — NEVER from
// this request's body. On a missing/expired record (10-min TTL), returns the 404 the fixed API
// contract specifies rather than trusting anything the client might supply instead.
import { NextResponse } from "next/server";
import { XRPL_TESTNET_WSS } from "@/lib/demo/config";
import { getDemoEnv } from "@/lib/demo/env";
import { errMessage } from "@/lib/demo/http";
import { getPrepareRecord } from "@/lib/demo/wallet-mode";
import { payXrpl } from "@/lib/demo/xrplPay";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getDemoEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  let matchId: string;
  try {
    const body = await request.json();
    if (typeof body?.matchId !== "string" || !body.matchId) {
      return NextResponse.json({ error: "body.matchId (string) is required" }, { status: 400 });
    }
    matchId = body.matchId;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const record = getPrepareRecord(matchId);
  if (!record) {
    return NextResponse.json({ error: "unknown matchId — prepare again" }, { status: 404 });
  }

  try {
    const result = await payXrpl({
      wss: XRPL_TESTNET_WSS,
      makerSeed: env.xrplMakerSeed,
      takerAddress: record.destination,
      amountDrops: record.xrpDrops,
      destinationTag: record.destinationTag,
    });
    return NextResponse.json({ xrplTx: result.txHash });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
