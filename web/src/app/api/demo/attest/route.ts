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
import { checkAndConsume, clientIpFromHeaders } from "@/lib/demo/ratelimit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getDemoEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  // Abuse guard — see ratelimit.ts. This is unauthenticated and pays real Coston2 gas +
  // an FDC request fee from the owner/teeSigner key, so it needs its own budget distinct
  // from lock's — a garbage-xrplTx loop here can't be left unmetered just because lock()
  // already ran once.
  const ip = clientIpFromHeaders(request.headers);
  const limit = checkAndConsume("demo-attest", ip);
  if (!limit.ok) {
    const scopeMsg =
      limit.scope === "ip"
        ? "You've hit the per-visitor limit for the shared one-click demo today."
        : "The shared one-click demo has hit its daily limit across all visitors.";
    return NextResponse.json(
      // No "switch modes" advice here: this route is shared by the one-click path AND taker mode
      // (WalletMode.tsx step 5), so pointing at taker mode would be nonsense for half the callers.
      { error: `${scopeMsg} Try again later, or check the settled receipts below.`, retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429 },
    );
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
