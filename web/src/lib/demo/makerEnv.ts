// makerEnv.ts — maker-mode-specific env, layered ON TOP of (never modifying) env.ts's getDemoEnv().
//
// Why a separate file instead of adding fields to env.ts's DemoEnv: /api/demo/* and /api/wallet/*
// gate on getDemoEnv()/isDemoEnabled() and must keep working exactly as they do today even if a
// maker-mode-only var (e.g. DIRECT_API_KEY) is unset on some deployment. Folding maker-only
// requirements into getDemoEnv() would make those routes 503 for a reason that has nothing to do
// with them. So: getMakerEnv() calls getDemoEnv() first (all its fields — owner/taker keys, escrow
// address, XRPL taker address — are reused verbatim, see maker.ts), then additionally requires the
// maker-only fields below. Missing either layer returns null, same 503 {enabled:false} contract as
// isDemoEnabled().
//
// SECURITY: DIRECT_API_KEY gates POST /direct on the tee-proxy (extension/fcewire/PROTOCOL.md §1.1)
// — treat it like the private keys in env.ts: never log, echo, or return it to a caller.
import { getDemoEnv, type DemoEnv } from "./env";

export interface MakerEnv extends DemoEnv {
  /** tee-proxy base URL (design.md §6.5) — no trailing slash. */
  extProxyUrl: string;
  /** POST /direct's X-API-Key (extension/fcewire/PROTOCOL.md §1.1) — required secret, no fallback. */
  directApiKey: string;
  /** WhisperDeskInstructionSender (contracts/src/WhisperDeskInstructionSender.sol) — a deployed,
   *  public contract address, not a secret; defaults to the live Coston2 deployment (matches
   *  scripts/enclave-loop/onchain-loop.mjs's own default), overridable per-deployment via env. */
  senderAddress: string;
  /** Path to (or bare name, resolved via PATH) the compiled wd-client binary
   *  (scripts/enclave-loop/cmd/wd-client) — see wdClient.ts for why the server shells out to it. */
  wdClientBin: string;
  /** wei value forwarded on submitRfq()/triggerMatch() calls — matches the scaffold's own sender
   *  convention (see onchain-loop.mjs's RELAY_FEE comment: "same value the scaffold's own sender
   *  uses"). Overridable in case the registry's actual relay cost ever changes. */
  relayFeeWei: bigint;
}

const DEFAULT_EXT_PROXY_URL = "https://fce.endpx.cloud";
const DEFAULT_SENDER_ADDRESS = "0x56A903F408C4745D34354Ec230BbfBDD78eC6426";
const DEFAULT_WD_CLIENT_BIN = "wd-client";
const DEFAULT_RELAY_FEE_WEI = BigInt(1_000_000);

/// Maker mode runs THROUGH THE ENCLAVE, so it must use the enclave-loop escrow — not the escrow
/// /api/demo/* uses. Two independent reasons, both fatal if ignored:
///   1. The enclave verifies the maker's EIP-712 Quote with `verifyingContract` = its own
///      WD_ESCROW_ADDR. A signature over any other escrow is rejected WD_ERR_AUTH.
///   2. Only this escrow's teeSigner IS the live enclave, so only here does lock() accept an
///      enclave-signed MatchInstruction. The demo escrow's teeSigner is the deployer key.
/// Keep this in sync with WD_ESCROW_ADDR in the enclave's own .env on the VPS.
const DEFAULT_MAKER_ESCROW_ADDRESS = "0x20A885cb6ed3F652C5Fcb6a683CE74436F6a7023";

/// Reads getDemoEnv() plus the maker-only vars. Returns null (never throws) if the base demo env is
/// unconfigured OR DIRECT_API_KEY is missing — routes turn a null return into 503 {enabled:false},
/// same contract as isDemoEnabled().
export function getMakerEnv(): MakerEnv | null {
  const base = getDemoEnv();
  if (!base) return null;

  const directApiKey = process.env.DIRECT_API_KEY;
  if (!directApiKey) return null;

  const extProxyUrl = (process.env.EXT_PROXY_URL || DEFAULT_EXT_PROXY_URL).replace(/\/+$/, "");
  const senderAddress = process.env.WD_SENDER_ADDRESS || DEFAULT_SENDER_ADDRESS;
  const wdClientBin = process.env.WD_CLIENT_BIN || DEFAULT_WD_CLIENT_BIN;
  const relayFeeWeiRaw = process.env.WD_RELAY_FEE_WEI;
  let relayFeeWei = DEFAULT_RELAY_FEE_WEI;
  if (relayFeeWeiRaw) {
    try {
      relayFeeWei = BigInt(relayFeeWeiRaw);
    } catch {
      return null; // malformed override — fail closed rather than submit with a garbage value.
    }
  }

  // Override the base escrow: maker mode settles on the enclave-loop instance (see the constant's
  // comment above). Everything downstream reads env.escrowAddress, so overriding it here is enough.
  const escrowAddress =
    process.env.MAKER_ESCROW_ADDRESS || process.env.WD_ESCROW_ADDR || DEFAULT_MAKER_ESCROW_ADDRESS;

  return { ...base, escrowAddress, extProxyUrl, directApiKey, senderAddress, wdClientBin, relayFeeWei };
}

export function isMakerEnabled(): boolean {
  return getMakerEnv() !== null;
}
