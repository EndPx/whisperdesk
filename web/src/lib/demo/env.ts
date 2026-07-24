// env.ts — reads the demo console's server-side env with fallbacks, so this app can either define
// its own DEMO_* vars or reuse the repo-root e2e vars (scripts/e2e/config.mjs) verbatim.
//
// Every route handler under src/app/api/demo/**/route.ts MUST call getDemoEnv()/isDemoEnabled()
// FIRST and return 503 {enabled:false} when it's null — never assume the demo is configured.
//
// SECURITY: this module reads private keys and an XRPL seed. NEVER log, echo, JSON.stringify, or
// otherwise return any of ownerPrivateKey / takerPrivateKey / makerPrivateKey / xrplMakerSeed
// (or the raw error thrown while parsing them) to a caller or to the console.
import { ethers } from "ethers";

export const COSTON2_RPC_DEFAULT = "https://coston2-api.flare.network/ext/C/rpc";

function pick(...names: string[]): string | undefined {
  for (const name of names) {
    const v = process.env[name];
    if (v) return v;
  }
  return undefined;
}

export interface DemoEnv {
  ownerPrivateKey: string;
  takerPrivateKey: string;
  makerPrivateKey: string;
  xrplMakerSeed: string;
  xrplTakerAddress: string;
  escrowAddress: string;
  coston2Rpc: string;
}

/// Reads and validates the full demo env. Returns null (never throws) if DEMO_ENABLED isn't
/// exactly "true" or any required var is missing — routes turn a null return into
/// 503 {enabled:false}.
export function getDemoEnv(): DemoEnv | null {
  if (process.env.DEMO_ENABLED !== "true") return null;

  const ownerPrivateKey = pick("DEMO_OWNER_PRIVATE_KEY", "PRIVATE_KEY");
  const takerPrivateKey = pick("DEMO_TAKER_PRIVATE_KEY", "TAKER_PRIVATE_KEY");
  const makerPrivateKey = pick("DEMO_MAKER_PRIVATE_KEY", "MAKER_PRIVATE_KEY");
  const xrplMakerSeed = pick("DEMO_XRPL_MAKER_SEED", "XRPL_MAKER_SEED");
  const xrplTakerAddress = pick("DEMO_XRPL_TAKER_ADDRESS", "XRPL_TAKER_ADDRESS");
  const escrowAddress = pick("DEMO_ESCROW_ADDRESS", "ESCROW_ADDRESS");
  const coston2Rpc = process.env.COSTON2_RPC || COSTON2_RPC_DEFAULT;

  if (
    !ownerPrivateKey ||
    !takerPrivateKey ||
    !makerPrivateKey ||
    !xrplMakerSeed ||
    !xrplTakerAddress ||
    !escrowAddress
  ) {
    return null;
  }

  return {
    ownerPrivateKey,
    takerPrivateKey,
    makerPrivateKey,
    xrplMakerSeed,
    xrplTakerAddress,
    escrowAddress,
    coston2Rpc,
  };
}

export function isDemoEnabled(): boolean {
  return getDemoEnv() !== null;
}

/// Wraps `new ethers.Wallet(privateKey, provider)` so a malformed key never surfaces the raw key
/// material (or a substring of it) in a thrown error message that a route might forward to the
/// client — it throws a sanitized error instead.
export function createDemoWallet(privateKey: string, provider: ethers.Provider, label: string): ethers.Wallet {
  try {
    return new ethers.Wallet(privateKey, provider);
  } catch {
    throw new Error(`demo/env: ${label} private key is invalid or malformed (value redacted)`);
  }
}
