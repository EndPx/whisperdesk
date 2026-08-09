// POST /api/taker/rfq/confirm — read back the taker's own submitRfq receipt and publish the order.
//
// Two things happen here that cannot happen in the browser. The enclave acknowledges an onchain
// instruction asynchronously, so the ack has to be polled from the proxy; and the resulting rfqId
// has to land in the shared book for desks in other browsers to find.
//
// The taker stamped in SealedRfqSubmitted is checked against the address claiming to have sent it.
// That is the difference between "this order is yours" and "you told us it was" — and it is a
// property that exists only because the submission went through the contract rather than being
// relayed by this server.
import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { confirmTakerRfq } from "@/lib/demo/maker";
import { getMakerEnv } from "@/lib/demo/makerEnv";
import { errMessage } from "@/lib/demo/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getMakerEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  let txHash: string;
  let taker: string;
  try {
    const body = await request.json();
    if (typeof body?.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
      return NextResponse.json({ error: "body.txHash must be a 32-byte hex string" }, { status: 400 });
    }
    txHash = body.txHash;
    taker = ethers.getAddress(body?.taker);
  } catch {
    return NextResponse.json({ error: "body.taker must be a valid EVM address" }, { status: 400 });
  }

  try {
    return NextResponse.json(await confirmTakerRfq(env, txHash, taker));
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
