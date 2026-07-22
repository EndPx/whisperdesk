// verify.mjs — Step 2 FDC spike, phase 2.
// Calls the deployed FdcXrpVerifier (Coston2) with the proof saved by attest.mjs, asserts
// verifyXRPPayment == true, and checks the decoded fields against the payment we actually made
// (out/payment.json). This exercises the SAME verifyXRPPayment path DvPEscrow.release() uses
// (docs/design.md §3.7).
//
// NOT executed by this task run (dry-validation phase only) — ready for the phase-2 trigger,
// run after attest.mjs has written out/proof.json.
import "dotenv/config";
import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ABI, COSTON2_RPC_DEFAULT, FDC_XRP_VERIFIER_ADDRESS, OUT_DIR } from "./config.mjs";

function buildProofTuple(proofJson) {
  const r = proofJson.response;
  return {
    merkleProof: proofJson.proof,
    data: {
      attestationType: r.attestationType,
      sourceId: r.sourceId,
      votingRound: r.votingRound,
      lowestUsedTimestamp: r.lowestUsedTimestamp,
      requestBody: {
        transactionId: r.requestBody.transactionId,
        proofOwner: r.requestBody.proofOwner,
      },
      responseBody: {
        blockNumber: r.responseBody.blockNumber,
        blockTimestamp: r.responseBody.blockTimestamp,
        sourceAddress: r.responseBody.sourceAddress,
        sourceAddressHash: r.responseBody.sourceAddressHash,
        receivingAddressHash: r.responseBody.receivingAddressHash,
        intendedReceivingAddressHash: r.responseBody.intendedReceivingAddressHash,
        spentAmount: r.responseBody.spentAmount,
        intendedSpentAmount: r.responseBody.intendedSpentAmount,
        receivedAmount: r.responseBody.receivedAmount,
        intendedReceivedAmount: r.responseBody.intendedReceivedAmount,
        hasMemoData: r.responseBody.hasMemoData,
        firstMemoData: r.responseBody.firstMemoData,
        hasDestinationTag: r.responseBody.hasDestinationTag,
        destinationTag: r.responseBody.destinationTag,
        status: r.responseBody.status,
      },
    },
  };
}

async function main() {
  const proofPath = fileURLToPath(new URL("proof.json", OUT_DIR));
  const paymentPath = fileURLToPath(new URL("payment.json", OUT_DIR));
  const proofJson = JSON.parse(readFileSync(proofPath, "utf8"));
  const payment = JSON.parse(readFileSync(paymentPath, "utf8"));

  const proofTuple = buildProofTuple(proofJson);

  const rpcUrl = process.env.COSTON2_RPC || COSTON2_RPC_DEFAULT;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const verifier = new ethers.Contract(FDC_XRP_VERIFIER_ADDRESS, ABI.fdcXrpVerifier, provider);

  const result = await verifier.verify(proofTuple);
  const [ok, sourceAddress, receivingAddressHash, receivedAmount, hasDestinationTag, destinationTag, status, blockTimestamp] = result;

  console.log(`verifyXRPPayment ok: ${ok}`);
  console.log(`sourceAddress: ${sourceAddress}`);
  console.log(`receivingAddressHash: ${receivingAddressHash}`);
  console.log(`receivedAmount (drops): ${receivedAmount.toString()}`);
  console.log(`hasDestinationTag: ${hasDestinationTag}, destinationTag: ${destinationTag.toString()}`);
  console.log(`status: ${status} (0=SUCCESS)`);
  console.log(`blockTimestamp: ${blockTimestamp.toString()}`);

  const expectedReceivingHash = ethers.keccak256(ethers.toUtf8Bytes(payment.takerAddress));

  const checks = [
    ["verifyXRPPayment == true", ok === true],
    ["status == 0 (SUCCESS)", Number(status) === 0],
    ["receivingAddressHash matches taker address", receivingAddressHash.toLowerCase() === expectedReceivingHash.toLowerCase()],
    ["hasDestinationTag == true", hasDestinationTag === true],
    ["destinationTag matches", destinationTag.toString() === String(payment.destinationTag)],
    ["receivedAmount >= paid drops", BigInt(receivedAmount) >= BigInt(payment.amountDrops)],
  ];

  let allPass = true;
  for (const [label, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"} — ${label}`);
    if (!pass) allPass = false;
  }

  if (!allPass) {
    console.error("\nNO-GO: onchain proof verification did not match the expected payment.");
    process.exit(1);
  }
  console.log("\nGO: FDC XRPPayment round-trip verified onchain on Coston2.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
