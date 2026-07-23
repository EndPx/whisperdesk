// config.mjs — shared config for the Step 5 E2E runners (happy-path.mjs, default-path.mjs).
//
// Loads .env from the repo root: scripts load .env at runtime via `dotenv/config`, which
// automatically honors `process.env.DOTENV_CONFIG_PATH` if the caller sets it (no code needed
// here). Run these scripts either from a shell that has already `cd`'d to the repo root (so the
// default `.env` lookup in the current working directory finds it), or with:
//   DOTENV_CONFIG_PATH=/absolute/path/to/repo/.env node happy-path.mjs ...
//
// Reuses the Step 2 FDC spike harness's pinned Coston2 addresses/endpoints
// (scripts/fdc-spike/config.mjs) as the single source of truth for the FDC Hub / DA layer / fee
// config addresses — see that file's header comment for how those were resolved live from the
// FlareContractRegistry. This is a plain relative file import (not a package import), so it works
// without scripts/fdc-spike's own node_modules being on this package's module resolution path.
import "dotenv/config";
import { fileURLToPath } from "node:url";
import {
  ABI,
  COSTON2_CHAIN_ID,
  COSTON2_RPC_DEFAULT,
  DA_LAYER_API_KEY,
  DA_LAYER_BASE_URL,
  DA_LAYER_PROOF_PATH,
  FDC_HUB_ADDRESS,
  FDC_REQUEST_FEE_CONFIGURATIONS_ADDRESS,
  FDC_VERIFIER_API_KEY,
  FDC_VERIFIER_BASE_URL,
  FDC_VERIFIER_PREPARE_PATH,
  FDC_VERIFICATION_ADDRESS,
  FLARE_SYSTEMS_MANAGER_ADDRESS,
  REGISTRY_ADDRESS,
  VOTING_EPOCH_DURATION_SECONDS,
} from "../fdc-spike/config.mjs";

export {
  ABI,
  COSTON2_CHAIN_ID,
  DA_LAYER_API_KEY,
  DA_LAYER_BASE_URL,
  DA_LAYER_PROOF_PATH,
  FDC_HUB_ADDRESS,
  FDC_REQUEST_FEE_CONFIGURATIONS_ADDRESS,
  FDC_VERIFIER_API_KEY,
  FDC_VERIFIER_BASE_URL,
  FDC_VERIFIER_PREPARE_PATH,
  FDC_VERIFICATION_ADDRESS,
  FLARE_SYSTEMS_MANAGER_ADDRESS,
  REGISTRY_ADDRESS,
  VOTING_EPOCH_DURATION_SECONDS,
};

export const COSTON2_RPC = process.env.COSTON2_RPC || COSTON2_RPC_DEFAULT;
export const XRPL_TESTNET_WSS = process.env.XRPL_TESTNET_WSS || "wss://s.altnet.rippletest.net:51233";

export const OUT_DIR = new URL("./out/", import.meta.url);

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name} (set it in the repo-root .env, or export it, or pass ` +
        `DOTENV_CONFIG_PATH=/path/to/.env)`
    );
  }
  return v;
}

/// CLI arg takes precedence over the ESCROW_ADDRESS env var, e.g.:
///   node happy-path.mjs 0xDeadBeef...
export function getEscrowAddress() {
  const argAddr = process.argv.slice(2).find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  const addr = argAddr || process.env.ESCROW_ADDRESS;
  if (!addr) {
    throw new Error(
      "Missing escrow address: pass it as a CLI arg (0x...) or set ESCROW_ADDRESS in the " +
        "environment. Deploy one with: forge script script/DeployIntegration.s.sol --rpc-url " +
        "coston2 --broadcast"
    );
  }
  return addr;
}

export function hasHelpFlag() {
  return process.argv.slice(2).some((a) => a === "--help" || a === "-h");
}

/// Prints `usage` and exits 0 if --help/-h was passed. Call this BEFORE requireEnv() calls so
/// `node <script>.mjs --help` works even with no .env configured at all — this is the "does it
/// compile / --help works" dry-check this harness is designed to satisfy without touching any
/// live network.
export function maybePrintHelpAndExit(usage) {
  if (hasHelpFlag()) {
    console.log(usage);
    process.exit(0);
  }
}

export function isMainModule(importMetaUrl) {
  return process.argv[1] === fileURLToPath(importMetaUrl);
}
