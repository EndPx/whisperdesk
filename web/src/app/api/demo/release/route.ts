// POST /api/demo/release — submits DvPEscrow.release(matchId, proof) with the FDC proof the client
// got (verbatim) from GET /api/demo/proof. Submitted by the owner/teeSigner wallet (release() is
// permissionless on-chain, same as the e2e script's choice of relayer).
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { DVP_ESCROW_ABI } from "@/lib/demo/abi";
import { COSTON2_CHAIN_ID } from "@/lib/demo/config";
import { createDemoWallet, getDemoEnv } from "@/lib/demo/env";
import { buildProofTuple, type ProofResult } from "@/lib/demo/fdc";
import { errMessage } from "@/lib/demo/http";
import { releaseRunLock } from "@/lib/demo/state";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getDemoEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  let matchId: string;
  let proof: ProofResult;
  try {
    const body = await request.json();
    if (typeof body?.matchId !== "string" || !body.matchId || !body?.proof) {
      return NextResponse.json({ error: "body.matchId (string) and body.proof are required" }, { status: 400 });
    }
    matchId = body.matchId;
    proof = body.proof;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const provider = new ethers.JsonRpcProvider(env.coston2Rpc, COSTON2_CHAIN_ID);
    const wallet = createDemoWallet(env.ownerPrivateKey, provider, "owner/teeSigner");
    const escrow = new ethers.Contract(env.escrowAddress, DVP_ESCROW_ABI, wallet);

    const proofTuple = buildProofTuple(proof);
    const tx = await escrow.release(matchId, proofTuple);
    const receipt = await tx.wait();

    releaseRunLock();
    return NextResponse.json({ releaseTx: receipt.hash });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
