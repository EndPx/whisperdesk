// POST /api/taker/rfq/prepare — seal an RFQ whose taker is the judge, for the judge's wallet to
// submit itself.
//
// This is the half that lets the two seats meet. Until now a taker could only trade against the
// desk: /api/wallet/prepare has the desk sign the match as maker. Here the judge publishes a sealed
// RFQ into the shared queue instead, and whoever is sitting in a maker seat can quote it — so the
// trade that settles has an independent person on each side.
//
// The ciphertext comes back rather than going straight out, because submitRfq must be sent by the
// taker's own wallet. WhisperDeskInstructionSender stamps the taker from msg.sender, and relaying it
// from a desk key would throw away exactly the property that makes a taker's identity unforgeable.
import { NextResponse } from "next/server";
import { ethers } from "ethers";
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

  let taker: string;
  let xrplAddress: string;
  try {
    const body = await request.json();
    taker = ethers.getAddress(body?.taker); // throws on malformed/bad-checksum input
    if (typeof body?.xrplAddress !== "string" || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(body.xrplAddress)) {
      return NextResponse.json({ error: "body.xrplAddress must be a classic XRPL address" }, { status: 400 });
    }
    xrplAddress = body.xrplAddress;
  } catch {
    return NextResponse.json({ error: "body.taker must be a valid EVM address" }, { status: 400 });
  }

  try {
    return NextResponse.json(await buildTakerRfqPrepare(env, taker, xrplAddress));
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
