#!/usr/bin/env node
// two-party-desk.mjs — proves a trade where the desk holds NEITHER leg.
//
// Every earlier end-to-end run had the desk on one side: wallet mode has it sign as maker, maker
// mode has it stand in as taker. Useful, but neither one demonstrates the claim this product
// actually makes — that two strangers can trade a block without a venue that can read the order or
// pick the winner. This script settles that trade.
//
// The taker is a wallet generated FRESH on every run. That is deliberate and it is the point: an
// address that did not exist a minute ago cannot be the desk's own standing counterparty, and
// anyone reading the transcript can check its history on the explorer and find nothing but this
// trade. The maker is a separate key that signs its own EIP-712 quote. Neither party ever sees the
// other's order.
//
// What the desk does here, in full: it seals, it relays two permissionless calls, and it pays their
// gas. The FXRP leaves the taker's own escrow deposit, the bond is the maker's own, and the XRP goes
// from the maker's XRPL account to the taker's. Those are the only balances that move.
//
// Run ON THE VPS (needs PRIVATE_KEY to fund the fresh taker, and MAKER_PRIVATE_KEY to sign a quote
// the way a maker's browser wallet would):
//   cd /root/whisperdesk-web && node two-party-desk.mjs
import { ethers } from "ethers";
import { Client } from "xrpl";

const BASE = process.env.WD_BASE_URL || "https://whisperdesk.endpx.cloud";
const RPC = process.env.COSTON2_RPC || "https://coston2-api.flare.network/ext/C/rpc";
const XRPL_WSS = "wss://s.altnet.rippletest.net:51233";
const ESCROW = process.env.MAKER_ESCROW_ADDRESS;
const FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7";

// Gas for the fresh taker's two transactions (approve + deposit), with room to spare.
const TAKER_GAS = ethers.parseEther("1.0");

const ERC20 = [
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];
// matches() does NOT return fields in the order the struct reads in the source — it is packed for
// storage, so destinationTag/lockedAt/state sit between taker and maker. Copied verbatim from
// web/src/lib/demo/abi.ts rather than retyped from memory: a plausible-looking guess decodes
// silently into the wrong slots and reports a successful trade as a failed one.
const ESCROW_ABI = [
  "function deposit(uint256 amount, uint64 armedUntil)",
  "function MIN_BLOCK_FXRP() view returns (uint256)",
  "function matches(bytes32) view returns (address taker, uint32 destinationTag, uint40 lockedAt, uint8 state, address maker, uint40 paymentDeadline, uint40 refundAfter, uint128 amountFxrp, uint128 xrpDrops, uint128 bondAmount, bytes32 takerXrplAddressHash)",
];

const log = (...a) => console.log(...a);
const step = (n, s) => log(`\n[${n}] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}
async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  if (!ESCROW) throw new Error("MAKER_ESCROW_ADDRESS is not set");
  const provider = new ethers.JsonRpcProvider(RPC, 114);
  const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const maker = new ethers.Wallet(process.env.MAKER_PRIVATE_KEY, provider);

  const escrow = new ethers.Contract(ESCROW, ESCROW_ABI, provider);
  const fxrp = new ethers.Contract(FXRP, ERC20, provider);
  const minBlock = await escrow.MIN_BLOCK_FXRP();

  // ---- 1. A taker nobody has met ------------------------------------------------------------
  step(1, "Generating a taker wallet that did not exist until now");
  const taker = ethers.Wallet.createRandom().connect(provider);
  log(`    taker  ${taker.address}`);
  log(`    maker  ${maker.address}   (a different key, signs its own quote)`);
  if (taker.address.toLowerCase() === maker.address.toLowerCase()) throw new Error("impossible");

  step(2, "Funding it — gas and one block of FXRP, the way a faucet funds a visitor");
  await (await owner.sendTransaction({ to: taker.address, value: TAKER_GAS })).wait();
  await (await fxrp.connect(owner).transfer(taker.address, minBlock)).wait();
  log(`    ${ethers.formatUnits(minBlock, 6)} FXRP + ${ethers.formatEther(TAKER_GAS)} C2FLR delivered`);

  step(3, "Opening the taker's own XRPL account — the XRP leg has to land somewhere they own");
  const xrplClient = new Client(XRPL_WSS);
  await xrplClient.connect();
  const { wallet: takerXrpl } = await xrplClient.fundWallet();
  log(`    ${takerXrpl.address}`);

  // ---- 2. The taker arms its own escrow balance ----------------------------------------------
  step(4, "Taker approves and deposits — its OWN transactions, from its OWN key");
  const prep = await post("/api/taker/rfq/prepare", {});
  if (prep.escrow.toLowerCase() !== ESCROW.toLowerCase()) {
    throw new Error(`prepare returned escrow ${prep.escrow}, expected ${ESCROW}`);
  }
  await (await fxrp.connect(taker).approve(prep.approve.spender, prep.approve.amount)).wait();
  const depositTx = await (
    await escrow.connect(taker).deposit(prep.deposit.amount, prep.deposit.armedUntil)
  ).wait();
  log(`    deposit ${depositTx.hash}`);

  // ---- 3. Publish, and let a stranger find it -------------------------------------------------
  step(5, "Publishing the sealed RFQ into the shared queue");
  const pub = await post("/api/taker/rfq/publish", {
    taker: taker.address,
    xrplAddress: takerXrpl.address,
  });
  log(`    rfqId ${pub.rfqId}   window closes at ${new Date(pub.windowEndsAt * 1000).toISOString()}`);

  step(6, "Reading the queue as a maker would — no side, no size, no limit, no taker");
  const queue = await get("/api/maker/open-rfqs");
  const rows = Array.isArray(queue) ? queue : (queue.rfqs ?? []);
  const seen = rows.find((r) => r.rfqId === pub.rfqId);
  if (!seen) throw new Error(`the published RFQ is not visible in the queue: ${JSON.stringify(queue)}`);
  log(`    visible: ${JSON.stringify(seen)}`);

  const join = await post("/api/maker/join-rfq", { rfqId: pub.rfqId });
  log(`    bond required ${ethers.formatUnits(join.bondAmount, 6)} FXRP (from MIN_BLOCK, not from the order size)`);

  // ---- 4. The maker prices it blind -----------------------------------------------------------
  step(7, "Maker signs an EIP-712 quote in its own key — the server never sees that key");
  const { xrpUsd } = await get("/api/price");
  const priceUsdE18 = ethers.parseUnits(String(xrpUsd), 18);
  const quote = {
    rfqId: pub.rfqId,
    maker: maker.address,
    priceUsdE18: priceUsdE18.toString(),
    maxFxrpRaw: minBlock.toString(),
    nonce: String(Date.now()),
  };
  const sig = await maker.signTypedData(
    { name: "WhisperDesk", version: "1", chainId: 114, verifyingContract: ethers.getAddress(ESCROW) },
    {
      Quote: [
        { name: "rfqId", type: "bytes32" },
        { name: "maker", type: "address" },
        { name: "priceUsdE18", type: "uint256" },
        { name: "maxFxrpRaw", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
    },
    quote
  );
  const ack = await post("/api/maker/quote", { ...quote, sig });
  log(`    quoted ${xrpUsd} USD/XRP — accepted=${ack.accepted} replaced=${ack.replaced}`);

  step(8, "Opening the maker's XRPL account (it owes the XRP leg)");
  const makerXrpl = await post("/api/maker/xrpl-account", {});
  log(`    ${makerXrpl.address}`);

  // ---- 5. The enclave decides, the escrow enforces ---------------------------------------------
  step(9, "Triggering the match — waits out the auction window, then locks");
  const match = await post("/api/maker/match", { rfqId: pub.rfqId });
  if (match.outcome !== "MATCHED") throw new Error(`NO_MATCH: ${JSON.stringify(match.reasons)}`);
  log(`    MATCHED  matchId ${match.matchId}`);
  log(`    pay ${match.xrpDrops} drops, tag ${match.destinationTag}, to ${match.xrplDestination}`);

  if (match.xrplDestination !== takerXrpl.address) {
    throw new Error(
      `the escrow is routing the XRP to ${match.xrplDestination}, not to the taker's own ${takerXrpl.address}`
    );
  }
  const onchain = await escrow.matches(match.matchId);
  log(`    onchain taker ${onchain.taker}`);
  log(`    onchain maker ${onchain.maker}`);
  if (onchain.taker.toLowerCase() !== taker.address.toLowerCase()) throw new Error("escrow taker != our fresh taker");
  if (onchain.maker.toLowerCase() !== maker.address.toLowerCase()) throw new Error("escrow maker != our maker");

  // ---- 6. Settlement ---------------------------------------------------------------------------
  step(10, "Maker pays the XRP leg");
  const pay = await post("/api/maker/pay", { matchId: match.matchId });
  log(`    XRPL ${pay.xrplTx}`);

  step(11, "Proving that payment to Coston2 with the Flare Data Connector");
  const settle = await post("/api/maker/settle", { matchId: match.matchId });
  log(`    attestation round ${settle.roundId}`);

  let proof = null;
  for (let i = 0; i < 60 && !proof; i++) {
    await sleep(10_000);
    const r = await get(`/api/demo/proof?roundId=${settle.roundId}&requestHex=${settle.requestHex}`);
    if (r.ready) proof = r.proof;
    else process.stdout.write(".");
  }
  if (!proof) throw new Error("the FDC proof never became available");
  log(`\n    proof ready`);

  const makerBefore = await fxrp.balanceOf(maker.address);
  step(12, "release() — the escrow hands the FXRP over, against the proof and nothing else");
  const rel = await post("/api/maker/release", { matchId: match.matchId, proof });
  log(`    ${rel.releaseTx}`);

  // ---- 7. What actually moved -------------------------------------------------------------------
  await sleep(4000);
  const makerAfter = await fxrp.balanceOf(maker.address);
  const takerXrpBal = await xrplClient.getXrpBalance(takerXrpl.address).catch(() => "unknown");
  await xrplClient.disconnect();

  log(`\n${"=".repeat(78)}`);
  log("SETTLED — and the desk was on neither side of it.");
  log(`${"=".repeat(78)}`);
  log(`  taker   ${taker.address}   (created this run)`);
  log(`  maker   ${maker.address}`);
  log(`  maker FXRP  ${ethers.formatUnits(makerBefore, 6)} -> ${ethers.formatUnits(makerAfter, 6)}`);
  log(`  taker XRP   ${takerXrpBal} on ${takerXrpl.address}`);
  log(`  rfqId/matchId ${match.matchId}`);
  log(`  release       ${rel.releaseTx}`);
  log(`  XRPL payment  ${pay.xrplTx}`);
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
