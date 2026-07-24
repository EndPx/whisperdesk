// xrplPay.ts — TS port of scripts/e2e/lib/xrplPay.mjs (itself adapted from
// scripts/fdc-spike/pay.mjs), parameterized on amountDrops/destinationTag/takerAddress instead of
// hardcoded constants, since the real destinationTag and xrpDrops come from DvPEscrow's own
// MatchLocked event (assigned on-chain inside lock(), not chosen by us).
import { Client, Wallet } from "xrpl";

export interface PayXrplParams {
  wss: string;
  makerSeed: string;
  takerAddress: string;
  amountDrops: string | number | bigint;
  destinationTag: number;
  finalityWaitMs?: number;
  onProgress?: (msg: string) => void;
}

export interface PayXrplResult {
  txHash: string;
  makerAddress: string;
  takerAddress: string;
  amountDrops: string;
  destinationTag: number;
  ledgerIndex: number;
}

/// Sends `amountDrops` drops from the wallet derived from `makerSeed` to `takerAddress` with
/// `destinationTag`, waits for XRPL validation, then waits `finalityWaitMs` more for FDC's XRPL
/// finality window (~3 confirmations, flare-docs/fdc.md §3 "Finality XRPL") before the caller
/// requests an attestation for this transaction.
export async function payXrpl({
  wss,
  makerSeed,
  takerAddress,
  amountDrops,
  destinationTag,
  finalityWaitMs = 15000,
  onProgress,
}: PayXrplParams): Promise<PayXrplResult> {
  const log = onProgress || (() => {});
  const client = new Client(wss);
  await client.connect();
  try {
    let maker: Wallet;
    try {
      maker = Wallet.fromSeed(makerSeed);
    } catch {
      // Never let a malformed-seed error surface (or embed) the raw seed value.
      throw new Error("demo/xrplPay: XRPL maker seed is invalid or malformed (value redacted)");
    }
    log(`maker XRPL address: ${maker.address}`);
    log(`taker XRPL address: ${takerAddress}`);
    log(`amount: ${amountDrops} drops, destinationTag: ${destinationTag}`);

    const tx = {
      TransactionType: "Payment" as const,
      Account: maker.address,
      Destination: takerAddress,
      Amount: String(amountDrops),
      DestinationTag: destinationTag,
    };

    const prepared = await client.autofill(tx);
    const signed = maker.sign(prepared);
    log(`submitting tx hash: ${signed.hash}`);

    const result = await client.submitAndWait(signed.tx_blob);
    const meta = result.result.meta;
    const engineResult =
      meta && typeof meta === "object" && "TransactionResult" in meta
        ? (meta as { TransactionResult: string }).TransactionResult
        : undefined;
    log(`engine result: ${engineResult}`);
    if (engineResult !== "tesSUCCESS") {
      throw new Error(`demo/xrplPay.payXrpl: XRPL payment did not succeed: ${engineResult}`);
    }

    const ledgerIndex = result.result.ledger_index as number;
    log(`validated in ledger ${ledgerIndex}; waiting ${finalityWaitMs}ms for FDC finality window...`);
    await new Promise((r) => setTimeout(r, finalityWaitMs));

    return {
      txHash: signed.hash!,
      makerAddress: maker.address,
      takerAddress,
      amountDrops: String(amountDrops),
      destinationTag,
      ledgerIndex,
    };
  } finally {
    await client.disconnect();
  }
}
