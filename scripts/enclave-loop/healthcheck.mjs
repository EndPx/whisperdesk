#!/usr/bin/env node
// healthcheck.mjs — enclave <-> escrow identity health check for WhisperDesk.
//
// WHY THIS EXISTS (verified failure mode, not a hypothetical):
// tee-node/internal/node/node.go's Initialize() calls crypto.GenerateKey() to mint a fresh
// in-memory ECDSA keypair on EVERY process start of `extension-tee` — no persistence, no volume,
// no seed (confirmed by Flare's own design docs; see docs/enclave-deploy-checklist.md §0.1 and
// docs/design.md §3.11: "TEE machines are stateless; the identity key regenerates on every boot").
// DvPEscrow.teeSigner is checked against that address on every lock(). So if the VPS reboots (or
// the extension-tee container restarts for any reason — OOM kill, host patch, docker daemon
// restart) between now and judging, the enclave loop dies SILENTLY: /info still returns 200, the
// site still loads, but every lock() with an enclave signature reverts (teeSigner mismatch).
// Nobody would notice until a judge tried the live demo. This script is the difference between
// finding that out in a 15-minute cron vs. finding it out live in front of a judge.
//
// NOTE: this is ONE of two independent ways the enclave loop can silently break — the other is the
// registered TEE *machine* going stale (getRandomTeeIds routes onchain instructions to a dead
// machine; see onchain-ingress-readiness.mjs). This script only covers the teeSigner identity
// check. `monitor.mjs` in this same directory runs BOTH checks and is what the cron should install
// going forward — see docs/enclave-deploy-checklist.md "Monitoring". This script is kept standalone
// (same CLI, same exit codes) because it's still referenced directly from docs and may still be
// wired into cron on older deployments.
//
// Usage:
//   node healthcheck.mjs                 run the real check against EXT_PROXY_URL / ESCROW_ADDRESS
//   node healthcheck.mjs --selftest      offline only: verify the pubkey->address derivation
//                                        against a known-good vector, no network calls at all
//
// Env (all optional — defaults are the judge-facing live deployment):
//   EXT_PROXY_URL   default https://fce.endpx.cloud
//   ESCROW_ADDRESS  default 0x20A885cb6ed3F652C5Fcb6a683CE74436F6a7023  (enclave-loop escrow)
//   COSTON2_RPC     default https://coston2-api.flare.network/ext/C/rpc
//
// Exit-code contract (greppable — mirrored in docs/enclave-deploy-checklist.md "Monitoring"):
//   0  OK        /info reachable AND derived enclave address == escrow.teeSigner()
//   1  DRIFT     /info reachable AND escrow reachable, but the two addresses DO NOT match
//                (the enclave key rotated and nobody re-ran setTeeSigner — fix: deploy checklist §5)
//   2  DOWN      /info unreachable, non-200, or malformed — "enclave down/broken", distinguishable
//                from a key rotation because we couldn't even derive an address to compare
//   3  SELFTEST  only reachable via --selftest: the offline pubkey->address derivation check
//                itself failed (means ethers or this script's math broke, not a deployment issue)
//
// Deliberately dependency-light: pure node (global fetch, Node >=18) + ethers (already a dep of
// this package — see package.json) + scripts/enclave-loop/lib/enclave.mjs (the shared derivation /
// fetch / on-chain read logic — also used by monitor.mjs and onchain-ingress-readiness.mjs). No new
// deps, no build step.

import {
  DEFAULT_EXT_PROXY_URL,
  DEFAULT_ESCROW_ADDRESS,
  DEFAULT_COSTON2_RPC,
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchInfo,
  extractPublicKey,
  deriveEnclaveAddress,
  getEscrowTeeSigner,
  selftestDeriveEnclaveAddress,
} from "./lib/enclave.mjs";

const EXT_PROXY_URL = (process.env.EXT_PROXY_URL || DEFAULT_EXT_PROXY_URL).replace(/\/+$/, "");
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS || DEFAULT_ESCROW_ADDRESS;
const COSTON2_RPC = process.env.COSTON2_RPC || DEFAULT_COSTON2_RPC;
const FETCH_TIMEOUT_MS = DEFAULT_FETCH_TIMEOUT_MS;

function runSelftest() {
  const { pass, derived, expected, error } = selftestDeriveEnclaveAddress();
  if (!pass) {
    console.error(
      `SELFTEST FAIL: pubkey->address derivation broken. ` +
        `derived=${derived ?? `(threw: ${error?.message ?? "unknown error"})`} expected=${expected}. ` +
        `ethers version or the X||Y->address math changed — do not trust this script's real-run ` +
        `output until this passes again.`
    );
    process.exit(3);
  }
  console.log(`SELFTEST OK: pubkey->address derivation verified (${derived}).`);
  process.exit(0);
}

async function main() {
  console.log(`healthcheck: EXT_PROXY_URL=${EXT_PROXY_URL} ESCROW_ADDRESS=${ESCROW_ADDRESS} COSTON2_RPC=${COSTON2_RPC}`);

  // 1. Enclave reachability + pubkey extraction.
  let info;
  try {
    info = await fetchInfo(EXT_PROXY_URL, FETCH_TIMEOUT_MS);
  } catch (err) {
    console.error(`DOWN: enclave /info unreachable at ${EXT_PROXY_URL}/info — ${err.message}`);
    console.error(
      `DOWN: cannot tell whether the key rotated because /info itself did not answer. ` +
        `Check the extension-tee / ext-proxy containers on the VPS (docker compose ps, logs).`
    );
    process.exit(2);
  }

  let x, y;
  try {
    ({ x, y } = extractPublicKey(info));
  } catch (err) {
    console.error(`DOWN: /info responded but ${err.message}`);
    process.exit(2);
  }

  let enclaveAddress;
  try {
    enclaveAddress = deriveEnclaveAddress(x, y);
  } catch (err) {
    console.error(`DOWN: could not derive an address from /info's pubkey — ${err.message}`);
    process.exit(2);
  }

  // 2. Escrow's on-chain teeSigner.
  let teeSigner;
  try {
    teeSigner = await getEscrowTeeSigner({ escrowAddress: ESCROW_ADDRESS, rpcUrl: COSTON2_RPC });
  } catch (err) {
    console.error(
      `DOWN: enclave /info was reachable (derived ${enclaveAddress}), but reading ` +
        `escrow.teeSigner() failed on ${COSTON2_RPC} for ${ESCROW_ADDRESS} — ${err.message}`
    );
    process.exit(2);
  }

  // 3. Compare.
  if (enclaveAddress.toLowerCase() === teeSigner.toLowerCase()) {
    console.log(`OK: enclave address ${enclaveAddress} == escrow.teeSigner() ${teeSigner}`);
    process.exit(0);
  }

  console.error(
    `DRIFT: enclave signer != escrow.teeSigner() — the enclave's identity key rotated ` +
      `(container restart) and the escrow was never rebound.`
  );
  console.error(`DRIFT: live enclave address (from ${EXT_PROXY_URL}/info) = ${enclaveAddress}`);
  console.error(`DRIFT: escrow.teeSigner() (${ESCROW_ADDRESS} on Coston2)  = ${teeSigner}`);
  console.error(
    `DRIFT: FIX — re-run setTeeSigner with the NEW enclave address. See ` +
      `docs/enclave-deploy-checklist.md §5 ("Escrow deploy + TEE_SIGNER wiring") for the exact ` +
      `cast send <escrow-owner-key> ${ESCROW_ADDRESS} "setTeeSigner(address)" ${enclaveAddress} --rpc-url coston2 ` +
      `command and the full rebind runbook (register-tee -command rRap, then setTeeSigner).`
  );
  process.exit(1);
}

if (process.argv.includes("--selftest")) {
  runSelftest();
} else {
  main().catch((err) => {
    console.error(`healthcheck: unexpected error: ${err.stack || err.message}`);
    process.exit(2);
  });
}
