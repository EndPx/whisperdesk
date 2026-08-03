// Is the onchain RFQ instruction path ready to work end-to-end yet?
//
// Two things must be true. Both are checked live; nothing is assumed.
//
//   A. The TEE machine registered for our extension must be the one actually running. The TEE
//      identity key regenerates on every enclave boot, so a rebuild silently orphans the
//      registration and onchain instructions get routed to a machine that no longer exists.
//      (/direct is unaffected — it bypasses machine routing, which is why the demo keeps working.)
//
//   B. The proxy's signing policy must be in sync with the on-chain reward epoch. register-tee's
//      availability check (step "a") needs data providers to cosign an instruction tied to the
//      current policy; if the proxy is waiting on a policy that has not been published, that cosign
//      is rejected and the FDC proof never materialises.
//
// Exit 0 = ready (prints the exact command to run), 1 = not ready yet, 2 = could not determine.
//
// Check A's pubkey->address derivation and getRandomTeeIds() read are shared with monitor.mjs and
// healthcheck.mjs via scripts/enclave-loop/lib/enclave.mjs — do not reimplement them here.
import { ethers } from "ethers";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_FLARE_TEE_MANAGER,
  fetchInfo,
  extractPublicKey,
  deriveEnclaveAddress,
  getRegisteredTeeIds,
} from "./lib/enclave.mjs";

const RPC = process.env.COSTON2_RPC ?? "https://coston2-api.flare.network/ext/C/rpc";
const EXT_PROXY = process.env.EXT_PROXY_URL ?? "https://fce.endpx.cloud";
const DIAMOND = DEFAULT_FLARE_TEE_MANAGER; // FlareTeeManager
const FSM = "0xA90Db6D10F856799b10ef2A77EBCbF460aC71e52"; // FlareSystemsManager
const EXT_ID = 65641n;

const provider = new ethers.JsonRpcProvider(RPC, 114);

let body;
try {
  body = await fetchInfo(EXT_PROXY, DEFAULT_FETCH_TIMEOUT_MS);
} catch (err) {
  console.error(`DOWN: cannot reach ${EXT_PROXY}/info — ${err.message}`);
  process.exit(2);
}
const info = body.teeInfo;

// --- A. is the running enclave the machine that is registered? --------------------------------
const { x, y } = extractPublicKey(body);
const liveTeeId = deriveEnclaveAddress(x, y);

const registered = await getRegisteredTeeIds({ teeManagerAddress: DIAMOND, extId: EXT_ID, rpcUrl: RPC });
const machineOk = registered.some((a) => a.toLowerCase() === liveTeeId.toLowerCase());

console.log("A. TEE machine registration");
console.log(`   running enclave : ${liveTeeId}`);
console.log(`   registered      : ${registered.length ? registered.join(", ") : "(none)"}`);
console.log(`   -> ${machineOk ? "OK" : "STALE — onchain instructions route to a dead machine"}`);

// --- B. is the signing policy in sync? ---------------------------------------------------------
const fsm = new ethers.Contract(
  FSM,
  [
    "function getCurrentRewardEpochId() view returns (uint24)",
    "function rewardEpochDurationSeconds() view returns (uint64)",
    "function firstRewardEpochStartTs() view returns (uint64)",
  ],
  provider
);
const [epochOnchain, duration, firstStart, block] = await Promise.all([
  fsm.getCurrentRewardEpochId(),
  fsm.rewardEpochDurationSeconds(),
  fsm.firstRewardEpochStartTs(),
  provider.getBlock("latest"),
]);
const lastPolicy = BigInt(info.lastSigningPolicyId);
const policyOk = lastPolicy >= BigInt(epochOnchain);

console.log("\nB. Signing policy / reward epoch");
console.log(`   onchain reward epoch      : ${epochOnchain}`);
console.log(`   enclave lastSigningPolicy : ${lastPolicy}`);
console.log(`   -> ${policyOk ? "IN SYNC" : "WAITING — the proxy needs the next policy published"}`);

if (!policyOk) {
  const next = BigInt(epochOnchain) + 1n;
  const startTs = BigInt(firstStart) + next * BigInt(duration);
  const eta = Number(startTs) - block.timestamp;
  console.log(
    `   next epoch ${next} starts ~${new Date(Number(startTs) * 1000).toISOString()}` +
      (eta > 0 ? ` (~${Math.round(eta / 60)} min away)` : " (due now)")
  );
  console.log("   (estimate: assumes no epoch drift)");
}

// --- verdict ------------------------------------------------------------------------------------
console.log("");
if (machineOk && policyOk) {
  console.log("READY — the onchain instruction path should work end to end.");
  process.exit(0);
}
if (!policyOk) {
  console.log("NOT READY — wait for the reward epoch above, then re-run this check.");
  console.log("register-tee's availability step cannot pass until the policy is in sync.");
  process.exit(1);
}
console.log("NOT READY — policy is fine, but the machine registration is stale.");
console.log("Re-register the running enclave (operator step — pauses routing briefly):");
console.log("  ssh root@76.13.179.205");
console.log("  cd /root/whisperdesk/fce-extension-scaffold && ./scripts/post-build.sh");
console.log("Then confirm getRandomTeeIds returns the running enclave, and re-run this check.");
process.exit(1);
