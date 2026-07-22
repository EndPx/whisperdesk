// dry-validate.mjs — Step 2 phase-1 checks that need NO fresh XRPL payment:
//  1. sourceId/attestationType bytes32 encoding matches flare-docs/fdc-sourceid-xrpl-testnet.md
//  2. prepareRequest + getRequestFee work end-to-end for a well-formed request (using a real,
//     already-final XRPL testnet tx hash so the verifier can actually resolve it)
//  3. the deployed FdcXrpVerifier is callable on Coston2 (view calls succeed, no revert)
import "dotenv/config";
import { ethers } from "ethers";
import {
  ABI,
  COSTON2_RPC_DEFAULT,
  FDC_REQUEST_FEE_CONFIGURATIONS_ADDRESS,
  FDC_VERIFICATION_ADDRESS,
  FDC_VERIFIER_API_KEY,
  FDC_VERIFIER_BASE_URL,
  FDC_VERIFIER_PREPARE_PATH,
  FDC_XRP_VERIFIER_ADDRESS,
} from "./config.mjs";

const EXPECTED_SOURCE_ID = "0x7465737458525000000000000000000000000000000000000000000000000000".slice(0, 66);
const EXPECTED_ATTESTATION_TYPE = "0x5852505061796d656e7400000000000000000000000000000000000000000000".slice(0, 66);

async function checkEncoding() {
  console.log("--- 1. sourceId / attestationType encoding ---");
  const sourceId = ethers.encodeBytes32String("testXRP");
  const attestationType = ethers.encodeBytes32String("XRPPayment");
  console.log(`sourceId("testXRP")       = ${sourceId}`);
  console.log(`attestationType("XRPPayment") = ${attestationType}`);
  const sourceOk = sourceId.toLowerCase() === EXPECTED_SOURCE_ID.toLowerCase();
  const typeOk = attestationType.toLowerCase() === EXPECTED_ATTESTATION_TYPE.toLowerCase();
  console.log(`${sourceOk ? "PASS" : "FAIL"} — sourceId matches flare-docs table`);
  console.log(`${typeOk ? "PASS" : "FAIL"} — attestationType matches flare-docs table`);
  return sourceOk && typeOk;
}

async function checkPrepareAndFee() {
  console.log("\n--- 2. prepareRequest + getRequestFee (well-formed request) ---");
  // A real, finalized XRPL Testnet payment tx hash cited in flare-docs/fdc-request-fee.md's own
  // live-verified example (ledger 19266010) — reused here purely to exercise prepareRequest with
  // a transactionId the verifier's indexer can actually resolve, without spending a fresh payment.
  const knownTxHash = "0x1196659A2DE208D6BADCA6F813A5889861236A4F5F604810FEC7379E52C4584B";
  const body = {
    attestationType: ethers.encodeBytes32String("XRPPayment"),
    sourceId: ethers.encodeBytes32String("testXRP"),
    requestBody: {
      transactionId: knownTxHash,
      proofOwner: FDC_XRP_VERIFIER_ADDRESS,
    },
  };
  const url = `${FDC_VERIFIER_BASE_URL}${FDC_VERIFIER_PREPARE_PATH}`;
  let res, json;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "X-API-KEY": FDC_VERIFIER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    json = await res.json();
  } catch (err) {
    console.log(`FAIL — verifier request errored: ${err.message}`);
    return false;
  }
  console.log(`HTTP ${res.status}, status field: ${json.status}`);
  if (json.status !== "VALID") {
    console.log(`FAIL — prepareRequest did not return VALID: ${JSON.stringify(json)}`);
    return false;
  }
  console.log(`PASS — prepareRequest returned VALID, abiEncodedRequest len=${json.abiEncodedRequest.length}`);

  const rpcUrl = process.env.COSTON2_RPC || COSTON2_RPC_DEFAULT;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const feeConfig = new ethers.Contract(FDC_REQUEST_FEE_CONFIGURATIONS_ADDRESS, ABI.feeConfig, provider);
  try {
    const fee = await feeConfig.getRequestFee(json.abiEncodedRequest);
    console.log(`PASS — getRequestFee returned ${fee.toString()} wei`);
    return true;
  } catch (err) {
    console.log(`FAIL — getRequestFee reverted: ${err.message}`);
    return false;
  }
}

async function checkVerifierCallable() {
  console.log("\n--- 3. deployed FdcXrpVerifier callable ---");
  const rpcUrl = process.env.COSTON2_RPC || COSTON2_RPC_DEFAULT;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const verifier = new ethers.Contract(FDC_XRP_VERIFIER_ADDRESS, ABI.fdcXrpVerifier, provider);
  try {
    const addr = await verifier.fdcVerification();
    const ok = addr.toLowerCase() === FDC_VERIFICATION_ADDRESS.toLowerCase();
    console.log(`fdcVerification() = ${addr}`);
    console.log(`${ok ? "PASS" : "FAIL"} — deployed verifier wired to registry-resolved FdcVerification`);
    return ok;
  } catch (err) {
    console.log(`FAIL — call reverted / RPC error: ${err.message}`);
    return false;
  }
}

async function main() {
  const r1 = await checkEncoding();
  const r2 = await checkPrepareAndFee();
  const r3 = await checkVerifierCallable();
  console.log("\n=== dry-validation summary ===");
  console.log(`encoding:            ${r1 ? "PASS" : "FAIL"}`);
  console.log(`prepareRequest+fee:  ${r2 ? "PASS" : "FAIL"}`);
  console.log(`verifier callable:   ${r3 ? "PASS" : "FAIL"}`);
  if (!(r1 && r2 && r3)) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
