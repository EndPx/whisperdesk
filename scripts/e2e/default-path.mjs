#!/usr/bin/env node
// default-path.mjs — Step 5 default-path (no-payment / auto-refund) E2E runner against a deployed
// DvPEscrow integration instance (script/DeployIntegration.s.sol):
//
//   1. mint + deposit MockFXRP for the taker, mint + deposit bond FXRP for the maker
//   2. build + sign a MatchInstruction and call lock() (same as happy-path.mjs's step 1-3)
//   3. deliberately do NOT make the XRPL payment
//   4. wait until block.timestamp > refundAfter + REFUND_GRACE (design.md §14 fix, Step 5)
//   5. call refund() (permissionless) and assert the taker received principal + the maker's
//      slashed 100% bond
//
// NOT executed as part of writing this file — this is the instructor's live-network trigger. Run
// with (from repo root or this directory):
//   cd scripts/e2e && npm install
//   ESCROW_ADDRESS=0x... node default-path.mjs
// or: node default-path.mjs 0xEscrowAddress...
//
// Required env: PRIVATE_KEY, TAKER_PRIVATE_KEY, MAKER_PRIVATE_KEY, XRPL_TAKER_ADDRESS (only used
// as the plaintext takerXrplAddress field on the MatchInstruction — no XRPL payment is made, so
// XRPL_MAKER_SEED is NOT required for this runner). Optional: ESCROW_ADDRESS, COSTON2_RPC.
//
// This runner polls and waits for real wall-clock time (SETTLEMENT_WINDOW + REFUND_GRACE, minutes
// for script/DeployIntegration.s.sol's demo windows) — it is deliberately not fast; that IS the
// default-path behavior being demonstrated.
import { getEscrowAddress, isMainModule, maybePrintHelpAndExit } from "./config.mjs";
import { fundAndLock, setupClients } from "./lib/flow.mjs";

const USAGE = `Usage: node default-path.mjs [ESCROW_ADDRESS] [--help]

Default-path E2E: lock() -> (no XRPL payment) -> wait past refundAfter + REFUND_GRACE -> refund().
Asserts the taker receives principal + the maker's slashed 100% bond.

ESCROW_ADDRESS may be passed as the first CLI arg, or via the ESCROW_ADDRESS env var.

Required env: PRIVATE_KEY, TAKER_PRIVATE_KEY, MAKER_PRIVATE_KEY, XRPL_TAKER_ADDRESS. Optional:
ESCROW_ADDRESS, COSTON2_RPC.`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function main() {
  maybePrintHelpAndExit(USAGE);

  const escrowAddress = getEscrowAddress();
  console.log(`=== WhisperDesk Step 5 E2E: default-path (no payment -> refund) ===`);
  console.log(`escrow: ${escrowAddress}`);

  const clients = await setupClients(escrowAddress);
  const { provider, escrow, fxrp, takerWallet, deployerWallet } = clients;

  const lockResult = await fundAndLock(clients, { onProgress: (m) => console.log(`[lock] ${m}`) });
  console.log(`[lock] matchId=${lockResult.matchId}`);
  console.log(
    `[lock] paymentDeadline=${new Date(lockResult.paymentDeadline * 1000).toISOString()} ` +
      `refundAfter=${new Date(lockResult.refundAfter * 1000).toISOString()}`
  );
  console.log(`[lock] deliberately NOT paying the XRPL leg for this match`);

  const refundGrace = Number(await escrow.REFUND_GRACE());
  const earliestRefundable = lockResult.refundAfter + refundGrace;
  console.log(
    `[wait] refund() unlocks at ${new Date(earliestRefundable * 1000).toISOString()} ` +
      `(refundAfter + REFUND_GRACE=${refundGrace}s)`
  );

  // Gate on the CHAIN's block.timestamp, not the local wall clock — a local clock ahead of chain
  // time would make us call refund() before block.timestamp actually passes the deadline, and the
  // contract would revert RefundTooEarly. Poll the latest block instead.
  for (;;) {
    const chainNow = (await provider.getBlock("latest")).timestamp;
    const remaining = earliestRefundable - chainNow;
    if (remaining <= 0) break;
    console.log(`[wait] ${remaining}s remaining (chain time) until refund() is callable...`);
    await sleep(Math.min(remaining, 30) * 1000);
  }

  const takerBalBefore = await fxrp.balanceOf(takerWallet.address);
  console.log(`[refund] calling refund()...`);
  // Retry once or twice on RefundTooEarly to absorb any residual boundary/skew.
  let refundReceipt;
  for (let attempt = 1; ; attempt++) {
    try {
      const refundTx = await escrow.connect(deployerWallet).refund(lockResult.matchId);
      refundReceipt = await refundTx.wait();
      break;
    } catch (e) {
      if (attempt >= 4) throw e;
      console.log(`[refund] not callable yet (attempt ${attempt}) — waiting 20s for chain time...`);
      await sleep(20000);
    }
  }
  console.log(`[refund] confirmed: ${refundReceipt.hash}`);

  const takerBalAfter = await fxrp.balanceOf(takerWallet.address);
  const delta = takerBalAfter - takerBalBefore;
  const expected = lockResult.amountFxrp + lockResult.bondAmount;
  if (delta !== expected) {
    throw new Error(`default-path FAILED: taker FXRP balance changed by ${delta}, expected ${expected}`);
  }

  console.log("");
  console.log(
    `GO: default-path E2E complete. Taker received principal (${lockResult.amountFxrp}) + ` +
      `slashed bond (${lockResult.bondAmount}) = ${delta} raw FXRP.`
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`\nNO-GO: default-path failed — ${err.stack || err.message}`);
    process.exit(1);
  });
}
