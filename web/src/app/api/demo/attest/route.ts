// POST /api/demo/attest — requests a fresh FDC XRPPayment attestation for `xrplTx`, with
// requestBody.proofOwner bound to the deployed escrow (required for release() to accept the proof
// later, docs/design.md §3.7). Returns promptly after requestAttestation() confirms; does NOT wait
// for the DA layer proof — poll GET /api/demo/proof for that. See src/lib/demo/fdc.ts.
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { COSTON2_CHAIN_ID } from "@/lib/demo/config";
import { createDemoWallet, getDemoEnv } from "@/lib/demo/env";
import { submitAttestationRequest } from "@/lib/demo/fdc";
import { errMessage } from "@/lib/demo/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getDemoEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  let xrplTx: string;
  try {
    const body = await request.json();
    if (typeof body?.xrplTx !== "string" || !body.xrplTx) {
      return NextResponse.json({ error: "body.xrplTx (string) is required" }, { status: 400 });
    }
    xrplTx = body.xrplTx;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const provider = new ethers.JsonRpcProvider(env.coston2Rpc, COSTON2_CHAIN_ID);
    const wallet = createDemoWallet(env.ownerPrivateKey, provider, "owner/teeSigner");
    const result = await submitAttestationRequest({
      provider,
      wallet,
      txHashHex: xrplTx,
      proofOwner: env.escrowAddress,
    });
    return NextResponse.json({ roundId: String(result.roundId), requestHex: result.requestHex });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
