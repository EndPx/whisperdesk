// scripts/enclave-loop/lib/enclave.mjs — shared enclave <-> Coston2 identity/registration checks.
//
// Factored out of healthcheck.mjs and onchain-ingress-readiness.mjs so the pubkey->address
// derivation, the /info fetch, the escrow.teeSigner() read, and the getRandomTeeIds() read exist
// in exactly ONE place. monitor.mjs, healthcheck.mjs and onchain-ingress-readiness.mjs all import
// from here — none of them re-derive the enclave address independently anymore.
//
// Nothing in this module calls process.exit() or writes to console. It only computes and throws.
// Exit codes and console output are each caller script's own responsibility — see the header
// comments in monitor.mjs / healthcheck.mjs / onchain-ingress-readiness.mjs for their contracts,
// and docs/enclave-deploy-checklist.md "Monitoring" for the operator-facing version.

import { ethers } from "ethers";

// ---- defaults (the live judge-facing deployment) -------------------------------------------------
export const DEFAULT_EXT_PROXY_URL = "https://fce.endpx.cloud";
export const DEFAULT_ESCROW_ADDRESS = "0x20A885cb6ed3F652C5Fcb6a683CE74436F6a7023";
export const DEFAULT_COSTON2_RPC = "https://coston2-api.flare.network/ext/C/rpc";
export const COSTON2_CHAIN_ID = 114;
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_FLARE_TEE_MANAGER = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE"; // FlareTeeManager diamond
export const DEFAULT_EXT_ID = 65641n; // WhisperDesk fce-extension id

export const DVP_ESCROW_ABI = ["function teeSigner() view returns (address)"];
export const FLARE_TEE_MANAGER_ABI = [
  "function getRandomTeeIds(uint256,uint256) view returns (address[])",
];

// ---- selftest vector -----------------------------------------------------------------------------
// Pinned known-good X/Y -> address triple — the live enclave signer from the Step-5 enclave-loop
// receipts (.claude/context/deployments.md, "enclave signer (verified by local ecrecover)"). Lets
// --selftest catch a broken derivation completely offline, with no live enclave required.
export const SELFTEST_X = "0x6fb495068b728329a5f8ad83cfd47ea04a812b6271799b8b06054b564f510e75";
export const SELFTEST_Y = "0x9f837f467e20e9257a229903f4f99479c521b97b25b37cd0930f05a698c75f35";
export const SELFTEST_EXPECTED_ADDRESS = "0x56564F61588bB110E0712c3938aDa4338e6cc18B";

/// Derives the enclave's Ethereum address from the raw secp256k1 X/Y coordinates GET /info returns
/// at teeInfo.publicKey.{x,y} — exactly what tee-node's ParsePubKey + go-ethereum's
/// crypto.PubkeyToAddress do server-side (scripts/enclave-loop/internal/teeclient/teeclient.go:48:
/// "address = crypto.PubkeyToAddress(ParsePubKey(teeInfo.publicKey)) = address(keccak256(X||Y)[12:])").
/// Builds the 65-byte uncompressed EC point (0x04 || X || Y) and lets ethers do the same
/// keccak256(X||Y)[12:] derivation via computeAddress — no reimplementation of the hash math here.
export function deriveEnclaveAddress(xHex, yHex) {
  const x = ethers.getBytes(xHex);
  const y = ethers.getBytes(yHex);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error(
      `expected 32-byte X/Y coordinates, got X=${x.length}B Y=${y.length}B (malformed /info response)`
    );
  }
  const uncompressed = ethers.concat(["0x04", x, y]);
  return ethers.computeAddress(uncompressed);
}

/// Runs the offline derivation self-test against the pinned vector above. Returns a result object —
/// does NOT print or exit; callers (healthcheck.mjs, monitor.mjs) decide how to report it, so each
/// script's own --selftest output can keep its own wording/exit code.
export function selftestDeriveEnclaveAddress() {
  try {
    const derived = deriveEnclaveAddress(SELFTEST_X, SELFTEST_Y);
    return {
      pass: derived.toLowerCase() === SELFTEST_EXPECTED_ADDRESS.toLowerCase(),
      derived,
      expected: SELFTEST_EXPECTED_ADDRESS,
    };
  } catch (err) {
    return { pass: false, derived: null, expected: SELFTEST_EXPECTED_ADDRESS, error: err };
  }
}

/// Fetches and JSON-parses GET {extProxyUrl}/info. Throws on network error, timeout, non-2xx, or
/// non-JSON body — the thrown Error's .message is safe to print directly (already includes the
/// HTTP status / a body snippet where relevant). Returns the FULL parsed body (i.e. body.teeInfo
/// is the TEE info block) — does not interpret it, that's extractPublicKey's job.
export async function fetchInfo(extProxyUrl, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${extProxyUrl}/info`, { signal: controller.signal });
    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(`GET /info returned HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    }
    try {
      return JSON.parse(bodyText);
    } catch (err) {
      throw new Error(`GET /info returned non-JSON body: ${err.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/// Pulls teeInfo.publicKey.{x,y} out of a parsed /info body (as returned by fetchInfo). Throws if
/// missing/malformed.
export function extractPublicKey(info) {
  const x = info?.teeInfo?.publicKey?.x;
  const y = info?.teeInfo?.publicKey?.y;
  if (!x || !y) {
    throw new Error(
      `teeInfo.publicKey.{x,y} is missing/malformed. Got teeInfo.publicKey=${JSON.stringify(info?.teeInfo?.publicKey)}`
    );
  }
  return { x, y };
}

/// Reads DvPEscrow.teeSigner() on Coston2 — the address the escrow currently trusts for lock().
export async function getEscrowTeeSigner({
  escrowAddress = DEFAULT_ESCROW_ADDRESS,
  rpcUrl = DEFAULT_COSTON2_RPC,
} = {}) {
  const provider = new ethers.JsonRpcProvider(rpcUrl, COSTON2_CHAIN_ID);
  const escrow = new ethers.Contract(escrowAddress, DVP_ESCROW_ABI, provider);
  return escrow.teeSigner();
}

/// Reads FlareTeeManager.getRandomTeeIds(extId, 1) on Coston2 — the machine(s) currently routed
/// onchain instructions for our extension. An extension with no usable machine can revert here;
/// that is treated as "none registered" (an empty array), not as a transport error.
export async function getRegisteredTeeIds({
  teeManagerAddress = DEFAULT_FLARE_TEE_MANAGER,
  extId = DEFAULT_EXT_ID,
  rpcUrl = DEFAULT_COSTON2_RPC,
} = {}) {
  const provider = new ethers.JsonRpcProvider(rpcUrl, COSTON2_CHAIN_ID);
  const registry = new ethers.Contract(teeManagerAddress, FLARE_TEE_MANAGER_ABI, provider);
  try {
    return await registry.getRandomTeeIds(extId, 1n);
  } catch {
    return [];
  }
}
