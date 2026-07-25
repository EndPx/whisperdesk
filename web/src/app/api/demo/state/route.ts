// GET /api/demo/state — read-only snapshot for the demo console UI: whether the demo is
// configured, the escrow address, and current FXRP balances for taker/maker/escrow ("vault"), plus
// the taker's own XRPL balance (the other leg of the swap — see taker.xrp below).
// Always 200 (enabled:false when unconfigured, rather than 503) since {enabled} is itself the
// payload's own contract per this endpoint's single defined response shape.
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { DVP_ESCROW_ABI, MOCK_FXRP_ABI } from "@/lib/demo/abi";
import { createDemoWallet, getDemoEnv } from "@/lib/demo/env";
import { errMessage } from "@/lib/demo/http";
import { getXrplBalance } from "@/lib/demo/wallet-mode";

export const runtime = "nodejs";

export async function GET() {
  const env = getDemoEnv();
  if (!env) {
    return NextResponse.json({ enabled: false });
  }

  try {
    const provider = new ethers.JsonRpcProvider(env.coston2Rpc);
    const escrow = new ethers.Contract(env.escrowAddress, DVP_ESCROW_ABI, provider);
    const fxrpAddress: string = await escrow.FXRP();
    const fxrp = new ethers.Contract(fxrpAddress, MOCK_FXRP_ABI, provider);

    const takerAddress = createDemoWallet(env.takerPrivateKey, provider, "taker").address;
    const makerAddress = createDemoWallet(env.makerPrivateKey, provider, "maker").address;

    const [takerBal, makerBal, vaultBal]: [bigint, bigint, bigint] = await Promise.all([
      fxrp.balanceOf(takerAddress),
      fxrp.balanceOf(makerAddress),
      fxrp.balanceOf(env.escrowAddress),
    ]);

    // The taker's other leg — the XRP they receive on the XRP Ledger — lives outside Coston2, so it
    // needs its own read against the demo's fixed taker XRPL address. Reuses the same xrpl.js client
    // wallet-mode.ts already wraps for /api/wallet/xrpl-balance (see getXrplBalance) rather than
    // duplicating it here. Best-effort: an XRPL hiccup must not take down the FXRP figures above —
    // omit the field so the client shows a neutral placeholder instead of a stale or invented number.
    let takerXrp: string | undefined;
    try {
      takerXrp = (await getXrplBalance(env.xrplTakerAddress)).balanceXrp;
    } catch {
      takerXrp = undefined;
    }

    return NextResponse.json({
      enabled: true,
      escrow: env.escrowAddress,
      taker: { fxrp: ethers.formatUnits(takerBal, 6), xrp: takerXrp },
      maker: { fxrp: ethers.formatUnits(makerBal, 6) },
      vault: { fxrp: ethers.formatUnits(vaultBal, 6) },
    });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
