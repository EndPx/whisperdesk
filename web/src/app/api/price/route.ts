// GET /api/price — the live FTSOv2 XRP/USD mid, so Holdings can value a balance with the very feed
// that bounds every match this desk signs.
//
// Its own route rather than another field on /api/wallet/status: the FTSO read costs a fee lookup
// plus a payable static call, and balances are polled far more often than a price needs to be.
//
// The feed address is read from the escrow (escrow.ftsoV2()) rather than hardcoded, so it can never
// drift from the contract the ±1% band is actually checked against.
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { DVP_ESCROW_ABI, FTSOV2_ABI } from "@/lib/demo/abi";
import { COSTON2_CHAIN_ID } from "@/lib/demo/config";
import { getDemoEnv } from "@/lib/demo/env";
import { readLiveFtsoMid } from "@/lib/demo/flow";
import { errMessage } from "@/lib/demo/http";

export const runtime = "nodejs";

export async function GET() {
  const env = getDemoEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  try {
    const provider = new ethers.JsonRpcProvider(env.coston2Rpc, COSTON2_CHAIN_ID);
    const escrow = new ethers.Contract(env.escrowAddress, DVP_ESCROW_ABI, provider);
    const ftsoV2Address: string = await escrow.ftsoV2();
    const ftso = new ethers.Contract(ftsoV2Address, FTSOV2_ABI, provider);

    const { mid18, ts } = await readLiveFtsoMid(ftso);
    return NextResponse.json({
      xrpUsd: ethers.formatUnits(mid18, 18),
      ts: ts.toString(), // FTSOv2 publish time, epoch seconds — not a formatted date
    });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
