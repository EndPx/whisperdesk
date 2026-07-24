// POST /api/wallet/prepare — funds the desk maker's bond, builds + teeSigner-signs a
// MatchInstruction naming the judge's own address as taker, and returns everything the judge's own
// MetaMask needs to approve() + deposit() + lock() itself. See buildWalletPrepare() in
// wallet-mode.ts for the destinationTag/xrpDrops prediction reasoning and
// WALLET_MODE_DEADLINE_SECONDS for the >=25-minute deadline fields.
//
// Reuses state.ts's single run lock (shared with /api/demo/lock) so a one-click run and a
// wallet-mode run can never be mid-flight at the same time.
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { getDemoEnv } from "@/lib/demo/env";
import { errMessage } from "@/lib/demo/http";
import { attachMatchId, releaseRunLock, tryAcquireRunLock } from "@/lib/demo/state";
import { buildWalletPrepare } from "@/lib/demo/wallet-mode";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getDemoEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  let taker: string;
  let xrplAddress: string;
  try {
    const body = await request.json();
    if (typeof body?.taker !== "string" || !body.taker) {
      return NextResponse.json({ error: "body.taker (string) is required" }, { status: 400 });
    }
    if (typeof body?.xrplAddress !== "string" || !body.xrplAddress) {
      return NextResponse.json({ error: "body.xrplAddress (string) is required" }, { status: 400 });
    }
    taker = ethers.getAddress(body.taker); // throws on malformed/bad-checksum input
    xrplAddress = body.xrplAddress;
  } catch {
    return NextResponse.json({ error: "invalid JSON body or malformed taker address" }, { status: 400 });
  }

  if (!tryAcquireRunLock("happy")) {
    return NextResponse.json({ busy: true }, { status: 409 });
  }

  try {
    const result = await buildWalletPrepare(env, taker, xrplAddress);
    attachMatchId(result.matchId);
    return NextResponse.json(result);
  } catch (err) {
    releaseRunLock();
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
