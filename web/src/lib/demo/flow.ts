// flow.ts — TS port of scripts/e2e/lib/flow.mjs: connect to the deployed DvPEscrow integration
// instance, fund the taker's FXRP deposit and the maker's bond, build + sign a MatchInstruction
// (matching lock()'s live FTSOv2 band), and call lock().
//
// DEVIATION FROM scripts/e2e/lib/flow.mjs (see this task's return notes): the e2e script submits
// the on-chain lock() transaction from the deployer/owner wallet
// (`escrow.connect(deployerWallet).lock(...)`). This demo console submits it from the TAKER wallet
// instead (`escrow.connect(takerWallet).lock(...)`), per the build task's explicit instruction
// ("signs the MatchInstruction, and sends lock() from the taker"). This is safe because
// DvPEscrow.lock() has no msg.sender restriction — only the teeSignature is checked — so any
// wallet may submit it; msg.sender just pays gas + the forwarded FTSOv2 fee and receives any
// msg.value surplus refund. The owner/teeSigner key still signs the MatchInstruction off-chain,
// unchanged from the e2e script.
import crypto from "node:crypto";
import { ethers } from "ethers";
import { BOND_LEDGER_ABI, DVP_ESCROW_ABI, FTSOV2_ABI, MOCK_FXRP_ABI, XRP_USD_FEED_ID } from "./abi";
import { type MatchInstruction, signMatchInstruction } from "./matchInstruction";
import { COSTON2_CHAIN_ID } from "./config";
import { createDemoWallet, type DemoEnv } from "./env";

export interface DemoClients {
  provider: ethers.JsonRpcProvider;
  escrow: ethers.Contract;
  fxrp: ethers.Contract;
  bondLedger: ethers.Contract;
  ftso: ethers.Contract;
  ownerWallet: ethers.Wallet;
  takerWallet: ethers.Wallet;
  makerWallet: ethers.Wallet;
}

/// Connects to the deployed escrow + its wired FXRP/BondLedger/FtsoV2, and to the three EVM
/// wallets this demo console controls end-to-end:
///   - ownerWallet: escrow owner AND teeSigner — signs MatchInstructions, pays the FTSOv2 fee (when
///     it later submits FDC/release/refund transactions).
///   - takerWallet: deposits FXRP, submits lock() (see the file-level deviation note above),
///     receives refund() principal + slashed bond on default.
///   - makerWallet: deposits the 1% bond, receives release() proceeds on the happy path.
export async function setupClients(env: DemoEnv): Promise<DemoClients> {
  const provider = new ethers.JsonRpcProvider(env.coston2Rpc, COSTON2_CHAIN_ID);

  const ownerWallet = createDemoWallet(env.ownerPrivateKey, provider, "owner/teeSigner");
  const takerWallet = createDemoWallet(env.takerPrivateKey, provider, "taker");
  const makerWallet = createDemoWallet(env.makerPrivateKey, provider, "maker");

  const escrow = new ethers.Contract(env.escrowAddress, DVP_ESCROW_ABI, provider);

  const teeSigner: string = await escrow.teeSigner();
  if (teeSigner.toLowerCase() !== ownerWallet.address.toLowerCase()) {
    throw new Error(
      `demo/flow.setupClients: escrow.teeSigner() (${teeSigner}) does not match the configured ` +
        `owner key's address (${ownerWallet.address}). The owner key must be the exact key the ` +
        `deployed DvPEscrow was configured with as teeSigner.`
    );
  }

  const fxrpAddress: string = await escrow.FXRP();
  const bondLedgerAddress: string = await escrow.BOND_LEDGER();
  const ftsoV2Address: string = await escrow.ftsoV2();

  const fxrp = new ethers.Contract(fxrpAddress, MOCK_FXRP_ABI, provider);
  const bondLedger = new ethers.Contract(bondLedgerAddress, BOND_LEDGER_ABI, provider);
  const ftso = new ethers.Contract(ftsoV2Address, FTSOV2_ABI, provider);

  return { provider, escrow, fxrp, bondLedger, ftso, ownerWallet, takerWallet, makerWallet };
}

/// Reads the live FTSOv2 XRP/USD mid (18-dec) + the fee lock() will require — via a static call,
/// so no transaction/fee is actually spent just to read the price.
export async function readLiveFtsoMid(ftso: ethers.Contract) {
  const fee: bigint = await ftso.calculateFeeById(XRP_USD_FEED_ID);
  const [mid18, ts]: [bigint, bigint] = await ftso.getFeedByIdInWei.staticCall(XRP_USD_FEED_ID, { value: fee });
  return { mid18, ts, fee };
}

/// Mints + approves + deposits `amount` FXRP for `wallet` into the escrow, arming it for
/// `armedForSeconds` past now.
export async function fundTakerDeposit(
  clients: DemoClients,
  wallet: ethers.Wallet,
  amount: bigint,
  armedForSeconds = 3600
) {
  const { fxrp, escrow } = clients;
  const fxrpAsWallet = fxrp.connect(wallet) as ethers.Contract;
  await (await fxrpAsWallet.mint(wallet.address, amount)).wait();
  await (await fxrpAsWallet.approve(await escrow.getAddress(), amount)).wait();
  const armedUntil = Math.floor(Date.now() / 1000) + armedForSeconds;
  const escrowAsWallet = escrow.connect(wallet) as ethers.Contract;
  await (await escrowAsWallet.deposit(amount, armedUntil)).wait();
}

/// Mints + approves + deposits `amount` FXRP bond for `wallet` into the BondLedger.
export async function fundMakerBond(clients: DemoClients, wallet: ethers.Wallet, amount: bigint) {
  const { fxrp, bondLedger } = clients;
  const fxrpAsWallet = fxrp.connect(wallet) as ethers.Contract;
  await (await fxrpAsWallet.mint(wallet.address, amount)).wait();
  await (await fxrpAsWallet.approve(await bondLedger.getAddress(), amount)).wait();
  const bondLedgerAsWallet = bondLedger.connect(wallet) as ethers.Contract;
  await (await bondLedgerAsWallet.depositBond(amount)).wait();
}

export interface LockResult {
  matchId: string;
  lockTx: string;
  destinationTag: number;
  xrpDrops: bigint;
  amountFxrp: bigint;
  paymentDeadline: number;
  refundAfter: number;
  bondAmount: bigint;
}

/// Full fund-and-lock flow: funds the taker's deposit + maker's bond for exactly MIN_BLOCK_FXRP,
/// builds + signs a MatchInstruction priced at the live FTSOv2 mid, calls lock(), and returns the
/// decoded MatchLocked event fields the caller needs next (destinationTag, xrpDrops, deadlines).
export async function fundAndLock(
  clients: DemoClients,
  env: DemoEnv,
  onProgress?: (msg: string) => void
): Promise<LockResult> {
  const log = onProgress || (() => {});
  const { escrow, ownerWallet, takerWallet, makerWallet, ftso } = clients;

  const minBlock: bigint = await escrow.MIN_BLOCK_FXRP();
  const bondBips: bigint = await escrow.BOND_BIPS();
  const bondAmount = (minBlock * bondBips) / BigInt(10000);

  log(`funding taker deposit: ${minBlock} FXRP (raw, 6-dec)`);
  await fundTakerDeposit(clients, takerWallet, minBlock);

  log(`funding maker bond: ${bondAmount} FXRP (raw, 6-dec)`);
  await fundMakerBond(clients, makerWallet, bondAmount);

  const { mid18, fee } = await readLiveFtsoMid(ftso);
  log(`live FTSOv2 XRP/USD mid18: ${mid18} (fee: ${fee} wei)`);

  const network = await clients.provider.getNetwork();
  const escrowAddress = await escrow.getAddress();
  const matchId = ethers.hexlify(crypto.randomBytes(32));
  const instructionExpiresAt = Math.floor(Date.now() / 1000) + 300;

  const mi: MatchInstruction = {
    matchId,
    escrow: escrowAddress,
    taker: takerWallet.address,
    maker: makerWallet.address,
    amountFxrp: minBlock,
    priceUsd18: mid18, // signed exactly at the live mid — always inside lock()'s +/-1% band
    takerXrplAddress: env.xrplTakerAddress,
    instructionExpiresAt,
  };

  // owner/teeSigner signs off-chain (unchanged from the e2e script).
  const { instructionData, signature } = signMatchInstruction(mi, network.chainId, ownerWallet);

  // Deviation from flow.mjs: submitted by the TAKER wallet, not the owner — see file-level note.
  log(`calling lock() (matchId=${matchId})...`);
  const escrowAsTaker = escrow.connect(takerWallet) as ethers.Contract;
  const tx = await escrowAsTaker.lock(instructionData, signature, { value: fee });
  const receipt = await tx.wait();
  log(`lock() confirmed: ${receipt.hash}`);

  const lockedEvent = receipt.logs
    .map((l: ethers.Log) => {
      try {
        return escrow.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e: ethers.LogDescription | null): e is ethers.LogDescription => e !== null && e.name === "MatchLocked");

  if (!lockedEvent) {
    throw new Error("demo/flow.fundAndLock: MatchLocked event not found in lock() receipt logs");
  }

  return {
    matchId,
    lockTx: receipt.hash,
    destinationTag: Number(lockedEvent.args.destinationTag),
    xrpDrops: lockedEvent.args.xrpDrops as bigint,
    amountFxrp: lockedEvent.args.amountFxrp as bigint,
    paymentDeadline: Number(lockedEvent.args.paymentDeadline),
    refundAfter: Number(lockedEvent.args.refundAfter),
    bondAmount,
  };
}
