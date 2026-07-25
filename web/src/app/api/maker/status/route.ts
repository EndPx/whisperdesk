// GET /api/maker/status?maker=0x... — MockFXRP balance, native C2FLR balance, and BondLedger free
// bond for the maker's (judge's) own address. Read-only, unmetered (like /api/wallet/status).
import { ethers } from "ethers";
import { NextRequest, NextResponse } from "next/server";
import { BOND_LEDGER_ABI, DVP_ESCROW_ABI } from "@/lib/demo/abi";
import { errMessage } from "@/lib/demo/http";
import { getMakerEnv } from "@/lib/demo/makerEnv";
import { getWalletStatus } from "@/lib/demo/wallet-mode";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const env = getMakerEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  const makerRaw = request.nextUrl.searchParams.get("maker");
  if (!makerRaw) {
    return NextResponse.json({ error: "maker query param is required" }, { status: 400 });
  }

  let maker: string;
  try {
    maker = ethers.getAddress(makerRaw);
  } catch {
    return NextResponse.json({ error: "maker is not a valid EVM address" }, { status: 400 });
  }

  try {
    const { fxrp, c2flr } = await getWalletStatus(env, maker);

    const provider = new ethers.JsonRpcProvider(env.coston2Rpc);
    const escrow = new ethers.Contract(env.escrowAddress, DVP_ESCROW_ABI, provider);
    const bondLedgerAddress: string = await escrow.BOND_LEDGER();
    const bondLedger = new ethers.Contract(bondLedgerAddress, BOND_LEDGER_ABI, provider);
    const freeBondRaw: bigint = await bondLedger.freeBond(maker);

    return NextResponse.json({
      enabled: true,
      fxrp,
      c2flr,
      freeBond: ethers.formatUnits(freeBondRaw, 6),
    });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
