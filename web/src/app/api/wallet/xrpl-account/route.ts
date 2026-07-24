// POST /api/wallet/xrpl-account — generates a fresh, throwaway XRPL testnet account server-side and
// funds it via the XRPL testnet faucet. Returning the seed is intentional: this is a brand-new
// testnet-only account created for this judge's session, never the desk's own maker seed. See
// generateAndFundXrplAccount() in wallet-mode.ts.
import { NextResponse } from "next/server";
import { isDemoEnabled } from "@/lib/demo/env";
import { errMessage } from "@/lib/demo/http";
import { generateAndFundXrplAccount } from "@/lib/demo/wallet-mode";

export const runtime = "nodejs";

export async function POST() {
  if (!isDemoEnabled()) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  try {
    const account = await generateAndFundXrplAccount();
    return NextResponse.json({ address: account.address, seed: account.seed, funded: true });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
