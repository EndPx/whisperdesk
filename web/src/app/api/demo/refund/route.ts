// POST /api/demo/refund — submits DvPEscrow.refund(matchId) once block.timestamp has passed
// refundAfter + REFUND_GRACE. Reads the match's on-chain deadline first and returns
// {notYet:true, ...} without spending gas if the grace window hasn't elapsed yet, instead of
// deliberately triggering a RefundTooEarly revert.
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { DVP_ESCROW_ABI } from "@/lib/demo/abi";
import { COSTON2_CHAIN_ID } from "@/lib/demo/config";
import { createDemoWallet, getDemoEnv } from "@/lib/demo/env";
import { errMessage } from "@/lib/demo/http";
import { releaseRunLock } from "@/lib/demo/state";

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

  try {
    const provider = new ethers.JsonRpcProvider(env.coston2Rpc, COSTON2_CHAIN_ID);
    const wallet = createDemoWallet(env.ownerPrivateKey, provider, "owner/teeSigner");
    const escrow = new ethers.Contract(env.escrowAddress, DVP_ESCROW_ABI, wallet);

    const m = await escrow.matches(matchId);
    const refundAfter = Number(m.refundAfter);
    const graceSeconds = Number(await escrow.REFUND_GRACE());
    const latestBlock = await provider.getBlock("latest");
    const nowChain = latestBlock ? latestBlock.timestamp : Math.floor(Date.now() / 1000);

    if (nowChain <= refundAfter + graceSeconds) {
      return NextResponse.json({
        notYet: true,
        nowChain: String(nowChain),
        refundAfter: String(refundAfter),
        graceSeconds: String(graceSeconds),
      });
    }

    const tx = await escrow.refund(matchId);
    const receipt = await tx.wait();

    releaseRunLock();
    return NextResponse.json({ refundTx: receipt.hash });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
