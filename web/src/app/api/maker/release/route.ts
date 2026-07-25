// POST /api/maker/release — the maker-mode twin of /api/demo/release.
//
// Why this exists instead of reusing /api/demo/release: that route resolves the escrow from
// getDemoEnv(), i.e. the one-click demo instance. Maker mode settles on the ENCLAVE-LOOP escrow
// (getMakerEnv() overrides escrowAddress — see makerEnv.ts for the two reasons), so calling the
// demo route here reverts: the matchId simply does not exist on that contract.
//
// GET /api/demo/proof is still shared and correct — polling the FDC DA layer for a round's proof is
// escrow-agnostic. Only the release() call has to know which escrow the match lives on.
//
// release() is permissionless on-chain; the owner wallet submits it purely as the relayer, exactly
// as /api/demo/release does.
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { DVP_ESCROW_ABI } from "@/lib/demo/abi";
import { COSTON2_CHAIN_ID } from "@/lib/demo/config";
import { createDemoWallet } from "@/lib/demo/env";
import { buildProofTuple, type ProofResult } from "@/lib/demo/fdc";
import { errMessage } from "@/lib/demo/http";
import { getMakerEnv } from "@/lib/demo/makerEnv";
import { releaseRunLock } from "@/lib/demo/state";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getMakerEnv();
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
    const wallet = createDemoWallet(env.ownerPrivateKey, provider, "owner/relayer");
    const escrow = new ethers.Contract(env.escrowAddress, DVP_ESCROW_ABI, wallet);

    const proofTuple = buildProofTuple(proof);
    const tx = await escrow.release(matchId, proofTuple);
    const receipt = await tx.wait();

    // The run is finished either way — free the lock so the next visitor can start.
    releaseRunLock();
    return NextResponse.json({ releaseTx: receipt.hash, escrow: env.escrowAddress });
  } catch (err) {
    releaseRunLock();
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
