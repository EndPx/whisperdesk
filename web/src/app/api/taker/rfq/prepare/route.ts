// GET /api/taker/rfq/prepare — the bounds a taker's own order has to satisfy.
//
// This route used to hand back a fixed deposit amount, because the desk wrote every RFQ itself and
// the taker supplied only an address. Sealing an order the venue authored still protects it from
// the maker, which is the part that matters commercially — but it makes "the desk cannot read your
// order" a hollow sentence. So the desk stopped writing orders. It publishes the constraints; the
// taker writes the order inside them.
//
// A GET, because nothing here is a side effect: it reads MIN_BLOCK_FXRP and BAND_BIPS off the
// escrow and the mid off FTSOv2. The client sizes its own approve and deposit from the answer, so
// an order never has to round-trip through the desk twice before it is sealed.
import { NextResponse } from "next/server";
import { buildTakerRfqTerms } from "@/lib/demo/maker";
import { getMakerEnv } from "@/lib/demo/makerEnv";
import { errMessage } from "@/lib/demo/http";

export const runtime = "nodejs";

export async function GET() {
  const env = getMakerEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  try {
    return NextResponse.json(await buildTakerRfqTerms(env));
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
