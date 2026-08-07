// wallet-mode.ts — server-side helpers for "wallet mode": the judge connects THEIR OWN MetaMask as
// the taker; the desk (this server) is the maker/counterparty. Only the pieces that must stay
// server-side live here: minting demo FXRP, building + teeSigner-signing a MatchInstruction for the
// judge's own address, paying the real XRPL leg from the desk maker's XRPL seed, and reporting
// balances. Everything the judge's wallet itself sends (approve/deposit/lock) is assembled here as
// plain call parameters and returned to the client — this module never holds or spends the judge's
// funds.
//
// Reuses (does NOT re-implement) the existing demo lib: env.ts, config.ts, abi.ts,
// matchInstruction.ts, flow.ts (setupClients/readLiveFtsoMid/fundMakerBond), xrplPay.ts, state.ts.
//
// SECURITY, per the fixed wallet-mode API contract:
//   - /api/wallet/pay must derive the XRPL destination + drops + destinationTag ONLY from the
//     in-memory record `prepareStore` writes at /api/wallet/prepare time — NEVER from the client
//     request body. See getPrepareRecord()/putPrepareRecord() below.
//   - Faucet mints exactly FAUCET_MINT_RAW (2 FXRP) and is rate-limited to 1 claim per address per
//     FAUCET_RATE_LIMIT_MS. See checkAndRecordFaucetClaim().
//   - Never log, echo, or return env.ownerPrivateKey / env.makerPrivateKey / env.xrplMakerSeed (or
//     the freshly generated judge XRPL seed's own private material beyond the one intentional
//     xrpl-account response, which is a THROWAWAY testnet account — see xrpl-account/route.ts).
import crypto from "node:crypto";
import { ethers } from "ethers";
import { Client, dropsToXrp } from "xrpl";
import { DVP_ESCROW_ABI, MOCK_FXRP_ABI } from "./abi";
import { COSTON2_CHAIN_ID, XRPL_TESTNET_WSS } from "./config";
import { type DemoEnv } from "./env";
import { type DemoClients, fundMakerBond, readLiveFtsoMid, setupClients } from "./flow";
import { type MatchInstruction, signMatchInstruction } from "./matchInstruction";

// ---------------------------------------------------------------------------------------------
// Faucet: exactly 2 MockFXRP (6-dec) per claim, 1 claim per address per 10 minutes.
// ---------------------------------------------------------------------------------------------

export const FAUCET_MINT_HUMAN = "2";
export const FAUCET_MINT_RAW = BigInt(2_000_000); // 2 * 10^6, MockFXRP is 6-dec (matches abi.ts/flow.ts)
const FAUCET_RATE_LIMIT_MS = 10 * 60 * 1000;

export type FaucetScope = "wallet" | "maker";

// One map per faucet, NOT one shared map. The two faucets mint DIFFERENT MockFXRP contracts — the
// wallet faucet mints the demo escrow's token, the maker faucet the enclave-loop escrow's — so a
// shared limiter meant claiming one burned your claim on the other, leaving you holding a balance
// the escrow you were about to use could not see. That is exactly how it failed in testing.
const lastFaucetClaim: Record<FaucetScope, Map<string, number>> = {
  wallet: new Map(), // lowercased address -> claimedAt ms
  maker: new Map(),
};

/// Returns true (and records the claim) if `address` (already checksum-validated by the caller)
/// has not claimed within the last FAUCET_RATE_LIMIT_MS for THAT faucet; false if rate-limited.
export function checkAndRecordFaucetClaim(address: string, scope: FaucetScope = "wallet"): boolean {
  const key = address.toLowerCase();
  const now = Date.now();
  const map = lastFaucetClaim[scope];
  const last = map.get(key);
  if (last !== undefined && now - last < FAUCET_RATE_LIMIT_MS) {
    return false;
  }
  map.set(key, now);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Gas drip: enough C2FLR for a judge with an empty wallet to sign the demo's own transactions.
//
// Why it exists: every other funding step here is self-service — FXRP is minted above, the XRPL
// account is generated and faucet-funded by /api/wallet/xrpl-account — but Coston2 gas used to push
// a judge off-site to faucet.flare.network in the middle of a run, which is the likeliest place to
// lose them entirely.
//
// Unlike MockFXRP this spends a balance the desk cannot mint back — and it spends it from the SAME
// owner key that pays for the desk's own settlements (minting, locking, releasing). A drained owner
// does not merely disable this button; it takes the whole demo down. Hence four guards:
//   1. Per-address, one drip per GAS_RATE_LIMIT_MS — same window as the FXRP faucet.
//   2. Already-funded addresses are refused by the route before a claim slot is even spent, so a
//      full wallet cannot be cycled to pump the desk dry.
//   3. A hard global ceiling per UTC day, independent of how many addresses ask.
//   4. GAS_OWNER_RESERVE_WEI — the route refuses to drip at all once the owner's own balance would
//      fall below the reserve it needs to keep settling. This is the guard that matters: the daily
//      ceiling bounds a busy day, the reserve bounds a hostile one.
//
// The numbers are set against the owner's actual balance (~30 C2FLR when this was written), not
// against a round number: a budget larger than the balance is not a budget.
// ---------------------------------------------------------------------------------------------

export const GAS_DRIP_WEI = ethers.parseEther("0.5"); // ~50+ Coston2 transactions, generous but bounded
/** At or above this, the address can already pay for a transaction and the drip is pointless. */
export const GAS_ENOUGH_WEI = ethers.parseEther("0.1");
/** The desk keeps at least this much for its own settlements; drips stop before touching it. */
export const GAS_OWNER_RESERVE_WEI = ethers.parseEther("15");
const GAS_RATE_LIMIT_MS = 10 * 60 * 1000;
const GAS_DAILY_BUDGET_WEI = ethers.parseEther("10");

const lastGasClaim = new Map<string, number>(); // lowercased address -> claimedAt ms
let gasSpentToday = BigInt(0); // literal `0n` needs ES2020; this file's target is lower (see FAUCET_MINT_RAW)
let gasBudgetDay = "";

export type GasClaimRefusal = "rate-limited" | "budget-exhausted";

/// Authorises and records one drip for `address` (already checksum-validated by the caller).
/// Returns null when the drip may proceed, or the reason it was refused. The daily counter resets
/// on the first call of a new UTC day rather than on a timer, so there is no scheduler to drift.
export function checkAndRecordGasClaim(address: string): GasClaimRefusal | null {
  const key = address.toLowerCase();
  const now = Date.now();

  const last = lastGasClaim.get(key);
  if (last !== undefined && now - last < GAS_RATE_LIMIT_MS) {
    return "rate-limited";
  }

  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== gasBudgetDay) {
    gasBudgetDay = today;
    gasSpentToday = BigInt(0);
  }
  if (gasSpentToday + GAS_DRIP_WEI > GAS_DAILY_BUDGET_WEI) {
    return "budget-exhausted";
  }

  gasSpentToday += GAS_DRIP_WEI;
  lastGasClaim.set(key, now);
  return null;
}

// ---------------------------------------------------------------------------------------------
// Deadline knobs — see the route handlers + this task's return notes for which contract fields
// these bind and why 30 minutes was chosen (>= the required 25-minute judge click-through budget).
// ---------------------------------------------------------------------------------------------

/// Both MatchInstruction.instructionExpiresAt (checked by DvPEscrow.lock() against
/// block.timestamp) and the deposit() armedUntil we hand the client are set to now + this many
/// seconds. Neither field has a contract-enforced maximum (both are plain uint64 comparisons), so
/// this is a pure UX choice: 30 minutes clears the required 25-minute floor with a 5-minute margin
/// for RPC/wallet-popup latency across faucet -> xrpl-account -> prepare -> approve -> deposit ->
/// lock.
export const WALLET_MODE_DEADLINE_SECONDS = 30 * 60;

/// Safety margin applied to the XRPL amount the desk maker will actually pay in /api/wallet/pay.
/// DvPEscrow.lock() computes the REAL on-chain xrpDrops at lock() time as
/// `amountFxrp * signedPriceUsd18 / liveMid18AtLockTime`, using whatever FTSOv2 mid is live at the
/// moment the judge's wallet actually submits lock() — which may be up to
/// WALLET_MODE_DEADLINE_SECONDS later than when we signed priceUsd18 at the live mid here. Because
/// lock()'s own +/-1% band check (BAND_BIPS) permits up to 1% drift between our signed price and
/// the live mid at lock time, the true on-chain xrpDrops can be up to ~1.01x our snapshot estimate.
/// /api/wallet/pay cannot re-read the actual on-chain match (the fixed contract says it must use
/// ONLY the record written at prepare time), so we pay a 2% buffer over the snapshot estimate to
/// stay comfortably above the worst case and avoid an AmountTooLow revert in release().
const XRPL_PAY_BUFFER_NUM = BigInt(102);
const XRPL_PAY_BUFFER_DEN = BigInt(100);

// ---------------------------------------------------------------------------------------------
// XRPL testnet account generation (judge's throwaway taker-side XRPL wallet)
// ---------------------------------------------------------------------------------------------

export interface FreshXrplAccount {
  address: string;
  seed: string;
}

/// Generates a brand-new xrpl.js Wallet and funds it via the XRPL testnet faucet
/// (Client.fundWallet against the altnet faucet, wired through XRPL_TESTNET_WSS). Returning the
/// seed to the caller is intentional: this is a freshly generated, testnet-only, throwaway
/// account, never the desk's own maker seed.
export async function generateAndFundXrplAccount(): Promise<FreshXrplAccount> {
  const client = new Client(XRPL_TESTNET_WSS);
  await client.connect();
  try {
    const { wallet } = await client.fundWallet(undefined, {
      faucetHost: "faucet.altnet.rippletest.net",
    });
    return { address: wallet.address, seed: wallet.seed! };
  } finally {
    await client.disconnect();
  }
}

export interface XrplBalanceResult {
  exists: boolean;
  balanceXrp: string;
}

/// One-shot account_info lookup. An unactivated (never-funded) XRPL account is reported as
/// {exists:false, balanceXrp:"0"} — NOT an error; XRPL accounts don't exist on-ledger until their
/// first incoming payment meets the reserve.
export async function getXrplBalance(address: string): Promise<XrplBalanceResult> {
  const client = new Client(XRPL_TESTNET_WSS);
  await client.connect();
  try {
    const info = await client.request({ command: "account_info", account: address });
    const balanceDrops = info.result.account_data.Balance;
    return { exists: true, balanceXrp: String(dropsToXrp(balanceDrops)) };
  } catch (err) {
    if (isActNotFoundError(err)) {
      return { exists: false, balanceXrp: "0" };
    }
    throw err;
  } finally {
    await client.disconnect();
  }
}

function isActNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const data = (err as { data?: { error?: string } }).data;
  if (data?.error === "actNotFound") return true;
  const msg = (err as { message?: string }).message;
  return typeof msg === "string" && msg.includes("actNotFound");
}

// ---------------------------------------------------------------------------------------------
// /api/wallet/prepare in-memory store — matchId -> the XRPL leg /api/wallet/pay must send.
// Written ONLY by prepare(); read ONLY by pay(). 10-minute TTL, same window as state.ts's run lock.
// ---------------------------------------------------------------------------------------------

const PREPARE_RECORD_TTL_MS = 10 * 60 * 1000;

interface PrepareRecord {
  destination: string; // judge's XRPL address
  xrpDrops: string; // exact drops /api/wallet/pay will send (buffered, see XRPL_PAY_BUFFER_*)
  destinationTag: number;
  createdAt: number;
}

const prepareStore = new Map<string, PrepareRecord>();

export function putPrepareRecord(matchId: string, rec: Omit<PrepareRecord, "createdAt">): void {
  prepareStore.set(matchId, { ...rec, createdAt: Date.now() });
}

/// Returns the record for `matchId`, or null if never written or past its TTL (an expired entry is
/// also deleted so the store doesn't grow unbounded).
export function getPrepareRecord(matchId: string): Omit<PrepareRecord, "createdAt"> | null {
  const rec = prepareStore.get(matchId);
  if (!rec) return null;
  if (Date.now() - rec.createdAt > PREPARE_RECORD_TTL_MS) {
    prepareStore.delete(matchId);
    return null;
  }
  return rec;
}

// ---------------------------------------------------------------------------------------------
// /api/wallet/prepare — build the escrow-side call parameters + sign the MatchInstruction.
// ---------------------------------------------------------------------------------------------

// Minimal read-only ABI fragment for DvPEscrow.nextDestinationTag(), the auto-generated getter for
// the public `uint32 public nextDestinationTag` counter. Not added to abi.ts (which is a verbatim
// port kept in sync elsewhere) — declared locally since wallet-mode is the only caller that needs
// it, to predict the destinationTag DvPEscrow.lock() will assign.
const NEXT_DEST_TAG_ABI = ["function nextDestinationTag() view returns (uint32)"];

export interface WalletPrepareResult {
  matchId: string;
  approve: { token: string; spender: string; amount: string };
  deposit: { amount: string; armedUntil: string };
  lock: { to: string; instructionData: string; teeSignature: string; valueWei: string };
  xrpDrops: string;
  destinationTag: string;
  paymentDeadline: string;
  refundAfter: string;
}

/// Builds everything the judge's own wallet needs to approve() + deposit() + lock() itself, with
/// the desk (teeSigner) having already signed a MatchInstruction naming the judge as taker.
///
/// Predicting destinationTag: DvPEscrow assigns destinationTag = nextDestinationTag++ INSIDE
/// lock() itself, so it isn't known until the judge's own lock() tx executes. We predict it here
/// by reading the live nextDestinationTag() counter, which is safe ONLY because this whole demo
/// app serializes all lock()-bound flows through state.ts's single run lock (tryAcquireRunLock) —
/// no other lock() call (one-click OR wallet mode) can land between this read and the judge's own
/// lock() tx, so the counter cannot have moved.
///
/// Predicting xrpDrops: see XRPL_PAY_BUFFER_* doc comment above.
export async function buildWalletPrepare(
  env: DemoEnv,
  taker: string,
  takerXrplAddress: string
): Promise<WalletPrepareResult> {
  const clients: DemoClients = await setupClients(env);
  const { escrow, ownerWallet, makerWallet, ftso, provider } = clients;

  const minBlock: bigint = await escrow.MIN_BLOCK_FXRP();
  const bondBips: bigint = await escrow.BOND_BIPS();
  const bondAmount = (minBlock * bondBips) / BigInt(10000);

  // (a) ensure the desk maker's bond is funded for this block size.
  await fundMakerBond(clients, makerWallet, bondAmount);

  // Live FTSOv2 mid + the fee lock() will require.
  const { mid18, fee } = await readLiveFtsoMid(ftso);

  // Predicted destinationTag — see doc comment above for why this is safe under the shared run lock.
  const nextTagReader = new ethers.Contract(await escrow.getAddress(), NEXT_DEST_TAG_ABI, provider);
  const predictedTag: bigint = await nextTagReader.nextDestinationTag();

  const network = await provider.getNetwork();
  const escrowAddress = await escrow.getAddress();
  const fxrpAddress: string = await escrow.FXRP();

  const nowSec = Math.floor(Date.now() / 1000);
  const deadlineAt = nowSec + WALLET_MODE_DEADLINE_SECONDS;

  const matchId = ethers.hexlify(crypto.randomBytes(32));

  const mi: MatchInstruction = {
    matchId,
    escrow: escrowAddress,
    taker,
    maker: makerWallet.address,
    amountFxrp: minBlock,
    priceUsd18: mid18,
    takerXrplAddress,
    instructionExpiresAt: deadlineAt,
  };

  const { instructionData, signature } = signMatchInstruction(mi, network.chainId, ownerWallet);

  // xrpDrops estimate: priceUsd18 === mid18 (signed exactly at the live snapshot), so the
  // unbuffered estimate is exactly amountFxrp; add the drift-safety buffer documented above.
  const bufferedDrops = (minBlock * XRPL_PAY_BUFFER_NUM) / XRPL_PAY_BUFFER_DEN;

  putPrepareRecord(matchId, {
    destination: takerXrplAddress,
    xrpDrops: bufferedDrops.toString(),
    destinationTag: Number(predictedTag),
  });

  // paymentDeadline/refundAfter are ESTIMATES for display: the real values are stamped from
  // block.timestamp inside the judge's own future lock() call (which happens later than "now"
  // here), using the contract's immutable PAYMENT_WINDOW/SETTLEMENT_WINDOW. We estimate from "now"
  // as a conservative (slightly early) lower bound — informational only, /api/wallet/pay never
  // reads these.
  const paymentWindow: bigint = await escrow.PAYMENT_WINDOW();
  const settlementWindow: bigint = await escrow.SETTLEMENT_WINDOW();

  return {
    matchId,
    approve: { token: fxrpAddress, spender: escrowAddress, amount: minBlock.toString() },
    deposit: { amount: minBlock.toString(), armedUntil: String(deadlineAt) },
    lock: { to: escrowAddress, instructionData, teeSignature: signature, valueWei: fee.toString() },
    xrpDrops: bufferedDrops.toString(),
    destinationTag: String(predictedTag),
    paymentDeadline: String(nowSec + Number(paymentWindow)),
    refundAfter: String(nowSec + Number(settlementWindow)),
  };
}

// ---------------------------------------------------------------------------------------------
// /api/wallet/status — MockFXRP balanceOf + native C2FLR balance for the taker (judge) address.
// ---------------------------------------------------------------------------------------------

export interface WalletStatusResult {
  fxrp: string;
  c2flr: string;
}

export async function getWalletStatus(env: DemoEnv, taker: string): Promise<WalletStatusResult> {
  const provider = new ethers.JsonRpcProvider(env.coston2Rpc, COSTON2_CHAIN_ID);
  const escrow = new ethers.Contract(env.escrowAddress, DVP_ESCROW_ABI, provider);
  const fxrpAddress: string = await escrow.FXRP();
  const fxrp = new ethers.Contract(fxrpAddress, MOCK_FXRP_ABI, provider);

  const [fxrpBal, nativeBal] = await Promise.all([
    fxrp.balanceOf(taker) as Promise<bigint>,
    provider.getBalance(taker),
  ]);

  return {
    fxrp: ethers.formatUnits(fxrpBal, 6),
    c2flr: ethers.formatEther(nativeBal),
  };
}
