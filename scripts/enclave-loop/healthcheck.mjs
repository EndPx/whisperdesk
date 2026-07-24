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
// this package — see package.json). No new deps, no build step.

import { ethers } from "ethers";

const EXT_PROXY_URL = (process.env.EXT_PROXY_URL || "https://fce.endpx.cloud").replace(/\/+$/, "");
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS || "0x20A885cb6ed3F652C5Fcb6a683CE74436F6a7023";
const COSTON2_RPC = process.env.COSTON2_RPC || "https://coston2-api.flare.network/ext/C/rpc";
const COSTON2_CHAIN_ID = 114;
const FETCH_TIMEOUT_MS = 15_000;

const DVP_ESCROW_ABI = ["function teeSigner() view returns (address)"];

// Known-good self-test vector — the live enclave signer from the Step-5 enclave-loop receipts
// (.claude/context/deployments.md, "enclave signer (verified by local ecrecover)"). Pinned here so
// `--selftest` can catch a broken derivation completely offline, without the live enclave being up.
const SELFTEST_X = "0x6fb495068b728329a5f8ad83cfd47ea04a812b6271799b8b06054b564f510e75";
const SELFTEST_Y = "0x9f837f467e20e9257a229903f4f99479c521b97b25b37cd0930f05a698c75f35";
const SELFTEST_EXPECTED_ADDRESS = "0x56564F61588bB110E0712c3938aDa4338e6cc18B";

/// Derives the enclave's Ethereum address from the raw secp256k1 X/Y coordinates GET /info returns
/// at teeInfo.publicKey.{x,y} — exactly what tee-node's ParsePubKey + go-ethereum's
/// crypto.PubkeyToAddress do server-side (scripts/enclave-loop/internal/teeclient/teeclient.go:48:
/// "address = crypto.PubkeyToAddress(ParsePubKey(teeInfo.publicKey)) = address(keccak256(X||Y)[12:])").
/// Builds the 65-byte uncompressed EC point (0x04 || X || Y) and lets ethers do the same
/// keccak256(X||Y)[12:] derivation via computeAddress — no reimplementation of the hash math here.
function deriveEnclaveAddress(xHex, yHex) {
  const x = ethers.getBytes(xHex);
  const y = ethers.getBytes(yHex);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error(
      `healthcheck: expected 32-byte X/Y coordinates, got X=${x.length}B Y=${y.length}B (malformed /info response)`
    );
  }
  const uncompressed = ethers.concat(["0x04", x, y]);
  return ethers.computeAddress(uncompressed);
}

function runSelftest() {
  let derived;
  try {
    derived = deriveEnclaveAddress(SELFTEST_X, SELFTEST_Y);
  } catch (err) {
    console.error(`SELFTEST FAIL: derivation threw: ${err.message}`);
    process.exit(3);
  }
  if (derived.toLowerCase() !== SELFTEST_EXPECTED_ADDRESS.toLowerCase()) {
    console.error(
      `SELFTEST FAIL: pubkey->address derivation broken. ` +
        `derived=${derived} expected=${SELFTEST_EXPECTED_ADDRESS}. ` +
        `ethers version or the X||Y->address math changed — do not trust this script's real-run ` +
        `output until this passes again.`
    );
    process.exit(3);
  }
  console.log(`SELFTEST OK: pubkey->address derivation verified (${derived}).`);
  process.exit(0);
}

async function fetchInfo(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/info`, { signal: controller.signal });
    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(`GET /info returned HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    }
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch (err) {
      throw new Error(`GET /info returned non-JSON body: ${err.message}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
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

  const x = info?.teeInfo?.publicKey?.x;
  const y = info?.teeInfo?.publicKey?.y;
  if (!x || !y) {
    console.error(
      `DOWN: /info responded but teeInfo.publicKey.{x,y} is missing/malformed. ` +
        `Got teeInfo.publicKey=${JSON.stringify(info?.teeInfo?.publicKey)}`
    );
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
    const provider = new ethers.JsonRpcProvider(COSTON2_RPC, COSTON2_CHAIN_ID);
    const escrow = new ethers.Contract(ESCROW_ADDRESS, DVP_ESCROW_ABI, provider);
    teeSigner = await escrow.teeSigner();
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
