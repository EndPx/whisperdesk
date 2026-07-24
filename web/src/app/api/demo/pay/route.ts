// POST /api/demo/pay — makes the REAL XRPL maker->taker payment for the amount/destinationTag a
// prior /api/demo/lock call assigned on-chain. See src/lib/demo/xrplPay.ts.
import { NextResponse } from "next/server";
import { XRPL_TESTNET_WSS } from "@/lib/demo/config";
import { getDemoEnv } from "@/lib/demo/env";
import { errMessage } from "@/lib/demo/http";
import { payXrpl } from "@/lib/demo/xrplPay";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getDemoEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  let destinationTag: number;
  let xrpDrops: string;
  try {
    const body = await request.json();
    if (
      (typeof body?.destinationTag !== "number" && typeof body?.destinationTag !== "string") ||
      body?.xrpDrops === undefined ||
      body?.xrpDrops === null
    ) {
      return NextResponse.json({ error: "body must include destinationTag and xrpDrops" }, { status: 400 });
    }
    destinationTag = Number(body.destinationTag);
    xrpDrops = String(body.xrpDrops);
    if (!Number.isFinite(destinationTag)) {
      return NextResponse.json({ error: "destinationTag must be numeric" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await payXrpl({
      wss: XRPL_TESTNET_WSS,
      makerSeed: env.xrplMakerSeed,
      takerAddress: env.xrplTakerAddress,
      amountDrops: xrpDrops,
      destinationTag,
    });
    return NextResponse.json({ xrplTx: result.txHash });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
