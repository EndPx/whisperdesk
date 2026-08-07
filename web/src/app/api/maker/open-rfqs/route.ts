// GET /api/maker/open-rfqs — the shared queue of sealed RFQs currently open for quoting.
//
// This is the route that lets two makers meet. Until now every maker session opened its own RFQ and
// quoted it alone, so "several makers competing on one sealed RFQ" was a property of the matcher
// proven only by unit tests. With a shared queue a second browser can quote the SAME rfqId a first
// browser opened, and the enclave picks between them on price — live, with two independent wallets.
//
// DISCLOSURE: deliberately returns the id and the window deadline and nothing else. Not the side,
// size, limit or taker — those never leave the enclave — and not a count of rival quotes, which is
// exactly what would let a maker shade a price against a competitor they cannot otherwise see.
import { NextResponse } from "next/server";
import { getMakerEnv } from "@/lib/demo/makerEnv";
import { listOpenRfqs } from "@/lib/demo/maker";

export const runtime = "nodejs";

export async function GET() {
  const env = getMakerEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  // windowEndsAt is epoch seconds, straight from the enclave's RfqAck — the client renders the
  // countdown, so no formatted date is invented on this side.
  return NextResponse.json({ rfqs: listOpenRfqs() });
}
