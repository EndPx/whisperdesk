// POST /api/taker/rfq/publish — seal the visitor's order for their own wallet to submit.
//
// The ciphertext comes back rather than going out. submitRfq has to originate from the taker's own
// wallet, because WhisperDeskInstructionSender writes the taker into the instruction envelope from
// msg.sender — and that stamp is the whole reason a taker's identity cannot be claimed. Relaying it
// from a desk key would produce an order attributed to the desk, precisely the forgery the onchain
// ingress exists to prevent.
//
// This route briefly submitted over POST /direct with a self-attested taker, after every onchain
// submission began returning 404. That was our own TEE machine registered under
// `http://localhost:6674`: Flare's data providers push to the URL recorded on-chain, so they were
// pushing at a loopback address that meant nothing to them. Corrected with
// updateTeeMachineSettings; the machine is PRODUCTION and an onchain submitRfq now returns an
// enclave ack.
//
// The order's numbers are the taker's own, re-checked here against the two systems that enforce
// them — the escrow's MIN_BLOCK_FXRP and the FTSOv2 band lock() re-reads — so an order that
// provably cannot fill is refused before it costs anyone a signature.
import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { sealTakerRfq } from "@/lib/demo/maker";
import { getMakerEnv } from "@/lib/demo/makerEnv";
import { errMessage } from "@/lib/demo/http";
import { checkAndConsume, clientIpFromHeaders } from "@/lib/demo/ratelimit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getMakerEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  const ip = clientIpFromHeaders(request.headers);
  const limit = checkAndConsume("taker-open-rfq", ip);
  if (!limit.ok) {
    return NextResponse.json({ error: "rate limited — try again shortly" }, { status: 429 });
  }

  let taker: string;
  let xrplAddress: string;
  let fxrpAmountRaw: bigint;
  let limitPriceUsdE18: bigint;
  try {
    const body = await request.json();
    taker = ethers.getAddress(body?.taker); // throws on malformed/bad-checksum input
    if (typeof body?.xrplAddress !== "string" || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(body.xrplAddress)) {
      return NextResponse.json({ error: "body.xrplAddress must be a classic XRPL address" }, { status: 400 });
    }
    xrplAddress = body.xrplAddress;

    // Decimal strings only: a JSON number silently loses precision on an 18-decimal price, and that
    // rounding would land in the one field the entire trade is priced on.
    if (!/^[0-9]+$/.test(String(body?.fxrpAmountRaw ?? "")) || !/^[0-9]+$/.test(String(body?.limitPriceUsdE18 ?? ""))) {
      return NextResponse.json(
        { error: "body.fxrpAmountRaw and body.limitPriceUsdE18 must be decimal integer strings" },
        { status: 400 }
      );
    }
    fxrpAmountRaw = BigInt(body.fxrpAmountRaw);
    limitPriceUsdE18 = BigInt(body.limitPriceUsdE18);

    // The enclave carries the size as a uint64, so anything larger would wrap instead of being
    // refused (fcewire's handleRfqSubmit gates on amount.IsUint64()).
    if (fxrpAmountRaw > BigInt("18446744073709551615")) {
      return NextResponse.json({ error: "body.fxrpAmountRaw exceeds uint64" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "body.taker must be a valid EVM address" }, { status: 400 });
  }

  try {
    return NextResponse.json(
      await sealTakerRfq(env, taker, xrplAddress, fxrpAmountRaw, limitPriceUsdE18)
    );
  } catch (err) {
    // A rejected order is the caller's to fix — size under the block minimum, limit outside the
    // band — so this answers 400 and names the bound that was missed rather than a blank 500.
    return NextResponse.json({ error: errMessage(err) }, { status: 400 });
  }
}
