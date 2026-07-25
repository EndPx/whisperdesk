#!/usr/bin/env node
// monitor.mjs — the ONE script the cron runs. Covers BOTH known ways the WhisperDesk enclave loop
// can silently break, so there is a single thing to install and a single log to read.
//
//   (1) teeSigner identity drift — the TEE identity key regenerates in memory on every
//       `extension-tee` restart (no persistence). DvPEscrow.teeSigner is checked against that
//       address on every lock(); if it goes stale, every lock() with an enclave signature reverts.
//       Same logic as healthcheck.mjs: derive the enclave address from /info's pubkey, compare to
//       escrow.teeSigner().
//
//   (2) TEE machine registration drift — the machine registered on-chain for our extension
//       (getRandomTeeIds) can point at a dead machine after a rebuild, silently dropping every
//       ONCHAIN-routed instruction. /direct is unaffected, and /info stays HTTP 200 throughout, so
//       nothing else notices. Same logic as onchain-ingress-readiness.mjs check A: getRandomTeeIds
//       (65641, 1) must contain the running enclave.
//
//   (3) Machine status / registered URL — per the Flare team's Coston2 FCC guidance, only
//       PRODUCTION machines are handed onchain instructions, and data providers PUSH to the
//       hostname stored on-chain. A machine stuck at INITIALIZED, or one whose stored URL has
//       drifted from what we serve, fails silently and is invisible to checks (1) and (2).
//
// Both checks share their pubkey->address derivation, /info fetch, and on-chain reads with
// healthcheck.mjs / onchain-ingress-readiness.mjs via scripts/enclave-loop/lib/enclave.mjs — see
// that file for the actual logic. This script only composes the two checks and reports.
//
// Usage:
//   node monitor.mjs             run both real checks against the live/env-configured deployment
//   node monitor.mjs --selftest  offline only: verify the pubkey->address derivation against a
//                                known-good vector, no network calls at all
//
// Env (all optional — defaults are the judge-facing live deployment):
//   EXT_PROXY_URL      default https://fce.endpx.cloud
//   ESCROW_ADDRESS     default 0x20A885cb6ed3F652C5Fcb6a683CE74436F6a7023  (enclave-loop escrow)
//   COSTON2_RPC        default https://coston2-api.flare.network/ext/C/rpc
//   FLARE_TEE_MANAGER  default 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE  (FlareTeeManager diamond)
//   EXT_ID             default 65641                                     (fce-extension id)
//
// Exit-code contract (greppable — mirrored in docs/enclave-deploy-checklist.md "Monitoring"):
//   0  OK       both checks pass
//   1  DRIFT    at least one check failed while the enclave itself was reachable — stderr names
//               exactly which check(s) drifted and prints the exact fix command for each
//   2  DOWN     enclave /info unreachable, non-200, malformed, or an RPC/contract read failed —
//               "could not even determine drift", distinct from a confirmed drift
//   3  SELFTEST only reachable via --selftest: the offline pubkey->address derivation itself broke
//
// Output is quiet on success: exactly one "OK <check>: ..." line per check, nothing else — a
// 15-minute cron will not fill the log with noise. On failure, every relevant line is prefixed
// DRIFT/UNREACHABLE so `grep -E 'DRIFT|UNREACHABLE'` finds it immediately.

import {
  DEFAULT_EXT_PROXY_URL,
  DEFAULT_ESCROW_ADDRESS,
  DEFAULT_COSTON2_RPC,
  DEFAULT_FLARE_TEE_MANAGER,
  DEFAULT_EXT_ID,
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchInfo,
  extractPublicKey,
  deriveEnclaveAddress,
  getEscrowTeeSigner,
  getRegisteredTeeIds,
  getTeeMachineState,
  selftestDeriveEnclaveAddress,
} from "./lib/enclave.mjs";

const EXT_PROXY_URL = (process.env.EXT_PROXY_URL || DEFAULT_EXT_PROXY_URL).replace(/\/+$/, "");
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS || DEFAULT_ESCROW_ADDRESS;
const COSTON2_RPC = process.env.COSTON2_RPC || DEFAULT_COSTON2_RPC;
const FLARE_TEE_MANAGER = process.env.FLARE_TEE_MANAGER || DEFAULT_FLARE_TEE_MANAGER;
const EXT_ID = process.env.EXT_ID ? BigInt(process.env.EXT_ID) : DEFAULT_EXT_ID;
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
  // Fetch /info ONCE and reuse it — both checks derive the live enclave address from the same
  // pubkey, no need to hit the enclave twice.
  let body;
  try {
    body = await fetchInfo(EXT_PROXY_URL, FETCH_TIMEOUT_MS);
  } catch (err) {
    console.error(`UNREACHABLE: enclave /info unreachable at ${EXT_PROXY_URL}/info — ${err.message}`);
    console.error(
      `UNREACHABLE: could not run either check because /info itself did not answer. ` +
        `Check the extension-tee / ext-proxy containers on the VPS (docker compose ps, logs).`
    );
    process.exit(2);
  }

  let x, y;
  try {
    ({ x, y } = extractPublicKey(body));
  } catch (err) {
    console.error(`UNREACHABLE: /info responded but ${err.message}`);
    process.exit(2);
  }

  let liveAddress;
  try {
    liveAddress = deriveEnclaveAddress(x, y);
  } catch (err) {
    console.error(`UNREACHABLE: could not derive an address from /info's pubkey — ${err.message}`);
    process.exit(2);
  }

  let drifted = false;

  // ---- check 1: teeSigner identity — does the escrow trust the running enclave's key? -----------
  try {
    const teeSigner = await getEscrowTeeSigner({ escrowAddress: ESCROW_ADDRESS, rpcUrl: COSTON2_RPC });
    if (liveAddress.toLowerCase() === teeSigner.toLowerCase()) {
      console.log(`OK teeSigner: enclave ${liveAddress} == escrow.teeSigner() ${teeSigner}`);
    } else {
      drifted = true;
      console.error(
        `DRIFT teeSigner: enclave signer != escrow.teeSigner() — the enclave's identity key ` +
          `rotated (container restart) and the escrow was never rebound.`
      );
      console.error(`DRIFT teeSigner: live enclave address (from ${EXT_PROXY_URL}/info) = ${liveAddress}`);
      console.error(`DRIFT teeSigner: escrow.teeSigner() (${ESCROW_ADDRESS} on Coston2)  = ${teeSigner}`);
      console.error(
        `DRIFT teeSigner: FIX — cast send <escrow-owner-key> ${ESCROW_ADDRESS} ` +
          `"setTeeSigner(address)" ${liveAddress} --rpc-url coston2 ` +
          `(see docs/enclave-deploy-checklist.md §5 "Escrow deploy + TEE_SIGNER wiring").`
      );
    }
  } catch (err) {
    console.error(
      `UNREACHABLE teeSigner: reading escrow.teeSigner() failed on ${COSTON2_RPC} for ` +
        `${ESCROW_ADDRESS} — ${err.message}`
    );
    process.exit(2);
  }

  // ---- check 2: machine registration — does getRandomTeeIds still route to THIS machine? --------
  try {
    const registered = await getRegisteredTeeIds({
      teeManagerAddress: FLARE_TEE_MANAGER,
      extId: EXT_ID,
      rpcUrl: COSTON2_RPC,
    });
    const machineOk = registered.some((a) => a.toLowerCase() === liveAddress.toLowerCase());
    if (machineOk) {
      console.log(`OK machine-registration: getRandomTeeIds(${EXT_ID},1) includes running enclave ${liveAddress}`);
    } else {
      drifted = true;
      const staleId = registered[0];
      console.error(
        `DRIFT machine-registration: getRandomTeeIds(${EXT_ID},1) = ` +
          `[${registered.length ? registered.join(", ") : "(none)"}] does NOT include the running ` +
          `enclave ${liveAddress}.`
      );
      console.error(
        `DRIFT machine-registration: ONCHAIN instructions are being silently dropped — routed to a ` +
          `dead machine (/info stays HTTP 200 the whole time, nothing else notices).`
      );
      console.error(
        `DRIFT machine-registration: FIX — pause the stale machine, then re-register the live one:`
      );
      console.error(
        `  node pause-stale-machine.mjs ${staleId ?? "<stale-teeId-from-getRandomTeeIds>"}` +
          `   # PRIVATE_KEY=<machine owner/pauser>`
      );
      console.error(`  ssh root@76.13.179.205 'cd /root/whisperdesk/fce-extension-scaffold && ./scripts/post-build.sh'`);
      console.error(
        `DRIFT machine-registration: see docs/enclave-deploy-checklist.md ` +
          `"Onchain RFQ ingress (submitRfq)" for the full runbook.`
      );
    }
  } catch (err) {
    console.error(
      `UNREACHABLE machine-registration: getRandomTeeIds read failed on ${COSTON2_RPC} for ` +
        `${FLARE_TEE_MANAGER} — ${err.message}`
    );
    process.exit(2);
  }

  // ---- check 3: machine status + registered URL --------------------------------------------------
  // Per the Flare team's Coston2 FCC guidance: only PRODUCTION machines are handed onchain
  // instructions, and data providers PUSH to whatever hostname is stored onchain. So a machine can
  // be registered and selectable yet still be skipped (stuck at INITIALIZED), or be PRODUCTION but
  // unreachable because the stored URL drifted from what we actually serve. Neither shows up in
  // checks 1-2, and neither shows up in /info.
  try {
    const state = await getTeeMachineState({
      teeId: liveAddress,
      teeManagerAddress: FLARE_TEE_MANAGER,
      rpcUrl: COSTON2_RPC,
    });

    if (state.isProduction) {
      console.log(`OK machine-status: ${liveAddress} is PRODUCTION (status 2)`);
    } else {
      drifted = true;
      console.error(
        `DRIFT machine-status: ${liveAddress} is ${state.statusName} (status ${state.status}), not ` +
          `PRODUCTION — only PRODUCTION machines receive onchain instructions.`
      );
      console.error(
        state.status === 1
          ? `DRIFT machine-status: INITIALIZED means registration started but the availability check ` +
              `never completed — usually a dead/changed registered URL, since data providers push to it.`
          : `DRIFT machine-status: the machine is not registered for this extension at all.`
      );
      console.error(
        `DRIFT machine-status: FIX — re-run registration: ` +
          `ssh root@76.13.179.205 'cd /root/whisperdesk/fce-extension-scaffold && ./scripts/post-build.sh'`
      );
    }

    // The URL is only meaningful once a machine exists; compare it to the proxy we actually serve.
    const registeredUrl = (state.url || "").replace(/\/+$/, "");
    if (state.status !== 0) {
      if (registeredUrl.toLowerCase() === EXT_PROXY_URL.toLowerCase()) {
        console.log(`OK machine-url: onchain URL ${registeredUrl} matches the proxy we serve`);
      } else {
        drifted = true;
        console.error(
          `DRIFT machine-url: onchain URL "${registeredUrl}" != the proxy we serve "${EXT_PROXY_URL}". ` +
            `Data providers push to the ONCHAIN value, so instructions go to the wrong host.`
        );
        console.error(
          `DRIFT machine-url: FIX — point EXT_PROXY_URL at the correct hostname and re-run ` +
            `post-build.sh so the registered URL is updated (docs/enclave-deploy-checklist.md).`
        );
      }
    }
  } catch (err) {
    console.error(
      `UNREACHABLE machine-status: getTeeMachineStatus/getTeeMachine read failed on ${COSTON2_RPC} ` +
        `for ${FLARE_TEE_MANAGER} — ${err.message}`
    );
    process.exit(2);
  }

  process.exit(drifted ? 1 : 0);
}

if (process.argv.includes("--selftest")) {
  runSelftest();
} else {
  main().catch((err) => {
    console.error(`monitor: unexpected error: ${err.stack || err.message}`);
    process.exit(2);
  });
}
