// GET /api/wallet/xrpl-balance?address=r... — one-shot XRPL account_info lookup for the judge's own
// XRPL testnet address. exists:false (not an error) for an unactivated account. See
// getXrplBalance() in wallet-mode.ts.
import { NextRequest, NextResponse } from "next/server";
import { isDemoEnabled } from "@/lib/demo/env";
import { errMessage } from "@/lib/demo/http";
import { getXrplBalance } from "@/lib/demo/wallet-mode";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!isDemoEnabled()) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  const address = request.nextUrl.searchParams.get("address");
  if (!address) {
    return NextResponse.json({ error: "address query param is required" }, { status: 400 });
  }

  try {
    const result = await getXrplBalance(address);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
