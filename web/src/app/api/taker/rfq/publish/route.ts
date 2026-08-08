// POST /api/taker/rfq/publish — seal the visitor's order and put it in the shared queue.
//
// This is the route where the desk stops being a counterparty. Everything else in the taker seat
// trades against the house; here the order goes where a stranger can fill it, and the trade that
// settles has an independent person on each side. The desk seals, relays, and pays gas for two
// permissionless calls — it holds neither leg.
//
// The taker in the sealed envelope is self-attested on this ingress rather than stamped from
// msg.sender. maker.ts's publishTakerRfq spells out exactly what that costs; the short version is
// that it costs attribution, not safety, because lock() draws the FXRP from the named taker's own
// armed deposit and pays the XRP to the address sealed beside it.
import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { publishTakerRfq } from "@/lib/demo/maker";
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

    // The order itself, in raw integer units — the taker's numbers, not the desk's. Decimal strings
    // only: a JSON number silently loses precision on an 18-decimal price, and that rounding would
    // land in the one field the entire trade is priced on.
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
      await publishTakerRfq(env, taker, xrplAddress, fxrpAmountRaw, limitPriceUsdE18)
    );
  } catch (err) {
    // A rejected order is the caller's to fix — size under the block minimum, limit outside the band
    // — so this answers 400 and names the bound that was missed rather than a blank 500.
    return NextResponse.json({ error: errMessage(err) }, { status: 400 });
  }
}
