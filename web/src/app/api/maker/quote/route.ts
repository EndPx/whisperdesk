// POST /api/maker/quote — the maker's own EIP-712 Quote signature (produced in THEIR wallet) is
// sealed and submitted over /direct. The server never sees a maker private key — only the
// resulting 65-byte signature, which it forwards as-is.
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { errMessage } from "@/lib/demo/http";
import { getMakerEnv } from "@/lib/demo/makerEnv";
import { submitQuote, verifyQuoteSignature, type QuoteInput } from "@/lib/demo/maker";
import { checkAndConsume, clientIpFromHeaders } from "@/lib/demo/ratelimit";

export const runtime = "nodejs";

function isDecimalString(v: unknown): v is string {
  return typeof v === "string" && /^[0-9]+$/.test(v);
}

export async function POST(request: Request) {
  const env = getMakerEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  // Abuse guard, own budget — every call shells out to wd-client (encrypt + a /direct submit
  // gated by DIRECT_API_KEY), and this route is reachable without holding the run lock.
  const ip = clientIpFromHeaders(request.headers);
  const limit = checkAndConsume("maker-quote", ip);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "maker-mode rate limit hit for this deployment — try again later", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429 }
    );
  }

  let input: QuoteInput;
  try {
    const body = await request.json();
    if (typeof body?.rfqId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.rfqId)) {
      return NextResponse.json({ error: "body.rfqId must be a 0x-hex 32-byte string" }, { status: 400 });
    }
    if (typeof body?.maker !== "string") {
      return NextResponse.json({ error: "body.maker (string) is required" }, { status: 400 });
    }
    if (!isDecimalString(body?.priceUsdE18) || !isDecimalString(body?.maxFxrpRaw) || !isDecimalString(body?.nonce)) {
      return NextResponse.json(
        { error: "body.priceUsdE18/maxFxrpRaw/nonce must be non-negative decimal strings" },
        { status: 400 }
      );
    }
    if (typeof body?.sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(body.sig)) {
      return NextResponse.json({ error: "body.sig must be a 0x-hex 65-byte EIP-712 signature" }, { status: 400 });
    }

    let maker: string;
    try {
      maker = ethers.getAddress(body.maker);
    } catch {
      return NextResponse.json({ error: "body.maker is not a valid EVM address" }, { status: 400 });
    }

    input = {
      rfqId: body.rfqId,
      maker,
      priceUsdE18: body.priceUsdE18,
      maxFxrpRaw: body.maxFxrpRaw,
      nonce: body.nonce,
      sig: body.sig,
    };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!verifyQuoteSignature(env, input)) {
    return NextResponse.json({ error: "sig does not recover to body.maker for this Quote" }, { status: 400 });
  }

  try {
    const ack = await submitQuote(env, input);
    return NextResponse.json({ accepted: ack.accepted, replaced: ack.replaced });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 400 });
  }
}
