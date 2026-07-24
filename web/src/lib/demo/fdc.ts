// fdc.ts — TS port of scripts/e2e/lib/fdc.mjs (adapted from scripts/fdc-spike/attest.mjs +
// verify.mjs), parameterized so `requestBody.proofOwner` binds to OUR deployed escrow address —
// release() checks `proof.data.requestBody.proofOwner == address(this)` BEFORE anything else
// (docs/design.md §3.7).
//
// DEVIATION FROM scripts/e2e/lib/fdc.mjs: the e2e script's `requestAndAwaitProof` does the request
// AND blocks in a poll-with-sleep loop (up to 6 minutes) inside one function call — fine for a CLI
// script, not for an HTTP request/response cycle. This is split into two pieces to match the fixed
// API contract's GET /api/demo/proof polling design:
//   - submitAttestationRequest(): prepareRequest -> getRequestFee -> requestAttestation, then
//     estimates the voting round. Returns promptly (one Coston2 tx confirmation).
//   - checkProofOnce(): a SINGLE non-blocking sweep over nearby voting rounds (no sleep), meant to
//     be called repeatedly by the client via GET /api/demo/proof until it reports ready:true.
// The underlying HTTP calls to the FDC verifier / DA layer and the round-estimation math are
// unchanged from fdc.mjs.
import { ethers } from "ethers";
import {
  DA_LAYER_API_KEY,
  DA_LAYER_BASE_URL,
  DA_LAYER_PROOF_PATH,
  FDC_HUB_ABI,
  FDC_HUB_ADDRESS,
  FDC_REQUEST_FEE_CONFIGURATIONS_ADDRESS,
  FDC_VERIFIER_API_KEY,
  FDC_VERIFIER_BASE_URL,
  FDC_VERIFIER_PREPARE_PATH,
  FEE_CONFIG_ABI,
  FLARE_SYSTEMS_MANAGER_ABI,
  FLARE_SYSTEMS_MANAGER_ADDRESS,
  VOTING_EPOCH_DURATION_SECONDS,
} from "./config";

/// Asks the FDC verifier server to ABI-encode an XRPPayment attestation request for `txHashHex`,
/// with `requestBody.proofOwner` bound to `proofOwner` (the escrow that must later accept the
/// proof in release()).
export async function prepareRequest(txHashHex: string, proofOwner: string): Promise<string> {
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
    throw new Error(`demo/fdc.prepareRequest: verifier rejected request: ${JSON.stringify(json)}`);
  }
  return json.abiEncodedRequest as string;
}

export interface SubmitAttestationResult {
  roundId: number;
  requestHex: string;
  attestationTxHash: string;
}

/// prepareRequest -> getRequestFee -> requestAttestation(FdcHub) -> estimate votingRoundId. Does
/// NOT poll the DA layer for the proof (see checkProofOnce). `wallet` pays the FDC request fee and
/// must be funded with C2FLR.
export async function submitAttestationRequest({
  provider,
  wallet,
  txHashHex,
  proofOwner,
  onProgress,
}: {
  provider: ethers.JsonRpcProvider;
  wallet: ethers.Wallet;
  txHashHex: string;
  proofOwner: string;
  onProgress?: (msg: string) => void;
}): Promise<SubmitAttestationResult> {
  const log = onProgress || (() => {});
  const txHashHexNorm = txHashHex.startsWith("0x") ? txHashHex : `0x${txHashHex}`;

  const requestHex = await prepareRequest(txHashHexNorm, proofOwner);
  log(`prepareRequest ok (proofOwner=${proofOwner})`);

  const feeConfig = new ethers.Contract(FDC_REQUEST_FEE_CONFIGURATIONS_ADDRESS, FEE_CONFIG_ABI, provider);
  const fee: bigint = await feeConfig.getRequestFee(requestHex);
  log(`getRequestFee: ${fee.toString()} wei`);

  const fdcHub = new ethers.Contract(FDC_HUB_ADDRESS, FDC_HUB_ABI, wallet);
  const tx = await fdcHub.requestAttestation(requestHex, { value: fee });
  log(`requestAttestation tx: ${tx.hash}`);
  const receipt = await tx.wait();
  log(`confirmed in block ${receipt.blockNumber}`);

  const block = await provider.getBlock(receipt.blockNumber);
  const blockTimestamp = block!.timestamp;

  const fsm = new ethers.Contract(FLARE_SYSTEMS_MANAGER_ADDRESS, FLARE_SYSTEMS_MANAGER_ABI, provider);
  const firstVotingRoundStartTs = Number(await fsm.firstVotingRoundStartTs());
  const roundId = Math.floor((blockTimestamp - firstVotingRoundStartTs) / VOTING_EPOCH_DURATION_SECONDS);
  log(`estimated votingRoundId: ${roundId}`);

  return { roundId, requestHex, attestationTxHash: tx.hash as string };
}

// Shape of the DA layer's "response" object — passed through opaquely between GET /proof and
// POST /release, only field-accessed inside buildProofTuple.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FdcResponse = any;

export interface ProofResult {
  votingRoundId: number;
  response: FdcResponse;
  proof: string[];
}

async function pollProofOnce(votingRoundId: number, requestHex: string): Promise<ProofResult | null> {
  const url = `${DA_LAYER_BASE_URL}${DA_LAYER_PROOF_PATH}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-API-KEY": DA_LAYER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ votingRoundId, requestBytes: requestHex }),
  });
  if (res.status !== 200) return null; // not ready / not in this round yet
  const json = await res.json();
  if (!json || !json.proof) return null;
  return { votingRoundId, response: json.response, proof: json.proof };
}

export interface CheckProofResult {
  ready: boolean;
  proof?: ProofResult;
}

/// One non-blocking sweep over nearby voting rounds (the request may land near a round boundary),
/// mirroring the candidate-offset order fdc.mjs's requestAndAwaitProof uses inside its poll loop —
/// but as a single check, with no sleep. Meant to be called repeatedly by the client (GET
/// /api/demo/proof) until it returns ready:true.
export async function checkProofOnce(roundId: number, requestHex: string): Promise<CheckProofResult> {
  const candidateOffsets = [0, 1, -1, 2];
  for (const offset of candidateOffsets) {
    const round = roundId + offset;
    const result = await pollProofOnce(round, requestHex);
    if (result) {
      return { ready: true, proof: result };
    }
  }
  return { ready: false };
}

/// Converts a ProofResult (as handed back opaquely by GET /api/demo/proof) into the exact tuple
/// shape ethers.Contract needs for DvPEscrow.release(matchId, proof) — mirrors
/// scripts/fdc-spike/verify.mjs's / scripts/e2e/lib/fdc.mjs's buildProofTuple.
export function buildProofTuple(proofResult: ProofResult) {
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
