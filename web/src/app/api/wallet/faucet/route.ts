// POST /api/wallet/faucet — mints exactly 2 MockFXRP to the judge's own MetaMask address, using the
// desk owner key. Rate-limited to 1 claim per address per 10 minutes (wallet-mode.ts).
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { DVP_ESCROW_ABI, MOCK_FXRP_ABI } from "@/lib/demo/abi";
import { COSTON2_CHAIN_ID } from "@/lib/demo/config";
import { createDemoWallet, getDemoEnv } from "@/lib/demo/env";
import { errMessage } from "@/lib/demo/http";
import { checkAndRecordFaucetClaim, FAUCET_MINT_HUMAN, FAUCET_MINT_RAW } from "@/lib/demo/wallet-mode";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getDemoEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  let address: string;
  try {
    const body = await request.json();
    if (typeof body?.address !== "string" || !body.address) {
      return NextResponse.json({ error: "body.address (string) is required" }, { status: 400 });
    }
    address = ethers.getAddress(body.address); // throws on malformed/bad-checksum input
  } catch {
    return NextResponse.json({ error: "body.address is not a valid EVM address" }, { status: 400 });
  }

  if (!checkAndRecordFaucetClaim(address)) {
    return NextResponse.json({ error: "faucet already claimed for this address in the last 10 minutes" }, {
      status: 429,
    });
  }

  try {
    const provider = new ethers.JsonRpcProvider(env.coston2Rpc, COSTON2_CHAIN_ID);
    const ownerWallet = createDemoWallet(env.ownerPrivateKey, provider, "owner");

    // Resolve MockFXRP address via the escrow (single source of truth), then mint from the owner.
    const escrowRead = new ethers.Contract(env.escrowAddress, DVP_ESCROW_ABI, provider);
    const fxrpAddress: string = await escrowRead.FXRP();
    const fxrpAsOwner = new ethers.Contract(fxrpAddress, MOCK_FXRP_ABI, ownerWallet);

    const tx = await fxrpAsOwner.mint(address, FAUCET_MINT_RAW);
    const receipt = await tx.wait();

    const fxrpRead = new ethers.Contract(fxrpAddress, MOCK_FXRP_ABI, provider);
    const balance: bigint = await fxrpRead.balanceOf(address);

    return NextResponse.json({
      txHash: receipt.hash,
      minted: FAUCET_MINT_HUMAN,
      balance: ethers.formatUnits(balance, 6),
    });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
