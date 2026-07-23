#!/usr/bin/env node
// happy-path.mjs — Step 5 full happy-path E2E runner against a deployed DvPEscrow integration
// instance (script/DeployIntegration.s.sol):
//
//   1. mint + deposit MockFXRP for the taker, mint + deposit bond FXRP for the maker
//   2. build + sign a MatchInstruction (amount = MIN_BLOCK_FXRP, priced at the live FTSOv2 mid,
//      takerXrplAddress = XRPL_TAKER_ADDRESS) with the deployer key (== escrow.teeSigner())
//   3. call lock() and read the assigned destinationTag + xrpDrops off the MatchLocked event
//   4. make the REAL XRPL maker->taker payment of exactly xrpDrops with that destinationTag
//   5. request a FRESH FDC XRPPayment attestation, with requestBody.proofOwner = escrow address
//      (NOT the Step-2 spike verifier — this is the one required change from
//      scripts/fdc-spike/attest.mjs for release() to accept the proof, design.md §3.7)
//   6. call release() and assert the FXRP moved to the maker
//
// NOT executed as part of writing this file — this is the instructor's live-network trigger. Run
// with (from repo root or this directory):
//   cd scripts/e2e && npm install
//   ESCROW_ADDRESS=0x... node happy-path.mjs
// or: node happy-path.mjs 0xEscrowAddress...
//
// Required env (repo-root .env, or exported, or DOTENV_CONFIG_PATH): PRIVATE_KEY,
// TAKER_PRIVATE_KEY, MAKER_PRIVATE_KEY, XRPL_MAKER_SEED, XRPL_TAKER_ADDRESS. Optional:
// ESCROW_ADDRESS (or pass as CLI arg), COSTON2_RPC, XRPL_TESTNET_WSS.
import { ethers } from "ethers";
import { getEscrowAddress, isMainModule, maybePrintHelpAndExit, requireEnv, XRPL_TESTNET_WSS } from "./config.mjs";
import { fundAndLock, setupClients } from "./lib/flow.mjs";
import { payXrpl } from "./lib/xrplPay.mjs";
import { buildProofTuple, requestAndAwaitProof } from "./lib/fdc.mjs";

const USAGE = `Usage: node happy-path.mjs [ESCROW_ADDRESS] [--help]

Full happy-path E2E: lock() -> real XRPL payment -> fresh FDC proof (proofOwner = escrow) ->
release(). Asserts the maker's FXRP balance increases by MIN_BLOCK_FXRP.

ESCROW_ADDRESS may be passed as the first CLI arg, or via the ESCROW_ADDRESS env var.

Required env: PRIVATE_KEY, TAKER_PRIVATE_KEY, MAKER_PRIVATE_KEY, XRPL_MAKER_SEED,
XRPL_TAKER_ADDRESS. Optional: ESCROW_ADDRESS, COSTON2_RPC, XRPL_TESTNET_WSS.`;

export async function main() {
  maybePrintHelpAndExit(USAGE);

  const escrowAddress = getEscrowAddress();
  console.log(`=== WhisperDesk Step 5 E2E: happy-path ===`);
  console.log(`escrow: ${escrowAddress}`);

  const clients = await setupClients(escrowAddress);
  const { escrow, fxrp, makerWallet, deployerWallet, provider } = clients;

  const lockResult = await fundAndLock(clients, { onProgress: (m) => console.log(`[lock] ${m}`) });
  console.log(`[lock] matchId=${lockResult.matchId}`);
  console.log(`[lock] destinationTag=${lockResult.destinationTag} xrpDrops=${lockResult.xrpDrops}`);
  console.log(
    `[lock] paymentDeadline=${new Date(lockResult.paymentDeadline * 1000).toISOString()} ` +
      `refundAfter=${new Date(lockResult.refundAfter * 1000).toISOString()}`
  );

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec >= lockResult.paymentDeadline) {
    throw new Error(
      "happy-path: already past paymentDeadline before the XRPL payment was even sent — " +
        "PAYMENT_WINDOW is too short for this environment's tx latency"
    );
  }

  const payment = await payXrpl({
    wss: XRPL_TESTNET_WSS,
    makerSeed: requireEnv("XRPL_MAKER_SEED"),
    takerAddress: requireEnv("XRPL_TAKER_ADDRESS"),
    amountDrops: lockResult.xrpDrops,
    destinationTag: lockResult.destinationTag,
    onProgress: (m) => console.log(`[xrpl] ${m}`),
  });
  console.log(`[xrpl] paid, txHash=${payment.txHash}`);

  const proofResult = await requestAndAwaitProof({
    provider,
    wallet: deployerWallet,
    txHashHex: payment.txHash,
    proofOwner: escrowAddress,
    onProgress: (m) => console.log(`[fdc] ${m}`),
  });

  const proofTuple = buildProofTuple(proofResult);

  const makerBalBefore = await fxrp.balanceOf(makerWallet.address);
  console.log(`[release] calling release()...`);
  const releaseTx = await escrow.connect(deployerWallet).release(lockResult.matchId, proofTuple);
  const releaseReceipt = await releaseTx.wait();
  console.log(`[release] confirmed: ${releaseReceipt.hash}`);

  const makerBalAfter = await fxrp.balanceOf(makerWallet.address);
  const delta = makerBalAfter - makerBalBefore;
  if (delta !== lockResult.amountFxrp) {
    throw new Error(
      `happy-path FAILED: maker FXRP balance changed by ${delta}, expected ${lockResult.amountFxrp}`
    );
  }

  console.log("");
  console.log(`GO: happy-path E2E complete. Maker received ${ethers.formatUnits(delta, 6)} FXRP.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`\nNO-GO: happy-path failed — ${err.stack || err.message}`);
    process.exit(1);
  });
}
