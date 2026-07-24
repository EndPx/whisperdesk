#!/usr/bin/env node
// run.mjs — Node runner for the client half of WhisperDesk's enclave loop
// (extension/fcewire/PROTOCOL.md). Takes the JSON `wd-client loop` printed to stdout (a file arg,
// or piped on stdin) and drives the REST of the settlement — funding, lock(), the XRPL leg, the FDC
// proof, and release() — WITHOUT building or signing a MatchInstruction itself: the enclave already
// produced `abiEncoded` + `teeSignature`, and this script's only job is to get them onchain and
// then satisfy the resulting XRPL leg. Mirrors scripts/e2e/happy-path.mjs's post-lock() flow
// exactly (payXrpl -> requestAndAwaitProof -> release()), reusing scripts/e2e/lib/{xrplPay,fdc}.mjs
// verbatim.
//
// Deliberately does NOT reuse scripts/e2e/lib/flow.mjs's `setupClients` — that helper asserts
// `escrow.teeSigner() === deployerWallet.address` because Step 5's E2E signs MatchInstructions
// locally with PRIVATE_KEY. Here `teeSigner` is the ENCLAVE's own address (the `enclaveAddress`
// field in the wd-client loop JSON, already ecrecover-verified by wd-client before it printed
// anything) — PRIVATE_KEY is just the permissionless relayer that pays gas for lock()/release()
// (design.md §3.12 threat #21: "permissionless lock(); result persisted at proxy"). This script
// instead asserts `escrow.teeSigner() === loopJson.enclaveAddress`, which is the actually-correct
// sanity check for this flow.
//
// Usage (from repo root or this directory):
//   cd scripts/enclave-loop && npm install
//   ESCROW_ADDRESS=0x... node run.mjs match.json
// or: node run.mjs match.json 0xEscrowAddress...
// match.json is the file `wd-client loop ... > match.json` wrote (or pipe it: wd-client loop ... | node run.mjs -)
//
// Required env (repo-root .env, exported, or DOTENV_CONFIG_PATH): PRIVATE_KEY, TAKER_PRIVATE_KEY,
// MAKER_PRIVATE_KEY, XRPL_MAKER_SEED. Optional: ESCROW_ADDRESS, COSTON2_RPC, XRPL_TESTNET_WSS.
//
// NOT executed as part of writing this file — same convention as happy-path.mjs: this is the
// instructor's live-network trigger, verified here only with `node --check` + code review.
import { readFileSync } from "node:fs";
import { ethers } from "ethers";

import {
  getEscrowAddress,
  hasHelpFlag,
  isMainModule,
  maybePrintHelpAndExit,
  requireEnv,
  COSTON2_CHAIN_ID,
  COSTON2_RPC,
  XRPL_TESTNET_WSS,
} from "../e2e/config.mjs";
import { DVP_ESCROW_ABI, BOND_LEDGER_ABI, MOCK_FXRP_ABI, FTSOV2_ABI } from "../e2e/lib/abi.mjs";
import { fundMakerBond, fundTakerDeposit, readLiveFtsoMid } from "../e2e/lib/flow.mjs";
import { payXrpl } from "../e2e/lib/xrplPay.mjs";
import { buildProofTuple, requestAndAwaitProof } from "../e2e/lib/fdc.mjs";

const USAGE = `Usage: node run.mjs <match.json|-> [ESCROW_ADDRESS] [--help]

Takes the JSON \`wd-client loop\` printed (a file path, or "-" to read stdin), funds the taker
deposit + maker bond, calls DvPEscrow.lock(abiEncoded, teeSignature) with the enclave's own
signature (no local signing), pays the resulting XRPL leg, requests a fresh FDC proof, and calls
release(). Asserts the maker's FXRP balance increases by the matched amount.

ESCROW_ADDRESS may be passed as the second CLI arg, via the ESCROW_ADDRESS env var, or is read
from match.json's own "escrow" field if neither is set (cross-checked against escrow.teeSigner()
either way).

Required env: PRIVATE_KEY, TAKER_PRIVATE_KEY, MAKER_PRIVATE_KEY, XRPL_MAKER_SEED.
Optional: ESCROW_ADDRESS, COSTON2_RPC, XRPL_TESTNET_WSS.`;

/// Reads the wd-client loop JSON from a file path arg or "-"/stdin, and validates the shape this
/// script depends on (mirrors wd-client's own loopOutput struct, cmd/wd-client/loop.go).
function readMatchJson(pathArg) {
  const raw =
    pathArg === "-" || !pathArg
      ? readFileSync(0, "utf8") // fd 0 = stdin
      : readFileSync(pathArg, "utf8");

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`run.mjs: could not parse match JSON: ${err.message}`);
  }

  const required = ["matchId", "escrow", "taker", "maker", "amountFxrp", "priceUsd18", "takerXrplAddress", "abiEncoded", "teeSignature", "chainId", "enclaveAddress", "verified"];
  const missing = required.filter((k) => data[k] === undefined || data[k] === null || data[k] === "");
  if (missing.length > 0) {
    throw new Error(`run.mjs: match JSON is missing required field(s): ${missing.join(", ")}`);
  }
  if (data.verified !== true) {
    throw new Error(
      "run.mjs: match JSON has verified=false — wd-client's own ecrecover check against the " +
        "enclave's /info address FAILED. Refusing to call lock() with an unverified signature."
    );
  }
  return data;
}

/// Connects to the deployed escrow + its wired FXRP/BondLedger/FtsoV2, and the three EVM wallets
/// this runner controls: relayerWallet (PRIVATE_KEY) pays gas for lock()/release() only — lock()
/// is permissionless (design.md §3.12 #21), it does NOT need to be the teeSigner here (unlike
/// scripts/e2e/lib/flow.mjs's setupClients, which signs locally and therefore must be the
/// teeSigner). takerWallet/makerWallet fund the deposit/bond the matched addresses need.
async function setupClients(escrowAddress) {
  const provider = new ethers.JsonRpcProvider(COSTON2_RPC, COSTON2_CHAIN_ID);

  const relayerWallet = new ethers.Wallet(requireEnv("PRIVATE_KEY"), provider);
  const takerWallet = new ethers.Wallet(requireEnv("TAKER_PRIVATE_KEY"), provider);
  const makerWallet = new ethers.Wallet(requireEnv("MAKER_PRIVATE_KEY"), provider);

  const escrow = new ethers.Contract(escrowAddress, DVP_ESCROW_ABI, provider);

  const fxrpAddress = await escrow.FXRP();
  const bondLedgerAddress = await escrow.BOND_LEDGER();
  const ftsoV2Address = await escrow.ftsoV2();

  const fxrp = new ethers.Contract(fxrpAddress, MOCK_FXRP_ABI, provider);
  const bondLedger = new ethers.Contract(bondLedgerAddress, BOND_LEDGER_ABI, provider);
  const ftso = new ethers.Contract(ftsoV2Address, FTSOV2_ABI, provider);

  return { provider, escrow, fxrp, bondLedger, ftso, relayerWallet, takerWallet, makerWallet };
}

export async function main() {
  maybePrintHelpAndExit(USAGE);

  const positional = process.argv.slice(2).filter((a) => a !== "--help" && a !== "-h");
  const matchJsonArg = positional[0];
  if (!matchJsonArg) {
    console.error(USAGE);
    process.exit(2);
  }
  const matchData = readMatchJson(matchJsonArg);

  const escrowAddress = getEscrowAddress() || matchData.escrow;
  if (!escrowAddress) {
    throw new Error("run.mjs: no escrow address — pass one, set ESCROW_ADDRESS, or ensure match.json has an \"escrow\" field");
  }
  if (matchData.escrow && matchData.escrow.toLowerCase() !== escrowAddress.toLowerCase()) {
    console.warn(
      `[run] WARNING: match.json's escrow (${matchData.escrow}) != the escrow address this run targets ` +
        `(${escrowAddress}) — the enclave signed a MatchInstruction bound to a DIFFERENT escrow instance; ` +
        `lock() will revert (cross-instance replay guard, design.md §3.12 threat #3).`
    );
  }

  console.log(`=== WhisperDesk enclave-loop runner ===`);
  console.log(`escrow: ${escrowAddress}`);
  console.log(`matchId: ${matchData.matchId}`);
  console.log(`taker: ${matchData.taker}  maker: ${matchData.maker}`);
  console.log(`amountFxrp (raw): ${matchData.amountFxrp}  priceUsd18: ${matchData.priceUsd18}`);
  console.log(`enclave address (verified signer): ${matchData.enclaveAddress}`);

  const clients = await setupClients(escrowAddress);
  const { escrow, fxrp, ftso, relayerWallet, takerWallet, makerWallet, provider } = clients;

  // Sanity check: the escrow this runner is about to call lock() on must actually trust the
  // enclave that signed this MatchInstruction — otherwise ecrecover inside lock() will revert
  // even though wd-client's own local verification (against /info, not escrow.teeSigner()) passed.
  const onchainTeeSigner = await escrow.teeSigner();
  if (onchainTeeSigner.toLowerCase() !== matchData.enclaveAddress.toLowerCase()) {
    throw new Error(
      `run.mjs: escrow.teeSigner() (${onchainTeeSigner}) != match.json's verified enclaveAddress ` +
        `(${matchData.enclaveAddress}) — lock()'s ecrecover check will revert. Either this escrow ` +
        `instance is not wired to this enclave, or match.json is stale/wrong.`
    );
  }

  const network = await provider.getNetwork();
  if (BigInt(matchData.chainId) !== network.chainId) {
    console.warn(
      `[run] WARNING: match.json's chainId (${matchData.chainId}) != the connected network's ` +
        `chainId (${network.chainId}) — the enclave signed for a different chain than this RPC is on.`
    );
  }

  const amountFxrp = BigInt(matchData.amountFxrp);
  const bondBips = await escrow.BOND_BIPS();
  const bondAmount = (amountFxrp * bondBips) / 10000n;

  console.log(`[fund] taker deposit: ${amountFxrp} FXRP (raw, 6-dec)`);
  await fundTakerDeposit(clients, takerWallet, amountFxrp);
  console.log(`[fund] maker bond: ${bondAmount} FXRP (raw, 6-dec)`);
  await fundMakerBond(clients, makerWallet, bondAmount);

  const { fee } = await readLiveFtsoMid(ftso);
  console.log(`[lock] FTSOv2 fee: ${fee} wei`);

  console.log(`[lock] calling lock() with the enclave-signed instruction (no local signing)...`);
  const lockTx = await escrow
    .connect(relayerWallet)
    .lock(matchData.abiEncoded, matchData.teeSignature, { value: fee });
  const lockReceipt = await lockTx.wait();
  console.log(`[lock] confirmed: ${lockReceipt.hash}`);

  const lockedEvent = lockReceipt.logs
    .map((l) => {
      try {
        return escrow.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "MatchLocked");
  if (!lockedEvent) {
    throw new Error("run.mjs: MatchLocked event not found in lock() receipt logs");
  }

  const matchId = lockedEvent.args.matchId;
  const destinationTag = Number(lockedEvent.args.destinationTag);
  const xrpDrops = lockedEvent.args.xrpDrops;
  const paymentDeadline = Number(lockedEvent.args.paymentDeadline);
  const refundAfter = Number(lockedEvent.args.refundAfter);
  console.log(`[lock] matchId=${matchId} destinationTag=${destinationTag} xrpDrops=${xrpDrops}`);
  console.log(
    `[lock] paymentDeadline=${new Date(paymentDeadline * 1000).toISOString()} ` +
      `refundAfter=${new Date(refundAfter * 1000).toISOString()}`
  );
  if (matchId.toLowerCase() !== matchData.matchId.toLowerCase()) {
    console.warn(`[run] WARNING: onchain matchId (${matchId}) != match.json's matchId (${matchData.matchId})`);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec >= paymentDeadline) {
    throw new Error("run.mjs: already past paymentDeadline before the XRPL payment was even sent");
  }

  const payment = await payXrpl({
    wss: XRPL_TESTNET_WSS,
    makerSeed: requireEnv("XRPL_MAKER_SEED"),
    takerAddress: matchData.takerXrplAddress,
    amountDrops: xrpDrops,
    destinationTag,
    onProgress: (m) => console.log(`[xrpl] ${m}`),
  });
  console.log(`[xrpl] paid, txHash=${payment.txHash}`);

  const proofResult = await requestAndAwaitProof({
    provider,
    wallet: relayerWallet,
    txHashHex: payment.txHash,
    proofOwner: escrowAddress,
    onProgress: (m) => console.log(`[fdc] ${m}`),
  });

  const proofTuple = buildProofTuple(proofResult);

  const makerBalBefore = await fxrp.balanceOf(makerWallet.address);
  console.log(`[release] calling release()...`);
  const releaseTx = await escrow.connect(relayerWallet).release(matchId, proofTuple);
  const releaseReceipt = await releaseTx.wait();
  console.log(`[release] confirmed: ${releaseReceipt.hash}`);

  const makerBalAfter = await fxrp.balanceOf(makerWallet.address);
  const delta = makerBalAfter - makerBalBefore;
  if (delta !== amountFxrp) {
    throw new Error(`run.mjs FAILED: maker FXRP balance changed by ${delta}, expected ${amountFxrp}`);
  }

  console.log("");
  console.log(`GO: enclave-loop settlement complete.`);
  console.log(`  lock():    ${lockReceipt.hash}`);
  console.log(`  xrpl pay:  ${payment.txHash}`);
  console.log(`  release(): ${releaseReceipt.hash}`);
  console.log(`Maker received ${ethers.formatUnits(delta, 6)} FXRP.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`\nNO-GO: run.mjs failed — ${err.stack || err.message}`);
    process.exit(1);
  });
}
