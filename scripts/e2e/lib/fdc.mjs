// fdc.mjs — adapted from scripts/fdc-spike/attest.mjs + verify.mjs (Step 2), parameterized so
// `requestBody.proofOwner` binds to OUR integration escrow address instead of the Step-2 spike
// verifier contract. This is the one required change for a real DvPEscrow.release() to accept the
// proof: release() checks `proof.data.requestBody.proofOwner == address(this)` BEFORE anything
// else (design.md §3.7 / mandatory sub-task (b)).
import { ethers } from "ethers";
import {
  ABI,
  DA_LAYER_API_KEY,
  DA_LAYER_BASE_URL,
  DA_LAYER_PROOF_PATH,
  FDC_HUB_ADDRESS,
  FDC_REQUEST_FEE_CONFIGURATIONS_ADDRESS,
  FDC_VERIFIER_API_KEY,
  FDC_VERIFIER_BASE_URL,
  FDC_VERIFIER_PREPARE_PATH,
  FLARE_SYSTEMS_MANAGER_ADDRESS,
  VOTING_EPOCH_DURATION_SECONDS,
} from "../config.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/// Asks the FDC verifier server to ABI-encode an XRPPayment attestation request for `txHashHex`,
/// with `requestBody.proofOwner` bound to `proofOwner` (the escrow that must later accept the
/// proof in release()).
export async function prepareRequest(txHashHex, proofOwner) {
  const attestationType = ethers.encodeBytes32String("XRPPayment");
  const sourceId = ethers.encodeBytes32String("testXRP");
  const body = {
    attestationType,
    sourceId,
    requestBody: {
      transactionId: txHashHex,
      proofOwner,
    },
  };
  const url = `${FDC_VERIFIER_BASE_URL}${FDC_VERIFIER_PREPARE_PATH}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-API-KEY": FDC_VERIFIER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.status !== "VALID") {
    throw new Error(`fdc.prepareRequest: verifier rejected request: ${JSON.stringify(json)}`);
  }
  return json.abiEncodedRequest;
}

async function pollProofOnce(votingRoundId, abiEncodedRequest) {
  const url = `${DA_LAYER_BASE_URL}${DA_LAYER_PROOF_PATH}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-API-KEY": DA_LAYER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ votingRoundId, requestBytes: abiEncodedRequest }),
  });
  if (res.status !== 200) return null; // not ready / not in this round yet
  const json = await res.json();
  if (!json || !json.proof) return null;
  return json;
}

/// Full prepareRequest -> getRequestFee -> requestAttestation(FdcHub) -> poll-DA-layer round
/// trip. Returns `{ votingRoundId, response, proof }`, mirroring what
/// scripts/fdc-spike/attest.mjs writes to out/proof.json. `wallet` pays the FDC request fee and
/// must be funded with C2FLR.
export async function requestAndAwaitProof({ provider, wallet, txHashHex, proofOwner, timeoutMs = 6 * 60 * 1000, onProgress }) {
  const log = onProgress || (() => {});
  const txHashHexNorm = txHashHex.startsWith("0x") ? txHashHex : `0x${txHashHex}`;

  const abiEncodedRequest = await prepareRequest(txHashHexNorm, proofOwner);
  log(`prepareRequest ok (proofOwner=${proofOwner})`);

  const feeConfig = new ethers.Contract(FDC_REQUEST_FEE_CONFIGURATIONS_ADDRESS, ABI.feeConfig, provider);
  const fee = await feeConfig.getRequestFee(abiEncodedRequest);
  log(`getRequestFee: ${fee.toString()} wei`);

  const fdcHub = new ethers.Contract(FDC_HUB_ADDRESS, ABI.fdcHub, wallet);
  const tx = await fdcHub.requestAttestation(abiEncodedRequest, { value: fee });
  log(`requestAttestation tx: ${tx.hash}`);
  const receipt = await tx.wait();
  log(`confirmed in block ${receipt.blockNumber}`);

  const block = await provider.getBlock(receipt.blockNumber);
  const blockTimestamp = block.timestamp;

  const fsm = new ethers.Contract(FLARE_SYSTEMS_MANAGER_ADDRESS, ABI.flareSystemsManager, provider);
  const firstVotingRoundStartTs = Number(await fsm.firstVotingRoundStartTs());
  const votingRoundId = Math.floor((blockTimestamp - firstVotingRoundStartTs) / VOTING_EPOCH_DURATION_SECONDS);
  log(`estimated votingRoundId: ${votingRoundId}`);

  // Round finalization is ~90-180s total; poll every 20s. Try the estimated round first, then
  // neighbors (+1, +2, -1) since the request may land near a round boundary.
  const deadline = Date.now() + timeoutMs;
  const candidateOffsets = [0, 1, -1, 2];
  let proofResult = null;
  while (Date.now() < deadline && !proofResult) {
    for (const offset of candidateOffsets) {
      const round = votingRoundId + offset;
      const result = await pollProofOnce(round, abiEncodedRequest);
      if (result) {
        log(`proof found at votingRoundId=${round}`);
        proofResult = { votingRoundId: round, ...result };
        break;
      }
    }
    if (!proofResult) {
      log(`no proof yet, waiting 20s... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
      await sleep(20000);
    }
  }
  if (!proofResult) {
    throw new Error("fdc.requestAndAwaitProof: timed out waiting for the DA layer proof");
  }
  return proofResult;
}

/// Converts a `requestAndAwaitProof` result into the exact tuple shape ethers.Contract needs for
/// DvPEscrow.release(matchId, proof) — mirrors scripts/fdc-spike/verify.mjs's buildProofTuple.
export function buildProofTuple(proofResult) {
  const r = proofResult.response;
  return {
    merkleProof: proofResult.proof,
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
