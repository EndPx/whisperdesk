// GET /api/demo/proof?roundId=..&requestHex=.. — one non-blocking sweep of the DA layer for the
// Merkle proof of a previously submitted attestation request. Meant to be polled by the client
// every few seconds until {ready:true}. The returned `proof` is opaque JSON: the client must pass
// it back verbatim as body.proof to POST /api/demo/release. See src/lib/demo/fdc.ts.
import { NextRequest, NextResponse } from "next/server";
import { isDemoEnabled } from "@/lib/demo/env";
import { checkProofOnce } from "@/lib/demo/fdc";
import { errMessage } from "@/lib/demo/http";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!isDemoEnabled()) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  const { searchParams } = new URL(request.url);
  const roundIdRaw = searchParams.get("roundId");
  const requestHex = searchParams.get("requestHex");
  if (!roundIdRaw || !requestHex) {
    return NextResponse.json({ error: "roundId and requestHex query params are required" }, { status: 400 });
  }
  const roundId = Number(roundIdRaw);
  if (!Number.isFinite(roundId)) {
    return NextResponse.json({ error: "roundId must be numeric" }, { status: 400 });
  }

  try {
    const result = await checkProofOnce(roundId, requestHex);
    if (!result.ready) {
      return NextResponse.json({ ready: false });
    }
    return NextResponse.json({ ready: true, proof: result.proof });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
