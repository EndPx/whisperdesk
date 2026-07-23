// flow.mjs — shared setup + lock() flow for both E2E runners (happy-path.mjs, default-path.mjs):
// connect to the deployed DvPEscrow integration instance, fund the taker's FXRP deposit and the
// maker's bond, build + sign a MatchInstruction (matching lock()'s live FTSOv2 band), and call
// lock(). Kept in one place so the two runners cannot silently drift on how a match gets opened.
import crypto from "node:crypto";
import { ethers } from "ethers";
import { BOND_LEDGER_ABI, DVP_ESCROW_ABI, FTSOV2_ABI, MOCK_FXRP_ABI, XRP_USD_FEED_ID } from "./abi.mjs";
import { signMatchInstruction } from "./matchInstruction.mjs";
import { COSTON2_CHAIN_ID, COSTON2_RPC, requireEnv } from "../config.mjs";

/// Connects to the deployed escrow + its wired FXRP/BondLedger/FtsoV2, and to the three EVM
/// wallets this E2E controls end-to-end:
///   - deployerWallet: escrow owner AND teeSigner (PRIVATE_KEY) — signs MatchInstructions, pays
///     the FTSOv2 fee, submits lock()/release()/refund() as the relayer, pays FDC request fees.
///   - takerWallet:    deposits FXRP, receives refund() principal + slashed bond on default.
///   - makerWallet:    deposits the 1% bond, receives release() proceeds on the happy path.
export async function setupClients(escrowAddress) {
  const provider = new ethers.JsonRpcProvider(COSTON2_RPC, COSTON2_CHAIN_ID);

  const deployerWallet = new ethers.Wallet(requireEnv("PRIVATE_KEY"), provider);
  const takerWallet = new ethers.Wallet(requireEnv("TAKER_PRIVATE_KEY"), provider);
  const makerWallet = new ethers.Wallet(requireEnv("MAKER_PRIVATE_KEY"), provider);

  const escrow = new ethers.Contract(escrowAddress, DVP_ESCROW_ABI, provider);

  const teeSigner = await escrow.teeSigner();
  if (teeSigner.toLowerCase() !== deployerWallet.address.toLowerCase()) {
    throw new Error(
      `flow.setupClients: escrow.teeSigner() (${teeSigner}) != PRIVATE_KEY's address ` +
        `(${deployerWallet.address}). This E2E signs MatchInstructions locally with PRIVATE_KEY — ` +
        `it must be the exact key script/DeployIntegration.s.sol set as teeSigner.`
    );
  }

  const fxrpAddress = await escrow.FXRP();
  const bondLedgerAddress = await escrow.BOND_LEDGER();
  const ftsoV2Address = await escrow.ftsoV2();

  const fxrp = new ethers.Contract(fxrpAddress, MOCK_FXRP_ABI, provider);
  const bondLedger = new ethers.Contract(bondLedgerAddress, BOND_LEDGER_ABI, provider);
  const ftso = new ethers.Contract(ftsoV2Address, FTSOV2_ABI, provider);

  return { provider, escrow, fxrp, bondLedger, ftso, deployerWallet, takerWallet, makerWallet };
}

/// Reads the live FTSOv2 XRP/USD mid (18-dec) + the fee lock() will require — via a static call,
/// so no transaction/fee is actually spent just to read the price.
export async function readLiveFtsoMid(ftso) {
  const fee = await ftso.calculateFeeById(XRP_USD_FEED_ID);
  const [mid18, ts] = await ftso.getFeedByIdInWei.staticCall(XRP_USD_FEED_ID, { value: fee });
  return { mid18, ts, fee };
}

/// Mints + approves + deposits `amount` FXRP for `wallet` into the escrow, arming it for
/// `armedForSeconds` past now.
export async function fundTakerDeposit(clients, wallet, amount, armedForSeconds = 3600) {
  const { fxrp, escrow } = clients;
  await (await fxrp.connect(wallet).mint(wallet.address, amount)).wait();
  await (await fxrp.connect(wallet).approve(await escrow.getAddress(), amount)).wait();
  const armedUntil = Math.floor(Date.now() / 1000) + armedForSeconds;
  await (await escrow.connect(wallet).deposit(amount, armedUntil)).wait();
}

/// Mints + approves + deposits `amount` FXRP bond for `wallet` into the BondLedger.
export async function fundMakerBond(clients, wallet, amount) {
  const { fxrp, bondLedger } = clients;
  await (await fxrp.connect(wallet).mint(wallet.address, amount)).wait();
  await (await fxrp.connect(wallet).approve(await bondLedger.getAddress(), amount)).wait();
  await (await bondLedger.connect(wallet).depositBond(amount)).wait();
}

/// Full fund-and-lock flow: funds the taker's deposit + maker's bond for exactly MIN_BLOCK_FXRP,
/// builds + signs a MatchInstruction priced at the live FTSOv2 mid, calls lock(), and returns the
/// decoded MatchLocked event fields the caller needs next (destinationTag, xrpDrops, deadlines).
export async function fundAndLock(clients, { onProgress } = {}) {
  const log = onProgress || (() => {});
  const { escrow, deployerWallet, takerWallet, makerWallet, ftso } = clients;

  const minBlock = await escrow.MIN_BLOCK_FXRP();
  const bondBips = await escrow.BOND_BIPS();
  const bondAmount = (minBlock * bondBips) / 10000n;

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

  const mi = {
    matchId,
    escrow: escrowAddress,
    taker: takerWallet.address,
    maker: makerWallet.address,
    amountFxrp: minBlock,
    priceUsd18: mid18, // signed exactly at the live mid — always inside lock()'s +/-1% band
    takerXrplAddress: requireEnv("XRPL_TAKER_ADDRESS"),
    instructionExpiresAt,
  };

  const { instructionData, signature } = signMatchInstruction(mi, network.chainId, deployerWallet);

  log(`calling lock() (matchId=${matchId})...`);
  const tx = await escrow.connect(deployerWallet).lock(instructionData, signature, { value: fee });
  const receipt = await tx.wait();
  log(`lock() confirmed: ${receipt.hash}`);

  const lockedEvent = receipt.logs
    .map((l) => {
      try {
        return escrow.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "MatchLocked");
  if (!lockedEvent) {
    throw new Error("flow.fundAndLock: MatchLocked event not found in lock() receipt logs");
  }

  return {
    matchId,
    destinationTag: Number(lockedEvent.args.destinationTag),
    xrpDrops: lockedEvent.args.xrpDrops,
    amountFxrp: lockedEvent.args.amountFxrp,
    paymentDeadline: Number(lockedEvent.args.paymentDeadline),
    refundAfter: Number(lockedEvent.args.refundAfter),
    bondAmount,
  };
}
