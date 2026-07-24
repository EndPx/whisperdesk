// Pre-match funding for the enclave loop.
//
// The enclave's matcher clamps a match to what the chain actually shows: the taker's armed FXRP
// deposit in the escrow and the maker's free bond in the BondLedger (extension/matcher's
// ChainSnapshot). So both must be funded BEFORE RFQ_MATCH runs, otherwise the match sizes to zero
// and the enclave correctly refuses to sign anything.
//
// This deliberately does not reuse scripts/e2e/lib/flow.mjs's setupClients(): that helper asserts
// escrow.teeSigner() == PRIVATE_KEY's address, which is exactly what the enclave loop does NOT want
// (here teeSigner is the live enclave, not our deployer key).
//
// Usage:  ESCROW_ADDRESS=0x... node fund.mjs
import { ethers } from "ethers";
import dotenv from "dotenv";

// secrets live in the repo-root .env (same convention as scripts/e2e/config.mjs)
dotenv.config({ path: new URL("../../.env", import.meta.url) });

const RPC = process.env.COSTON2_RPC ?? "https://coston2-api.flare.network/ext/C/rpc";
const ESCROW = process.env.ESCROW_ADDRESS ?? process.argv[2];
if (!ESCROW) throw new Error("set ESCROW_ADDRESS (or pass it as argv[1])");

const ESCROW_ABI = [
  "function FXRP() view returns (address)",
  "function BOND_LEDGER() view returns (address)",
  "function MIN_BLOCK_FXRP() view returns (uint256)",
  "function BOND_BIPS() view returns (uint16)",
  "function teeSigner() view returns (address)",
  "function deposit(uint256 amount, uint64 armedUntil)",
  "function balances(address) view returns (uint128 armed, uint128 committed, uint64 armedUntil)",
];
const FXRP_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];
const BOND_ABI = [
  "function depositBond(uint256 amount)",
  "function freeBond(address) view returns (uint256)",
];

const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const provider = new ethers.JsonRpcProvider(RPC, 114);
const taker = new ethers.Wallet(need("TAKER_PRIVATE_KEY"), provider);
const maker = new ethers.Wallet(need("MAKER_PRIVATE_KEY"), provider);

const escrow = new ethers.Contract(ESCROW, ESCROW_ABI, provider);
const fxrp = new ethers.Contract(await escrow.FXRP(), FXRP_ABI, provider);
const bondLedger = new ethers.Contract(await escrow.BOND_LEDGER(), BOND_ABI, provider);

const minBlock = await escrow.MIN_BLOCK_FXRP();
const bondBips = await escrow.BOND_BIPS();
const bondAmount = (minBlock * BigInt(bondBips)) / 10000n;

// 2x headroom so a second run (or a slightly larger match) doesn't need re-funding.
const takerAmount = minBlock * 2n;
const makerBond = bondAmount * 2n > 0n ? bondAmount * 2n : 1n;

console.log("escrow      ", ESCROW);
console.log("teeSigner   ", await escrow.teeSigner(), "(the live enclave)");
console.log("taker       ", taker.address);
console.log("maker       ", maker.address);
console.log("minBlock    ", minBlock.toString(), "bondBips", bondBips.toString(), "bond", bondAmount.toString());

// --- taker: mint -> approve -> deposit (armed 2h, comfortably past the whole loop) ---
await (await fxrp.connect(taker).mint(taker.address, takerAmount)).wait();
await (await fxrp.connect(taker).approve(ESCROW, takerAmount)).wait();
const armedUntil = Math.floor(Date.now() / 1000) + 7200;
await (await escrow.connect(taker).deposit(takerAmount, armedUntil)).wait();
const bal = await escrow.balances(taker.address);
console.log(`taker deposit: armed=${bal.armed} committed=${bal.committed} armedUntil=${bal.armedUntil}`);

// --- maker: mint -> approve -> depositBond ---
await (await fxrp.connect(maker).mint(maker.address, makerBond)).wait();
await (await fxrp.connect(maker).approve(await bondLedger.getAddress(), makerBond)).wait();
await (await bondLedger.connect(maker).depositBond(makerBond)).wait();
const free = await bondLedger.freeBond(maker.address);
console.log(`maker bond:    free=${free}`);

console.log("funded — the enclave snapshot will now size a match correctly");
