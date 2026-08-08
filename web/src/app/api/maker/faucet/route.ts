// POST /api/maker/faucet — mints exactly 2 MockFXRP to the maker's (judge's) own wallet address,
// so they have funds to post the 1% bond with. Same mint mechanics as /api/wallet/faucet (reused
// verbatim), plus its own IP rate-limit budget (see ratelimit.ts's "maker-faucet").
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { DVP_ESCROW_ABI, MOCK_FXRP_ABI } from "@/lib/demo/abi";
import { COSTON2_CHAIN_ID } from "@/lib/demo/config";
import { createDemoWallet } from "@/lib/demo/env";
import { errMessage } from "@/lib/demo/http";
import { getMakerEnv } from "@/lib/demo/makerEnv";
import { checkAndConsume, clientIpFromHeaders } from "@/lib/demo/ratelimit";
import { checkAndRecordFaucetClaim, FAUCET_MINT_HUMAN, FAUCET_MINT_RAW } from "@/lib/demo/wallet-mode";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getMakerEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  const ip = clientIpFromHeaders(request.headers);
  const limit = checkAndConsume("maker-faucet", ip);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "faucet rate limit hit for this deployment — try again later", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429 }
    );
  }

  let address: string;
  try {
    const body = await request.json();
    if (typeof body?.address !== "string" || !body.address) {
      return NextResponse.json({ error: "body.address (string) is required" }, { status: 400 });
    }
    address = ethers.getAddress(body.address);
  } catch {
    return NextResponse.json({ error: "body.address is not a valid EVM address" }, { status: 400 });
  }

  if (!checkAndRecordFaucetClaim(address, "maker")) {
    return NextResponse.json({ error: "faucet already claimed for this address in the last 10 minutes" }, {
      status: 429,
    });
  }

  try {
    const provider = new ethers.JsonRpcProvider(env.coston2Rpc, COSTON2_CHAIN_ID);
    const ownerWallet = createDemoWallet(env.ownerPrivateKey, provider, "owner");

    // Sends from the desk's own holdings rather than minting — see /api/wallet/faucet for the full
    // reasoning. Short version: real FAssets FXRP has no mint, so the desk gives away what it has.
    const escrowRead = new ethers.Contract(env.escrowAddress, DVP_ESCROW_ABI, provider);
    const fxrpAddress: string = await escrowRead.FXRP();
    const fxrpAsOwner = new ethers.Contract(fxrpAddress, MOCK_FXRP_ABI, ownerWallet);

    const reserve: bigint = await fxrpAsOwner.balanceOf(ownerWallet.address);
    if (reserve < FAUCET_MINT_RAW) {
      return NextResponse.json(
        { error: "the desk's FXRP reserve is empty — get FXRP straight from faucet.flare.network" },
        { status: 503 }
      );
    }

    const tx = await fxrpAsOwner.transfer(address, FAUCET_MINT_RAW);
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
