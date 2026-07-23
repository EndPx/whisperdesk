// xrplPay.mjs — adapted from scripts/fdc-spike/pay.mjs (Step 2), parameterized on
// amountDrops/destinationTag/takerAddress instead of the spike's hardcoded constants, since the
// real destinationTag and xrpDrops here come from DvPEscrow's own MatchLocked event (assigned
// on-chain inside lock(), not chosen by us).
import { Client, Wallet } from "xrpl";

/// Sends `amountDrops` drops from the wallet derived from `makerSeed` to `takerAddress` with
/// `destinationTag`, waits for XRPL validation, then waits `finalityWaitMs` more for FDC's
/// XRPL finality window (~3 confirmations, flare-docs/fdc.md §3 "Finality XRPL") before the
/// caller requests an attestation for this transaction. Returns the info the FDC request step
/// needs.
export async function payXrpl({ wss, makerSeed, takerAddress, amountDrops, destinationTag, finalityWaitMs = 15000, onProgress }) {
  const log = onProgress || (() => {});
  const client = new Client(wss);
  await client.connect();
  try {
    const maker = Wallet.fromSeed(makerSeed);
    log(`maker XRPL address: ${maker.address}`);
    log(`taker XRPL address: ${takerAddress}`);
    log(`amount: ${amountDrops} drops, destinationTag: ${destinationTag}`);

    const tx = {
      TransactionType: "Payment",
      Account: maker.address,
      Destination: takerAddress,
      Amount: String(amountDrops),
      DestinationTag: destinationTag,
    };

    const prepared = await client.autofill(tx);
    const signed = maker.sign(prepared);
    log(`submitting tx hash: ${signed.hash}`);

    const result = await client.submitAndWait(signed.tx_blob);
    const engineResult = result.result.meta?.TransactionResult;
    log(`engine result: ${engineResult}`);
    if (engineResult !== "tesSUCCESS") {
      throw new Error(`xrplPay.payXrpl: XRPL payment did not succeed: ${engineResult}`);
    }

    const ledgerIndex = result.result.ledger_index;
    log(`validated in ledger ${ledgerIndex}; waiting ${finalityWaitMs}ms for FDC finality window...`);
    await new Promise((r) => setTimeout(r, finalityWaitMs));

    return { txHash: signed.hash, makerAddress: maker.address, takerAddress, amountDrops, destinationTag, ledgerIndex };
  } finally {
    await client.disconnect();
  }
}
