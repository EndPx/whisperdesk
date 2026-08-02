// POST /api/demo/pay — makes the REAL XRPL maker->taker payment for the amount/destinationTag a
// prior /api/demo/lock call assigned on-chain. See src/lib/demo/xrplPay.ts.
import { NextResponse } from "next/server";
import { XRPL_TESTNET_WSS } from "@/lib/demo/config";
import { getDemoEnv } from "@/lib/demo/env";
import { errMessage } from "@/lib/demo/http";
import { checkAndConsume, clientIpFromHeaders } from "@/lib/demo/ratelimit";
import { payXrpl } from "@/lib/demo/xrplPay";

export const runtime = "nodejs";

// The demo trades 1 FXRP worth of XRP; 2,000,000 drops (2 XRP) is already a generous
// ceiling above any real run's amount. destinationTag/xrpDrops come straight off the
// client body — the destination address is pinned server-side in payXrpl so funds can't
// be redirected, but nothing upstream bounds the amount, so it must be checked here.
const MAX_XRP_DROPS = 2_000_000;

export async function POST(request: Request) {
  const env = getDemoEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  // Abuse guard — see ratelimit.ts. This is unauthenticated and sends real testnet XRP
  // from the maker seed, so it needs its own budget distinct from lock's.
  const ip = clientIpFromHeaders(request.headers);
  const limit = checkAndConsume("demo-pay", ip);
  if (!limit.ok) {
    const scopeMsg =
      limit.scope === "ip"
        ? "You've hit the per-visitor limit for the shared one-click demo today."
        : "The shared one-click demo has hit its daily limit across all visitors.";
    return NextResponse.json(
      { error: `${scopeMsg} Try again later, or run it with your own wallet — "as the taker" on the demo page.`, retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429 },
    );
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
    const dropsNum = Number(xrpDrops);
    if (!Number.isFinite(dropsNum) || dropsNum <= 0 || dropsNum > MAX_XRP_DROPS) {
      return NextResponse.json(
        { error: `xrpDrops must be a positive number no greater than ${MAX_XRP_DROPS} (2 XRP)` },
        { status: 400 },
      );
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
