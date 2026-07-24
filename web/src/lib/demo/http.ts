// http.ts — tiny shared helpers for the demo API routes: consistent JSON error shape
// ({error:string}) and a message extractor that never echoes secret material (the actual
// redaction happens at the source — env.ts's createDemoWallet and xrplPay.ts's Wallet.fromSeed
// call both already sanitize the errors they throw before they ever reach here).
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
