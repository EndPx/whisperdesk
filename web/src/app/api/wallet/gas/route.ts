// POST /api/wallet/gas — sends a fixed C2FLR drip to a judge's own address so they can pay for the
// demo's own transactions without leaving the site mid-run for faucet.flare.network.
//
// Why it lives under /api/wallet even though maker mode uses it too: it needs nothing beyond
// getDemoEnv()'s owner key, and getMakerEnv() layers on top of getDemoEnv() with the same owner —
// so one route serves both seats, and maker mode does not 503 here if a maker-only var is unset.
//
// SECURITY: spends the desk's own native balance, which (unlike MockFXRP) cannot be minted back.
// The guards live in wallet-mode.ts's checkAndRecordGasClaim; this route additionally refuses an
// address that can already pay its own way, BEFORE spending a claim slot on it.
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { COSTON2_CHAIN_ID } from "@/lib/demo/config";
import { createDemoWallet, getDemoEnv } from "@/lib/demo/env";
import { errMessage } from "@/lib/demo/http";
import {
  checkAndRecordGasClaim,
  GAS_DRIP_WEI,
  GAS_ENOUGH_WEI,
  GAS_OWNER_RESERVE_WEI,
} from "@/lib/demo/wallet-mode";

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

  const provider = new ethers.JsonRpcProvider(env.coston2Rpc, COSTON2_CHAIN_ID);

  // Read the balance BEFORE the rate limiter: a judge who already has gas should not burn their
  // one claim per ten minutes on a drip they did not need.
  let balance: bigint;
  try {
    balance = await provider.getBalance(address);
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
  if (balance >= GAS_ENOUGH_WEI) {
    return NextResponse.json({
      skipped: true,
      balance: ethers.formatEther(balance),
      reason: "this address can already pay for a transaction",
    });
  }

  // The reserve check runs before the claim slot too, and before any state is mutated: the desk's
  // own settlements are funded by this same key, so protecting it outranks serving this request.
  const ownerWallet = createDemoWallet(env.ownerPrivateKey, provider, "owner");
  try {
    const ownerBalance = await provider.getBalance(ownerWallet.address);
    if (ownerBalance - GAS_DRIP_WEI < GAS_OWNER_RESERVE_WEI) {
      return NextResponse.json(
        { error: "the desk is holding its remaining gas for settlements — https://faucet.flare.network" },
        { status: 429 },
      );
    }
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }

  const refusal = checkAndRecordGasClaim(address);
  if (refusal === "rate-limited") {
    return NextResponse.json(
      { error: "gas already sent to this address in the last 10 minutes" },
      { status: 429 },
    );
  }
  if (refusal === "budget-exhausted") {
    return NextResponse.json(
      { error: "the desk's daily gas budget is spent — https://faucet.flare.network still works" },
      { status: 429 },
    );
  }

  try {
    const tx = await ownerWallet.sendTransaction({ to: address, value: GAS_DRIP_WEI });
    const receipt = await tx.wait();
    const updated = await provider.getBalance(address);
    return NextResponse.json({
      txHash: receipt?.hash ?? tx.hash,
      sent: ethers.formatEther(GAS_DRIP_WEI),
      balance: ethers.formatEther(updated),
    });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
