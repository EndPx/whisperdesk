// POST /api/maker/pay — pays the real XRPL leg from the maker's own throwaway account (created by
// POST /api/maker/xrpl-account). destination/xrpDrops/destinationTag come ONLY from the server-side
// record /api/maker/match wrote (maker.ts's getMatchRecord) — never from this request's body.
import { NextResponse } from "next/server";
import { errMessage } from "@/lib/demo/http";
import { payFromMakerAccount } from "@/lib/demo/maker";
import { getMakerEnv } from "@/lib/demo/makerEnv";
import { checkAndConsume, clientIpFromHeaders } from "@/lib/demo/ratelimit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getMakerEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  // Abuse guard, own budget — submits a real XRPL transaction from this server's infra on every
  // call (even though the funds themselves are the maker's own throwaway account).
  const ip = clientIpFromHeaders(request.headers);
  const limit = checkAndConsume("maker-pay", ip);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "maker-mode rate limit hit for this deployment — try again later", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429 }
    );
  }

  let matchId: string;
  try {
    const body = await request.json();
    if (typeof body?.matchId !== "string" || !body.matchId) {
      return NextResponse.json({ error: "body.matchId (string) is required" }, { status: 400 });
    }
    matchId = body.matchId;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await payFromMakerAccount(matchId);
    return NextResponse.json(result);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const status = code === "UNKNOWN_MATCH" ? 404 : code === "NO_ACCOUNT" ? 400 : 500;
    return NextResponse.json({ error: errMessage(err) }, { status });
  }
}
