// GET /api/taker/rfq/status?rfqId=0x… — has a maker filled my published RFQ yet?
//
// Read straight off the escrow rather than from any server-side record, because the answer only
// counts if the chain says it. matchId IS the rfqId (matchCore builds MatchInstruction.MatchID from
// the RFQ id), so a taker can watch for their own fill with nothing but the id they were handed.
//
// A zero taker address means no lock() has landed for that id — either nobody has quoted yet, or
// the match has not been triggered.
import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { DVP_ESCROW_ABI } from "@/lib/demo/abi";
import { COSTON2_CHAIN_ID } from "@/lib/demo/config";
import { getMakerEnv } from "@/lib/demo/makerEnv";
import { errMessage } from "@/lib/demo/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const env = getMakerEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  const rfqId = new URL(request.url).searchParams.get("rfqId");
  if (!rfqId || !/^0x[0-9a-fA-F]{64}$/.test(rfqId)) {
    return NextResponse.json({ error: "rfqId must be a 32-byte hex string" }, { status: 400 });
  }

  try {
    const provider = new ethers.JsonRpcProvider(env.coston2Rpc, COSTON2_CHAIN_ID);
    const escrow = new ethers.Contract(env.escrowAddress, DVP_ESCROW_ABI, provider);
    const m = await escrow.matches(rfqId);

    const filled = m.taker !== ethers.ZeroAddress;
    return NextResponse.json({
      filled,
      state: Number(m.state),
      maker: filled ? (m.maker as string) : null,
      xrpDrops: filled ? m.xrpDrops.toString() : null,
      // Epoch seconds, straight from the contract — the client renders the countdown.
      paymentDeadline: filled ? Number(m.paymentDeadline) : null,
    });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
