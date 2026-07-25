// POST /api/maker/settle — requests the FDC attestation for the confirmed XRPL payment (found by
// POST /api/maker/pay or GET /api/maker/payment-status). From here the client reuses the UNCHANGED
// GET /api/demo/proof (poll) and POST /api/demo/release (submit release()) to finish the flow.
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { COSTON2_CHAIN_ID } from "@/lib/demo/config";
import { createDemoWallet } from "@/lib/demo/env";
import { submitAttestationRequest } from "@/lib/demo/fdc";
import { errMessage } from "@/lib/demo/http";
import { getSettleInput } from "@/lib/demo/maker";
import { getMakerEnv } from "@/lib/demo/makerEnv";
import { checkAndConsume, clientIpFromHeaders } from "@/lib/demo/ratelimit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getMakerEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  // Abuse guard, own budget — spends real Coston2 gas + an FDC request fee from the owner key, same
  // shape as /api/demo/attest's "demo-attest" budget.
  const ip = clientIpFromHeaders(request.headers);
  const limit = checkAndConsume("maker-settle", ip);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "maker-mode rate limit hit for this deployment — try again later", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429 }
    );
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

  let xrplTx: string;
  try {
    ({ xrplTx } = getSettleInput(matchId));
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const status = code === "UNKNOWN_MATCH" ? 404 : code === "NOT_PAID" ? 409 : 500;
    return NextResponse.json({ error: errMessage(err) }, { status });
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
    return NextResponse.json({ attested: true, roundId: String(result.roundId), requestHex: result.requestHex });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
