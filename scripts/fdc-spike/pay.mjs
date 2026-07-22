// pay.mjs — Step 2 FDC spike, phase 2.
// Maker (XRPL_MAKER_SEED) pays 1 XRP (1,000,000 drops) to XRPL_TAKER_ADDRESS with destination
// tag 12345 on XRPL Testnet, waits for validation, then waits ~12s more for the 3-confirmation
// finality window FDC's XRPPayment attestors require (flare-docs/fdc.md §3 "Finality XRPL").
// Prints the tx hash and writes scripts/fdc-spike/out/payment.json for attest.mjs to consume.
//
// NOT executed by this task run (Step 2 scaffolding phase is dry-validation only, no live
// payment) — this file is written and ready for the phase-2 human/CI trigger.
import "dotenv/config";
import { Client, Wallet, xrpToDrops } from "xrpl";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PAYMENT_DROPS, DESTINATION_TAG, OUT_DIR } from "./config.mjs";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

async function main() {
  const wss = process.env.XRPL_TESTNET_WSS || "wss://s.altnet.rippletest.net:51233";
  const makerSeed = requireEnv("XRPL_MAKER_SEED");
  const takerAddress = requireEnv("XRPL_TAKER_ADDRESS");

  const client = new Client(wss);
  await client.connect();
  try {
    const maker = Wallet.fromSeed(makerSeed);
    console.log(`maker address: ${maker.address}`);
    console.log(`taker address: ${takerAddress}`);
    console.log(`amount: ${PAYMENT_DROPS} drops, destinationTag: ${DESTINATION_TAG}`);

    const tx = {
      TransactionType: "Payment",
      Account: maker.address,
      Destination: takerAddress,
      Amount: PAYMENT_DROPS,
      DestinationTag: DESTINATION_TAG,
    };

    const prepared = await client.autofill(tx);
    const signed = maker.sign(prepared);
    console.log(`submitting tx hash: ${signed.hash}`);

    const result = await client.submitAndWait(signed.tx_blob);
    const engineResult = result.result.meta?.TransactionResult;
    console.log(`engine result: ${engineResult}`);
    if (engineResult !== "tesSUCCESS") {
      throw new Error(`XRPL payment did not succeed: ${engineResult}`);
    }

    const ledgerIndex = result.result.ledger_index;
    console.log(`validated in ledger ${ledgerIndex}`);

    // FDC finality window for XRPL: 3 confirmations ≈ 12s (flare-docs/fdc.md). Wait for 3 more
    // validated ledgers to close (XRPL ledgers close roughly every ~3-5s) before attest.mjs
    // requests the attestation, so the source data is guaranteed final at request time.
    console.log("waiting ~15s for FDC finality window (3 confirmations)...");
    await new Promise((r) => setTimeout(r, 15000));

    const txHash = signed.hash;
    mkdirSync(fileURLToPath(OUT_DIR), { recursive: true });
    writeFileSync(
      fileURLToPath(new URL("payment.json", OUT_DIR)),
      JSON.stringify(
        {
          txHash,
          makerAddress: maker.address,
          takerAddress,
          amountDrops: PAYMENT_DROPS,
          destinationTag: DESTINATION_TAG,
          ledgerIndex,
          submittedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
    console.log(`\nTX_HASH=${txHash}`);
    console.log(`Saved out/payment.json`);
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
