// GET /api/demo/state — read-only snapshot for the demo console UI: whether the demo is
// configured, the escrow address, and current FXRP balances for taker/maker/escrow ("vault").
// Always 200 (enabled:false when unconfigured, rather than 503) since {enabled} is itself the
// payload's own contract per this endpoint's single defined response shape.
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { DVP_ESCROW_ABI, MOCK_FXRP_ABI } from "@/lib/demo/abi";
import { createDemoWallet, getDemoEnv } from "@/lib/demo/env";
import { errMessage } from "@/lib/demo/http";

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

    return NextResponse.json({
      enabled: true,
      escrow: env.escrowAddress,
      taker: { fxrp: ethers.formatUnits(takerBal, 6) },
      maker: { fxrp: ethers.formatUnits(makerBal, 6) },
      vault: { fxrp: ethers.formatUnits(vaultBal, 6) },
    });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
