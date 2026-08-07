// maker.ts — server-side helpers for "maker mode": a judge brings their own wallet as the MAKER
// (buys FXRP, pays XRP, posts the 1% bond, receives FXRP at release); the desk (this server) is the
// TAKER (sells FXRP, receives XRP) — the mirror image of wallet-mode.ts, where the judge is the
// taker and the desk is the maker. See this task's return notes for the full sealing decision;
// short version: onchain steps (submitRfq/triggerMatch/lock) are plain ethers.js, reusing flow.ts's
// setupClients/readLiveFtsoMid exactly as the one-click/wallet-mode flows do; sealing (ECIES
// encrypt, POST /direct submit) shells out to wd-client via wdClient.ts.
//
// Reuses (does NOT re-implement): env.ts, config.ts, abi.ts, matchInstruction.ts (WD_MATCH_TAG,
// ethSignedDigest, dataHash — for the local signature-verification cross-check), flow.ts
// (setupClients/readLiveFtsoMid/fundTakerDeposit), fdc.ts (submitAttestationRequest — reused
// verbatim for /api/maker/settle), xrplPay.ts (payXrpl), wallet-mode.ts
// (generateAndFundXrplAccount/getXrplBalance/getWalletStatus), state.ts (the shared run lock).
//
// SECURITY, per the fixed maker-mode API contract:
//   - The judge's private key never reaches this server: they sign the EIP-712 Quote in their own
//     wallet; this module only forwards the signature to the enclave (via wdEncrypt/wdSubmitQuote).
//   - The judge's bond deposit (approve + depositBond) is THEIR transaction — this module only
//     returns the call parameters (see buildOpenRfq's approve/depositBond fields).
//   - /api/maker/pay must derive destination/xrpDrops/destinationTag ONLY from the server-side
//     record buildMatch() writes (getMatchRecord/putMatchRecord below) — never from the client
//     request body, same invariant as wallet-mode.ts's prepareStore.
import { ethers } from "ethers";
import { Client } from "xrpl";
import { XRPL_TESTNET_WSS } from "./config";
import { dataHash, ethSignedDigest } from "./matchInstruction";
import { type DemoClients, fundTakerDeposit, readLiveFtsoMid, setupClients } from "./flow";
import { type MakerEnv } from "./makerEnv";
import { wdEncrypt, wdSubmitQuote } from "./wdClient";
import { generateAndFundXrplAccount, type FreshXrplAccount } from "./wallet-mode";
import { payXrpl } from "./xrplPay";

// ---------------------------------------------------------------------------------------------
// WhisperDeskInstructionSender — minimal ABI (contracts/src/WhisperDeskInstructionSender.sol).
// Not added to abi.ts (a verbatim DvPEscrow port kept in sync elsewhere) since this is a different
// contract, only needed by maker mode.
// ---------------------------------------------------------------------------------------------
const SENDER_ABI = [
  "function submitRfq(bytes calldata ciphertext) external payable returns (bytes32)",
  "function triggerMatch(bytes32 rfqId) external payable returns (bytes32)",
  "event SealedRfqSubmitted(bytes32 indexed instructionId, address indexed taker)",
  "event MatchTriggered(bytes32 indexed instructionId, bytes32 indexed rfqId, address indexed caller)",
];

// ---------------------------------------------------------------------------------------------
// Deadline knobs — mirrors wallet-mode.ts's WALLET_MODE_DEADLINE_SECONDS reasoning: no contract-
// enforced maximum, pure UX choice giving the judge time to click through approve -> depositBond ->
// sign-quote across two wallet popups (their EVM wallet for the bond, nothing for the quote sig
// beyond the signature itself).
// ---------------------------------------------------------------------------------------------
export const MAKER_MODE_ARMED_SECONDS = 30 * 60;

// The taker (desk) sells at 3% below the live FTSOv2 mid — mirrors
// scripts/enclave-loop/onchain-loop.mjs's own margin exactly ("comfortably satisfied by a quote
// struck at mid"), so any maker quote at/near the live mid clears the matcher's limit check.
const TAKER_LIMIT_NUM = BigInt(97);
const TAKER_LIMIT_DEN = BigInt(100);

// ---------------------------------------------------------------------------------------------
// Enclave HTTP — plain fetch, mirroring onchain-loop.mjs's own pollResultTagged/payload helpers
// exactly (no wire-format risk here: these are GET requests whose response shape onchain-loop.mjs
// already reverse-engineered and consumes directly in JS).
// ---------------------------------------------------------------------------------------------

export interface ActionResult {
  data: string; // 0x-hex-encoded JSON payload
  status: number; // 1 = success, 0 = WD_ERR_*
  log: string; // "" on success, "WD_ERR_*" on failure
}

/// Polls GET {extProxyUrl}/action/result/{actionId}[?submissionTag=<tag>] until a result appears or
/// timeoutMs elapses. `tag` must be omitted for onchain-instruction results (RFQ_SUBMIT's ack,
/// RFQ_MATCH's match response — the default/threshold tag) and set to "submit" for /direct-submitted
/// results (QUOTE_SUBMIT's ack) — exactly the distinction onchain-loop.mjs's pollResult vs
/// pollResultTagged(id, "submit", ...) makes.
export async function pollActionResult(
  extProxyUrl: string,
  actionId: string,
  opts: { tag?: string; timeoutMs?: number; everyMs?: number } = {}
): Promise<ActionResult> {
  const { tag, timeoutMs = 60_000, everyMs = 3_000 } = opts;
  const url = `${extProxyUrl}/action/result/${actionId}` + (tag ? `?submissionTag=${tag}` : "");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        const body = await res.json();
        if (body?.result) return body.result as ActionResult;
      }
    } catch {
      // transient — keep polling
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`maker: timed out waiting for enclave result ${actionId}${tag ? ` (tag ${tag})` : ""}`);
}

/// Decodes an ActionResult's 0x-hex `data` field into its JSON payload (RfqAck / QuoteAck /
/// MatchResponse — see extension/fcewire/PROTOCOL.md §4). Only meaningful when status===1.
export function decodeActionPayload<T>(result: ActionResult): T {
  return JSON.parse(Buffer.from(result.data.slice(2), "hex").toString("utf8")) as T;
}

export interface RfqAck {
  rfqId: string;
  windowEndsAt: number;
}

export interface QuoteAck {
  rfqId: string;
  accepted: boolean;
  replaced: boolean;
}

export interface MatchWire {
  matchId: string;
  escrow: string;
  taker: string;
  maker: string;
  amountFxrp: string;
  priceUsd18: string;
  takerXrplAddress: string;
  instructionExpiresAt: number;
}

export interface MatchResponse {
  outcome: "MATCHED" | "NO_MATCH";
  reasons?: Record<string, number>;
  match?: MatchWire;
  abiEncoded?: string;
  teeSignature?: string;
}

// ---------------------------------------------------------------------------------------------
// In-memory stores. Same pattern/TTL as wallet-mode.ts's prepareStore — a demo guard, not a
// security boundary (DvPEscrow enforces every settlement rule on-chain regardless).
// ---------------------------------------------------------------------------------------------
const RECORD_TTL_MS = 10 * 60 * 1000;

interface RfqRecord {
  windowEndsAt: number;
  createdAt: number;
}
const rfqStore = new Map<string, RfqRecord>();

export function putRfqRecord(rfqId: string, windowEndsAt: number): void {
  rfqStore.set(rfqId, { windowEndsAt, createdAt: Date.now() });
}

export function getRfqRecord(rfqId: string): RfqRecord | null {
  const rec = rfqStore.get(rfqId);
  if (!rec) return null;
  if (Date.now() - rec.createdAt > RECORD_TTL_MS) {
    rfqStore.delete(rfqId);
    return null;
  }
  return rec;
}

/** Every RFQ still inside its quoting window, newest first — the shared queue two makers meet in.
 *
 *  This store is a module-level Map on a single node, so an RFQ opened in one browser is already
 *  visible to every other session. That is what lets two independent makers quote the SAME sealed
 *  RFQ and compete on price — the one claim the desk could never demonstrate live before. The
 *  matcher has always supported it; every run so far simply had a single maker in it.
 *
 *  Note what is NOT returned: no side, no size, no limit, no taker, and no count of who else is
 *  quoting. A maker learns that an RFQ exists and when its window closes, and nothing that would
 *  let them shade a price against the order or against a rival.
 *
 *  windowEndsAt is epoch SECONDS (it comes from the enclave); createdAt is epoch milliseconds
 *  (Date.now()). Mixing those two up would silently expire every RFQ instantly. */
export function listOpenRfqs(): { rfqId: string; windowEndsAt: number }[] {
  const now = Date.now();
  const open: { rfqId: string; windowEndsAt: number; createdAt: number }[] = [];
  for (const [rfqId, rec] of rfqStore) {
    if (now - rec.createdAt > RECORD_TTL_MS) {
      rfqStore.delete(rfqId);
      continue;
    }
    if (rec.windowEndsAt * 1000 <= now) continue; // window already closed — nothing to quote into
    open.push({ rfqId, windowEndsAt: rec.windowEndsAt, createdAt: rec.createdAt });
  }
  return open
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ rfqId, windowEndsAt }) => ({ rfqId, windowEndsAt }));
}

interface MatchRecord {
  xrplDestination: string;
  xrpDrops: string;
  destinationTag: number;
  paymentDeadline: number;
  xrplTx?: string;
  createdAt: number;
}
const matchStore = new Map<string, MatchRecord>();

export function putMatchRecord(matchId: string, rec: Omit<MatchRecord, "createdAt">): void {
  matchStore.set(matchId, { ...rec, createdAt: Date.now() });
}

export function getMatchRecord(matchId: string): MatchRecord | null {
  const rec = matchStore.get(matchId);
  if (!rec) return null;
  if (Date.now() - rec.createdAt > RECORD_TTL_MS) {
    matchStore.delete(matchId);
    return null;
  }
  return rec;
}

export function recordMatchPayment(matchId: string, xrplTx: string): void {
  const rec = matchStore.get(matchId);
  if (rec) rec.xrplTx = xrplTx;
}

// The maker's (judge's) throwaway XRPL account, generated by /api/maker/xrpl-account. The fixed API
// contract's POST /api/maker/pay takes ONLY {matchId} — no address/seed — so there is no client-
// supplied key to correlate an account to a later match. This app already assumes a single in-flight
// run at a time (state.ts's run lock enforces it for the EVM side); we make the same assumption
// here: "the most recently generated maker XRPL account" is unambiguous because only one maker-mode
// run can be mid-flight at once. A production, multi-tenant version would key this per-session
// instead.
let currentMakerXrplAccount: (FreshXrplAccount & { createdAt: number }) | null = null;

export function setCurrentMakerXrplAccount(account: FreshXrplAccount): void {
  currentMakerXrplAccount = { ...account, createdAt: Date.now() };
}

export function getCurrentMakerXrplAccount(): FreshXrplAccount | null {
  if (!currentMakerXrplAccount) return null;
  if (Date.now() - currentMakerXrplAccount.createdAt > RECORD_TTL_MS) {
    currentMakerXrplAccount = null;
    return null;
  }
  return currentMakerXrplAccount;
}

export { generateAndFundXrplAccount };

// ---------------------------------------------------------------------------------------------
// /api/maker/open-rfq — desk (taker) funds its deposit, seals + submits an RFQ, returns the maker's
// bond call parameters + the rfqId to quote against.
// ---------------------------------------------------------------------------------------------

export interface OpenRfqResult {
  rfqId: string;
  windowEndsAt: string;
  escrow: string;
  bondLedger: string;
  bondAmount: string;
  approve: { token: string; spender: string; amount: string };
  depositBond: { amount: string };
}

export async function buildOpenRfq(env: MakerEnv): Promise<OpenRfqResult> {
  const clients: DemoClients = await setupClients(env, { requireOwnerIsTeeSigner: false });
  const { escrow, fxrp, bondLedger, ftso, takerWallet } = clients;

  const minBlock: bigint = await escrow.MIN_BLOCK_FXRP();
  const bondBips: bigint = await escrow.BOND_BIPS();
  const bondAmount = (minBlock * bondBips) / BigInt(10000);

  // Fund the desk's OWN taker deposit — armed long enough for the judge to click through
  // approve/depositBond/quote (mirrors wallet-mode.ts's WALLET_MODE_DEADLINE_SECONDS reasoning).
  await fundTakerDeposit(clients, takerWallet, minBlock, MAKER_MODE_ARMED_SECONDS + 300);

  const { mid18 } = await readLiveFtsoMid(ftso);
  const takerLimit = (mid18 * TAKER_LIMIT_NUM) / TAKER_LIMIT_DEN;

  const rfqPlaintext = {
    v: 1,
    taker: takerWallet.address,
    side: "SELL_FXRP",
    fxrpAmountRaw: minBlock.toString(),
    limitPriceUsdE18: takerLimit.toString(),
    xrplAddress: env.xrplTakerAddress,
  };

  const ciphertext = await wdEncrypt(env, rfqPlaintext);

  const sender = new ethers.Contract(env.senderAddress, SENDER_ABI, takerWallet);
  const tx = await sender.submitRfq(ciphertext, { value: env.relayFeeWei });
  const receipt = await tx.wait();

  const sealedEvent = receipt.logs
    .map((l: ethers.Log) => {
      try {
        return sender.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e: ethers.LogDescription | null): e is ethers.LogDescription => e !== null && e.name === "SealedRfqSubmitted");
  if (!sealedEvent) {
    throw new Error("maker/open-rfq: SealedRfqSubmitted event not found in submitRfq() receipt logs");
  }
  const rfqId = sealedEvent.args.instructionId as string;
  if ((sealedEvent.args.taker as string).toLowerCase() !== takerWallet.address.toLowerCase()) {
    throw new Error("maker/open-rfq: taker in SealedRfqSubmitted != desk taker wallet — sender binding broken");
  }

  const result = await pollActionResult(env.extProxyUrl, rfqId, { timeoutMs: 60_000 });
  if (result.status !== 1) {
    throw new Error(`maker/open-rfq: RFQ_SUBMIT failed: status=${result.status} log=${JSON.stringify(result.log)}`);
  }
  const ack = decodeActionPayload<RfqAck>(result);

  putRfqRecord(ack.rfqId, ack.windowEndsAt);

  return {
    rfqId: ack.rfqId,
    windowEndsAt: String(ack.windowEndsAt),
    escrow: await escrow.getAddress(),
    bondLedger: await bondLedger.getAddress(),
    bondAmount: bondAmount.toString(),
    approve: { token: await fxrp.getAddress(), spender: await bondLedger.getAddress(), amount: bondAmount.toString() },
    depositBond: { amount: bondAmount.toString() },
  };
}

/** The same payload as buildOpenRfq, but for an RFQ someone ELSE already opened.
 *
 *  This is what makes a second maker possible. buildOpenRfq seals a fresh RFQ and funds a desk taker
 *  deposit behind it; calling it again would produce a second, unrelated order rather than a rival
 *  quote. Joining reuses the existing rfqId, so two wallets end up quoting one sealed RFQ and the
 *  enclave decides between them on price.
 *
 *  Everything here except rfqId/windowEndsAt is an escrow constant — note especially that
 *  bondAmount derives from MIN_BLOCK_FXRP, not from the RFQ's actual size. That is what keeps this
 *  route from leaking the very field the desk promises to seal: were the bond 1% of the real
 *  notional, handing it to a maker would hand them the order size with it. */
export async function buildJoinRfq(env: MakerEnv, rfqId: string): Promise<OpenRfqResult> {
  const rec = getRfqRecord(rfqId);
  if (!rec) throw new Error("that RFQ is no longer open — pick another from the queue");

  const clients: DemoClients = await setupClients(env, { requireOwnerIsTeeSigner: false });
  const { escrow, fxrp, bondLedger } = clients;

  const minBlock: bigint = await escrow.MIN_BLOCK_FXRP();
  const bondBips: bigint = await escrow.BOND_BIPS();
  const bondAmount = (minBlock * bondBips) / BigInt(10000);

  const bondLedgerAddress = await bondLedger.getAddress();
  return {
    rfqId,
    windowEndsAt: String(rec.windowEndsAt),
    escrow: await escrow.getAddress(),
    bondLedger: bondLedgerAddress,
    bondAmount: bondAmount.toString(),
    approve: { token: await fxrp.getAddress(), spender: bondLedgerAddress, amount: bondAmount.toString() },
    depositBond: { amount: bondAmount.toString() },
  };
}

// ---------------------------------------------------------------------------------------------
// /api/maker/quote — seal + submit the maker's own EIP-712-signed Quote over /direct.
// ---------------------------------------------------------------------------------------------

export interface QuoteInput {
  rfqId: string;
  maker: string;
  priceUsdE18: string;
  maxFxrpRaw: string;
  nonce: string;
  sig: string;
}

const QUOTE_EIP712_TYPES = {
  Quote: [
    { name: "rfqId", type: "bytes32" },
    { name: "maker", type: "address" },
    { name: "priceUsdE18", type: "uint256" },
    { name: "maxFxrpRaw", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

/// Fast-fail check BEFORE spending an encrypt+submit round trip: recovers the EIP-712 signer and
/// requires it to equal the claimed maker. The enclave re-verifies this itself either way
/// (quoteauth.go's VerifyQuoteSignature — WD_ERR_AUTH on mismatch); this is purely a nicer/faster
/// 400 for the caller instead of an opaque enclave rejection several seconds later.
export function verifyQuoteSignature(env: MakerEnv, input: QuoteInput): boolean {
  const domain = {
    name: "WhisperDesk",
    version: "1",
    chainId: 114,
    verifyingContract: ethers.getAddress(env.escrowAddress),
  };
  const value = {
    rfqId: input.rfqId,
    maker: input.maker,
    priceUsdE18: input.priceUsdE18,
    maxFxrpRaw: input.maxFxrpRaw,
    nonce: input.nonce,
  };
  try {
    const recovered = ethers.verifyTypedData(domain, QUOTE_EIP712_TYPES, value, input.sig);
    return recovered.toLowerCase() === input.maker.toLowerCase();
  } catch {
    return false;
  }
}

export async function submitQuote(env: MakerEnv, input: QuoteInput): Promise<QuoteAck> {
  const quotePlaintext = {
    v: 1,
    rfqId: input.rfqId,
    maker: input.maker,
    priceUsdE18: input.priceUsdE18,
    maxFxrpRaw: input.maxFxrpRaw,
    nonce: input.nonce,
    sig: input.sig,
  };

  const ciphertext = await wdEncrypt(env, quotePlaintext);
  const actionId = await wdSubmitQuote(env, ciphertext);
  const result = await pollActionResult(env.extProxyUrl, actionId, { tag: "submit", timeoutMs: 30_000 });
  if (result.status !== 1) {
    throw new Error(result.log || "QUOTE_SUBMIT rejected");
  }
  return decodeActionPayload<QuoteAck>(result);
}

// ---------------------------------------------------------------------------------------------
// /api/maker/match — trigger matching (waiting out the RFQ auction window first, if known), then
// lock() with the enclave-signed MatchInstruction, verifying the TEE signature locally before ever
// submitting it on-chain.
// ---------------------------------------------------------------------------------------------

export interface MatchOutcome {
  outcome: "MATCHED" | "NO_MATCH";
  reasons?: Record<string, number>;
  matchId?: string;
  xrpDrops?: string;
  destinationTag?: number;
  xrplDestination?: string;
  paymentDeadline?: number;
}

/// Independently verifies a MatchResponse's teeSignature against the escrow's own on-chain
/// teeSigner() BEFORE trusting it — reuses matchInstruction.ts's dataHash/ethSignedDigest (the same
/// functions the taker-mode/wallet-mode signing path uses), so this is a from-source cross-check,
/// not a re-implementation. Mirrors wd-client loop.go's matchsig.VerifyMatch.
async function verifyMatchSignature(
  escrow: ethers.Contract,
  chainId: bigint,
  abiEncoded: string,
  teeSignature: string
): Promise<{ verified: boolean; recovered: string; expected: string }> {
  const dHash = dataHash(abiEncoded);
  const digest = ethSignedDigest(dHash, chainId);
  const recovered = ethers.recoverAddress(digest, teeSignature);
  const expected: string = await escrow.teeSigner();
  return { verified: recovered.toLowerCase() === expected.toLowerCase(), recovered, expected };
}

export async function triggerMatchAndLock(env: MakerEnv, rfqId: string): Promise<MatchOutcome> {
  const clients: DemoClients = await setupClients(env, { requireOwnerIsTeeSigner: false });
  const { escrow, ftso, provider, ownerWallet, takerWallet } = clients;

  const rfqRecord = getRfqRecord(rfqId);
  if (rfqRecord) {
    const waitMs = rfqRecord.windowEndsAt * 1000 - Date.now() + 5_000;
    const cappedWaitMs = Math.min(Math.max(waitMs, 0), 5 * 60 * 1000); // never block past 5 minutes
    if (cappedWaitMs > 0) {
      await new Promise((r) => setTimeout(r, cappedWaitMs));
    }
  }

  const sender = new ethers.Contract(env.senderAddress, SENDER_ABI, ownerWallet);

  let matchResult: ActionResult | null = null;
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tx = await sender.triggerMatch(rfqId, { value: env.relayFeeWei });
    const receipt = await tx.wait();
    const triggeredEvent = receipt.logs
      .map((l: ethers.Log) => {
        try {
          return sender.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: ethers.LogDescription | null): e is ethers.LogDescription => e !== null && e.name === "MatchTriggered");
    if (!triggeredEvent) {
      throw new Error("maker/match: MatchTriggered event not found in triggerMatch() receipt logs");
    }
    const instructionId = triggeredEvent.args.instructionId as string;
    const result = await pollActionResult(env.extProxyUrl, instructionId, { timeoutMs: 60_000 });

    if (result.status === 1 || result.log !== "WD_ERR_WINDOW_OPEN" || attempt === maxAttempts - 1) {
      matchResult = result;
      break;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  if (!matchResult) {
    throw new Error("maker/match: RFQ_MATCH produced no result (unreachable)");
  }
  if (matchResult.status !== 1) {
    throw new Error(`maker/match: RFQ_MATCH failed: status=${matchResult.status} log=${JSON.stringify(matchResult.log)}`);
  }

  const matchResp = decodeActionPayload<MatchResponse>(matchResult);
  if (matchResp.outcome !== "MATCHED") {
    return { outcome: "NO_MATCH", reasons: matchResp.reasons };
  }
  if (!matchResp.match || !matchResp.abiEncoded || !matchResp.teeSignature) {
    throw new Error("maker/match: outcome=MATCHED but match/abiEncoded/teeSignature is missing — malformed MatchResponse");
  }

  const network = await provider.getNetwork();
  const { verified, recovered, expected } = await verifyMatchSignature(
    escrow,
    network.chainId,
    matchResp.abiEncoded,
    matchResp.teeSignature
  );
  if (!verified) {
    throw new Error(
      `maker/match: refusing to submit — TEE signature does not verify (ecrecover ${recovered} != escrow.teeSigner() ${expected})`
    );
  }

  const { fee } = await readLiveFtsoMid(ftso);
  const escrowAsTaker = escrow.connect(takerWallet) as ethers.Contract;
  const lockTx = await escrowAsTaker.lock(matchResp.abiEncoded, matchResp.teeSignature, { value: fee });
  const lockReceipt = await lockTx.wait();

  const lockedEvent = lockReceipt.logs
    .map((l: ethers.Log) => {
      try {
        return escrow.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e: ethers.LogDescription | null): e is ethers.LogDescription => e !== null && e.name === "MatchLocked");
  if (!lockedEvent) {
    throw new Error("maker/match: MatchLocked event not found in lock() receipt logs");
  }

  const matchId = matchResp.match.matchId;
  const xrpDrops = (lockedEvent.args.xrpDrops as bigint).toString();
  const destinationTag = Number(lockedEvent.args.destinationTag);
  const paymentDeadline = Number(lockedEvent.args.paymentDeadline);
  const xrplDestination = lockedEvent.args.takerXrplAddress as string;

  putMatchRecord(matchId, { xrplDestination, xrpDrops, destinationTag, paymentDeadline });

  return { outcome: "MATCHED", matchId, xrpDrops, destinationTag, xrplDestination, paymentDeadline };
}

// ---------------------------------------------------------------------------------------------
// /api/maker/pay + /api/maker/payment-status — the maker's own throwaway XRPL account pays the
// desk's taker XRPL address; payment-status polls XRPL directly so a maker who pays MANUALLY (not
// via /api/maker/pay) is also detected.
// ---------------------------------------------------------------------------------------------

export interface PayResult {
  xrplTx: string;
}

export async function payFromMakerAccount(matchId: string): Promise<PayResult> {
  const record = getMatchRecord(matchId);
  if (!record) {
    throw Object.assign(new Error("unknown or expired matchId — run /api/maker/match again"), { code: "UNKNOWN_MATCH" });
  }
  const account = getCurrentMakerXrplAccount();
  if (!account) {
    throw Object.assign(new Error("no maker XRPL account on file — call POST /api/maker/xrpl-account first"), {
      code: "NO_ACCOUNT",
    });
  }

  const result = await payXrpl({
    wss: XRPL_TESTNET_WSS,
    makerSeed: account.seed,
    takerAddress: record.xrplDestination,
    amountDrops: record.xrpDrops,
    destinationTag: record.destinationTag,
  });

  recordMatchPayment(matchId, result.txHash);
  return { xrplTx: result.txHash };
}

export interface PaymentStatusResult {
  paid: boolean;
  xrplTx?: string;
}

/// Checks whether a payment matching the match's exact drops+tag has landed on
/// record.xrplDestination — regardless of who sent it (the /api/maker/pay flow OR a maker who paid
/// manually from any wallet), by scanning that address's recent transactions. Records the found tx
/// hash into the match record (so a later /api/maker/settle can read it) the same way
/// /api/maker/pay does.
export async function checkMakerPaymentStatus(matchId: string): Promise<PaymentStatusResult> {
  const record = getMatchRecord(matchId);
  if (!record) {
    throw Object.assign(new Error("unknown or expired matchId — run /api/maker/match again"), { code: "UNKNOWN_MATCH" });
  }
  if (record.xrplTx) {
    return { paid: true, xrplTx: record.xrplTx };
  }

  const client = new Client(XRPL_TESTNET_WSS);
  await client.connect();
  try {
    const resp = await client.request({
      command: "account_tx",
      account: record.xrplDestination,
      ledger_index_min: -1,
      ledger_index_max: -1,
      limit: 30,
    });
    // xrpl.js's AccountTxTransaction shape depends on the (unspecified here, so default/v2) API
    // version — tx_json + top-level hash for v2, tx (with an embedded hash) for v1. `any` here
    // avoids fighting that union for a read-only scan of well-known Payment fields.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const entry of (resp.result.transactions ?? []) as any[]) {
      const tx = entry.tx_json ?? entry.tx;
      const meta = entry.meta;
      if (!tx || !meta) continue;
      if (tx.TransactionType !== "Payment") continue;
      if (tx.Destination !== record.xrplDestination) continue;
      if (Number(tx.DestinationTag ?? -1) !== record.destinationTag) continue;
      if (String(tx.Amount) !== record.xrpDrops) continue;
      const txResult = typeof meta === "string" ? undefined : meta.TransactionResult;
      if (txResult !== "tesSUCCESS") continue;
      const hash: string | undefined = entry.hash ?? tx.hash;
      if (!hash) continue;
      recordMatchPayment(matchId, hash);
      return { paid: true, xrplTx: hash };
    }
    return { paid: false };
  } finally {
    await client.disconnect();
  }
}

// ---------------------------------------------------------------------------------------------
// /api/maker/settle — reads the match's confirmed XRPL tx (from pay/payment-status) and submits the
// FDC attestation request. GET /api/demo/proof + POST /api/demo/release (both UNCHANGED) finish the
// flow from here.
// ---------------------------------------------------------------------------------------------

export function getSettleInput(matchId: string): { xrplTx: string } {
  const record = getMatchRecord(matchId);
  if (!record) {
    throw Object.assign(new Error("unknown or expired matchId — run /api/maker/match again"), { code: "UNKNOWN_MATCH" });
  }
  if (!record.xrplTx) {
    throw Object.assign(
      new Error("payment not detected yet — call POST /api/maker/pay or poll GET /api/maker/payment-status first"),
      { code: "NOT_PAID" }
    );
  }
  return { xrplTx: record.xrplTx };
}
