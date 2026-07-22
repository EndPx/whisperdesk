// attest.mjs — Step 2 FDC spike, phase 2.
// prepareRequest (XRPPayment, sourceId testXRP, the tx hash from pay.mjs) -> getRequestFee ->
// requestAttestation on FdcHub with the exact fee -> poll the DA layer for the Merkle proof
// (timeout ~6 min, poll every ~20s) -> save the full proof JSON to out/proof.json.
//
// NOT executed by this task run (dry-validation phase only) — ready for the phase-2 trigger,
// run after pay.mjs has written out/payment.json.
import "dotenv/config";
import { ethers } from "ethers";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ABI,
  COSTON2_RPC_DEFAULT,
  DA_LAYER_API_KEY,
  DA_LAYER_BASE_URL,
  DA_LAYER_PROOF_PATH,
  FDC_HUB_ADDRESS,
  FDC_REQUEST_FEE_CONFIGURATIONS_ADDRESS,
  FDC_VERIFIER_API_KEY,
  FDC_VERIFIER_BASE_URL,
  FDC_VERIFIER_PREPARE_PATH,
  FDC_XRP_VERIFIER_ADDRESS,
  FLARE_SYSTEMS_MANAGER_ADDRESS,
  OUT_DIR,
  VOTING_EPOCH_DURATION_SECONDS,
} from "./config.mjs";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function prepareRequest(txHashHex) {
  const attestationType = ethers.encodeBytes32String("XRPPayment");
  const sourceId = ethers.encodeBytes32String("testXRP");
  const body = {
    attestationType,
    sourceId,
    requestBody: {
      transactionId: txHashHex,
      proofOwner: FDC_XRP_VERIFIER_ADDRESS,
    },
  };
  const url = `${FDC_VERIFIER_BASE_URL}${FDC_VERIFIER_PREPARE_PATH}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-API-KEY": FDC_VERIFIER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.status !== "VALID") {
    throw new Error(`prepareRequest failed: ${JSON.stringify(json)}`);
  }
  return json.abiEncodedRequest;
}

async function pollProof(votingRoundId, abiEncodedRequest) {
  const url = `${DA_LAYER_BASE_URL}${DA_LAYER_PROOF_PATH}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-API-KEY": DA_LAYER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ votingRoundId, requestBytes: abiEncodedRequest }),
  });
  if (res.status !== 200) {
    return null; // not ready / not in this round yet
  }
  const json = await res.json();
  if (!json || !json.proof) return null;
  return json;
}

async function main() {
  const paymentPath = fileURLToPath(new URL("payment.json", OUT_DIR));
  const payment = JSON.parse(readFileSync(paymentPath, "utf8"));
  const txHashHex = payment.txHash.startsWith("0x") ? payment.txHash : `0x${payment.txHash}`;
  console.log(`attesting XRPL tx: ${txHashHex}`);

  const abiEncodedRequest = await prepareRequest(txHashHex);
  console.log(`abiEncodedRequest: ${abiEncodedRequest.slice(0, 20)}... (${abiEncodedRequest.length} chars)`);

  const rpcUrl = process.env.COSTON2_RPC || COSTON2_RPC_DEFAULT;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(requireEnv("PRIVATE_KEY"), provider);

  const feeConfig = new ethers.Contract(FDC_REQUEST_FEE_CONFIGURATIONS_ADDRESS, ABI.feeConfig, provider);
  const fee = await feeConfig.getRequestFee(abiEncodedRequest);
  console.log(`getRequestFee: ${fee.toString()} wei`);

  const fdcHub = new ethers.Contract(FDC_HUB_ADDRESS, ABI.fdcHub, wallet);
  const tx = await fdcHub.requestAttestation(abiEncodedRequest, { value: fee });
  console.log(`requestAttestation tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`confirmed in block ${receipt.blockNumber}`);

  const block = await provider.getBlock(receipt.blockNumber);
  const blockTimestamp = block.timestamp;

  const fsm = new ethers.Contract(FLARE_SYSTEMS_MANAGER_ADDRESS, ABI.flareSystemsManager, provider);
  const firstVotingRoundStartTs = Number(await fsm.firstVotingRoundStartTs());
  const votingRoundId = Math.floor((blockTimestamp - firstVotingRoundStartTs) / VOTING_EPOCH_DURATION_SECONDS);
  console.log(`estimated votingRoundId: ${votingRoundId} (blockTs=${blockTimestamp}, firstVotingRoundStartTs=${firstVotingRoundStartTs})`);

  // Round finalization is 90-180s total; poll every 20s up to ~6 minutes. Try the estimated
  // round first, then neighbors (+1, +2) since request landed near a round boundary (flare-docs
  // gotcha: "kalau 400, request belum confirmed di round itu, bisa jadi masuk round tetangga").
  const deadline = Date.now() + 6 * 60 * 1000;
  const candidateOffsets = [0, 1, -1, 2];
  let proofResult = null;
  while (Date.now() < deadline && !proofResult) {
    for (const offset of candidateOffsets) {
      const round = votingRoundId + offset;
      const result = await pollProof(round, abiEncodedRequest);
      if (result) {
        console.log(`proof found at votingRoundId=${round}`);
        proofResult = { votingRoundId: round, ...result };
        break;
      }
    }
    if (!proofResult) {
      console.log(`no proof yet, waiting 20s... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
      await sleep(20000);
    }
  }

  if (!proofResult) {
    throw new Error("Timed out waiting for FDC proof after 6 minutes — NO-GO candidate: consensus never reached or DA layer never served the proof.");
  }

  writeFileSync(
    fileURLToPath(new URL("proof.json", OUT_DIR)),
    JSON.stringify(
      {
        txHash: txHashHex,
        abiEncodedRequest,
        votingRoundId: proofResult.votingRoundId,
        response: proofResult.response,
        proof: proofResult.proof,
      },
      null,
      2
    )
  );
  console.log("Saved out/proof.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
