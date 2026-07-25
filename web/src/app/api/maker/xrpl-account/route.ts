// POST /api/maker/xrpl-account — generates a fresh, throwaway XRPL testnet account for the maker
// (judge) to pay FROM, funded via the XRPL testnet faucet. The seed is returned so it is genuinely
// theirs (testnet only) — see generateAndFundXrplAccount() in wallet-mode.ts. Also recorded
// server-side (maker.ts's currentMakerXrplAccount) so a subsequent POST /api/maker/pay — which per
// the fixed API contract takes only {matchId}, no address/seed — knows which account to pay from.
import { NextResponse } from "next/server";
import { errMessage } from "@/lib/demo/http";
import { generateAndFundXrplAccount, setCurrentMakerXrplAccount } from "@/lib/demo/maker";
import { getMakerEnv } from "@/lib/demo/makerEnv";
import { checkAndConsume, clientIpFromHeaders } from "@/lib/demo/ratelimit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = getMakerEnv();
  if (!env) {
    return NextResponse.json({ enabled: false }, { status: 503 });
  }

  const ip = clientIpFromHeaders(request.headers);
  const limit = checkAndConsume("maker-xrpl-account", ip);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "maker-mode rate limit hit for this deployment — try again later", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429 }
    );
  }

  try {
    const account = await generateAndFundXrplAccount();
    setCurrentMakerXrplAccount(account);
    return NextResponse.json({ address: account.address, seed: account.seed, funded: true });
  } catch (err) {
    return NextResponse.json({ error: errMessage(err) }, { status: 500 });
  }
}
