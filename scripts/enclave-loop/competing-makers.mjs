// Competing makers, live: two independent makers quote the SAME sealed RFQ, and the enclave picks
// the better price without either maker ever seeing the other's number.
//
// The matcher has always supported this — extension/matcher/match.go's matchCore takes []*Quote,
// filters each through six checks, and selects max price with a deterministic price-time
// tie-break (TestMatchCore_BestQuoteSelection, TestMatchCore_DeterministicTieBreak). What was
// missing was a LIVE demonstration: every run so far put exactly one maker on an RFQ, so the
// competition existed in the code and in unit tests but never in a receipt.
//
// What this proves that a single-maker run cannot:
//   1. Two distinct maker addresses can quote one RFQ.
//   2. The enclave awards the better price — chosen inside the TEE, not by us.
//   3. The losing quote never leaves the enclave: it appears in no ack, no event, no log. The
//      MatchInstruction names only the winner.
//
// Runs ON THE VPS beside the wd-client binary, for the same reason onchain-loop.mjs does: the
// auction window is short and sealing must go through the Go ECIES implementation (eciesjs is not
// wire-compatible with go-ethereum's ECIES_AES128_SHA256).
//
// Usage (on the VPS):  node competing-makers.mjs [wd-client dir]
//   MAKER2_PRIVATE_KEY  optional. Unset, a fresh maker is generated and funded from the deployer,
//                       which keeps the two makers independent of the taker AND of the relayer.
import { ethers } from "ethers";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: new URL("../../.env", import.meta.url) });

const RPC = process.env.COSTON2_RPC ?? "https://coston2-api.flare.network/ext/C/rpc";
const EXT_PROXY = process.env.EXT_PROXY_URL ?? "https://fce.endpx.cloud";
const SENDER = process.env.WD_SENDER ?? "0x56A903F408C4745D34354Ec230BbfBDD78eC6426";
const ESCROW = process.env.ESCROW_ADDRESS ?? "0x20A885cb6ed3F652C5Fcb6a683CE74436F6a7023";
const RELAY_FEE = 1_000_000n;
const XRP_USD_FEED_ID = "0x015852502f55534400000000000000000000000000";

// Absolute, because execFileSync runs with cwd=clientDir and would otherwise resolve a relative
// binary path against that new cwd rather than against where the script was invoked from. The
// .exe suffix is needed on Windows: a full path is not extension-resolved.
const clientDir = resolve(process.argv[2] ?? "/root/wd-client");
const WD = join(clientDir, `wd-client${process.platform === "win32" ? ".exe" : ""}`);

const provider = new ethers.JsonRpcProvider(RPC, 114);
const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const taker = new ethers.Wallet(process.env.TAKER_PRIVATE_KEY, provider);
const makerA = new ethers.Wallet(process.env.MAKER_PRIVATE_KEY, provider);

const log = (...a) => console.error("[competing]", ...a);
const wd = (args) => execFileSync(WD, args, { cwd: clientDir, encoding: "utf8" }).trim();

const sender = new ethers.Contract(
  SENDER,
  [
    // Signatures copied from contracts/src/WhisperDeskInstructionSender.sol, not inferred:
    // instructionId is bytes32 (not uint256) and MatchTriggered carries the caller as a third
    // topic. Guessing either one makes parseLog silently skip the event.
    "function submitRfq(bytes ciphertext) payable returns (bytes32)",
    "function triggerMatch(bytes32 rfqId) payable returns (bytes32)",
    "event SealedRfqSubmitted(bytes32 indexed instructionId, address indexed taker)",
    "event MatchTriggered(bytes32 indexed instructionId, bytes32 indexed rfqId, address indexed caller)",
  ],
  deployer
);

const escrow = new ethers.Contract(
  ESCROW,
  [
    "function FXRP() view returns (address)",
    "function BOND_LEDGER() view returns (address)",
    "function MIN_BLOCK_FXRP() view returns (uint256)",
    "function BOND_BIPS() view returns (uint16)",
  ],
  provider
);

// Polls the proxy over HTTP rather than through the binary — same implementation onchain-loop.mjs
// has been using in production. wd-client's `result` subcommand exists but takes the id
// positionally and cannot filter by submission tag, which the quote acks need.
const pollResultTagged = async (id, tag = null, { timeoutMs = 300_000, everyMs = 5_000 } = {}) => {
  const url = `${EXT_PROXY}/action/result/${id}` + (tag ? `?submissionTag=${tag}` : "");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        const body = await res.json();
        // The proxy returns a `result` envelope as soon as the action is known, before the enclave
        // has written a payload into it. Waiting only for `result` therefore races the enclave and
        // hands back an empty `data` — so require the payload itself.
        if (body?.result?.data && body.result.data !== "0x") return body.result;
      }
    } catch {
      // transient — keep polling
    }
    await new Promise((f) => setTimeout(f, everyMs));
  }
  throw new Error(`timed out waiting for result ${id}${tag ? ` (tag ${tag})` : ""}`);
};
const payload = (r) => JSON.parse(Buffer.from(r.data.slice(2), "hex").toString());

/// Ensures `wallet` holds at least `need` free bond. A maker with no bond is filtered out by the
/// matcher as INSUFFICIENT_BOND, which would silently turn this two-horse race into a one-horse
/// one — the exact failure that would make the proof meaningless while still "passing".
async function ensureBond(wallet, need, fxrpAddr, bondAddr) {
  const bond = new ethers.Contract(
    bondAddr,
    ["function depositBond(uint256)", "function freeBond(address) view returns (uint256)"],
    wallet
  );
  const free = await bond.freeBond(wallet.address);
  if (free >= need) {
    log(`  ${wallet.address} bond ok (${free})`);
    return;
  }
  const fxrp = new ethers.Contract(
    fxrpAddr,
    [
      "function mint(address,uint256)",
      "function approve(address,uint256) returns (bool)",
      "function balanceOf(address) view returns (uint256)",
    ],
    wallet
  );
  const topUp = need * 4n;
  log(`  ${wallet.address} funding bond (+${topUp})`);
  await (await fxrp.mint(wallet.address, topUp)).wait();
  await (await fxrp.approve(bondAddr, topUp)).wait();
  await (await bond.depositBond(topUp)).wait();
}

async function main() {
  const [fxrpAddr, bondAddr, minBlock, bondBips] = await Promise.all([
    escrow.FXRP(),
    escrow.BOND_LEDGER(),
    escrow.MIN_BLOCK_FXRP(),
    escrow.BOND_BIPS(),
  ]);
  const requiredBond = (minBlock * BigInt(bondBips)) / 10_000n;

  // --- maker B: independent of both the taker and the relayer ----------------------------------
  let makerB;
  if (process.env.MAKER2_PRIVATE_KEY) {
    makerB = new ethers.Wallet(process.env.MAKER2_PRIVATE_KEY, provider);
  } else {
    makerB = ethers.Wallet.createRandom().connect(provider);
    log(`generated maker B ${makerB.address}, funding gas from deployer`);
    await (await deployer.sendTransaction({ to: makerB.address, value: ethers.parseEther("2") })).wait();
  }

  log(`taker   ${taker.address}`);
  log(`maker A ${makerA.address}`);
  log(`maker B ${makerB.address}`);
  if (makerA.address === makerB.address) throw new Error("maker A and B must be different addresses");

  log("ensuring both makers hold free bond");
  await ensureBond(makerA, requiredBond, fxrpAddr, bondAddr);
  await ensureBond(makerB, requiredBond, fxrpAddr, bondAddr);

  // --- live price: both quotes must land inside the same +/-1% band ----------------------------
  const ftso = new ethers.Contract(
    process.env.FTSO_V2 ?? "0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d",
    [
      "function getFeedByIdInWei(bytes21) payable returns (uint256, uint64)",
      "function calculateFeeById(bytes21) view returns (uint256)",
    ],
    provider
  );
  const feedFee = await ftso.calculateFeeById(XRP_USD_FEED_ID);
  const [liveMid] = await ftso.getFeedByIdInWei.staticCall(XRP_USD_FEED_ID, { value: feedFee });
  log(`live FTSOv2 mid ${ethers.formatUnits(liveMid, 18)}`);

  // The taker sells FXRP, so a HIGHER price is better for them and the matcher takes the max.
  // A quotes at the mid; B quotes 0.2% above it — both inside the band, B strictly better.
  const priceA = liveMid;
  const priceB = (liveMid * 1002n) / 1000n;
  const takerLimit = (liveMid * 97n) / 100n;

  // --- 1. seal + submit the RFQ onchain ---------------------------------------------------------
  // Field names are the enclave's wire contract (extension/fcewire/wire.go), not a convention:
  // the taker's XRPL address is `xrplAddress`. An unknown key decodes to empty and the handler
  // rejects the RFQ without ever emitting an ack, which looks exactly like a routing failure.
  const rfq = {
    v: 1,
    taker: taker.address,
    side: "SELL_FXRP",
    fxrpAmountRaw: minBlock.toString(),
    limitPriceUsdE18: takerLimit.toString(),
    xrplAddress: process.env.XRPL_TAKER_ADDRESS,
  };
  if (!rfq.xrplAddress) throw new Error("set XRPL_TAKER_ADDRESS — the enclave requires it");
  writeFileSync(`${clientDir}/rfq-competing.json`, JSON.stringify(rfq, null, 2) + "\n");
  const ciphertext = wd(["encrypt", "@rfq-competing.json"]);
  // Submitted BY the taker, not the relayer. WhisperDeskInstructionSender stamps the taker from
  // msg.sender, and the enclave requires the payload's `taker` to equal that envelope sender —
  // submitting from any other wallet is rejected as WD_ERR_AUTH. That check is the whole point of
  // the onchain ingress: identity cannot be self-asserted.
  const rfqTx = await sender.connect(taker).submitRfq(ciphertext, { value: RELAY_FEE });
  const rfqRc = await rfqTx.wait();
  const ev = rfqRc.logs
    .map((l) => {
      try {
        return sender.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p) => p?.name === "SealedRfqSubmitted");
  if (!ev) throw new Error("SealedRfqSubmitted not emitted");
  const rfqId = ev.args.instructionId;
  if (ev.args.taker.toLowerCase() !== taker.address.toLowerCase()) {
    throw new Error(`taker stamped onchain (${ev.args.taker}) != our taker — sender binding broken`);
  }
  log(`RFQ ${rfqId} — tx ${rfqTx.hash} (taker bound onchain: ${ev.args.taker})`);
  const ack = payload(await pollResultTagged(rfqId));
  log(`  window ends ${ack.windowEndsAt}`);

  // --- 2. two competing quotes, each EIP-712 signed by its own maker ----------------------------
  const domain = { name: "WhisperDesk", version: "1", chainId: 114, verifyingContract: ethers.getAddress(ESCROW) };
  const types = {
    Quote: [
      { name: "rfqId", type: "bytes32" },
      { name: "maker", type: "address" },
      { name: "priceUsdE18", type: "uint256" },
      { name: "maxFxrpRaw", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };

  const submitQuote = async (wallet, price, tag) => {
    const value = {
      rfqId,
      maker: wallet.address,
      priceUsdE18: price.toString(),
      maxFxrpRaw: minBlock.toString(),
      nonce: "1",
    };
    const quote = { v: 1, ...value, sig: await wallet.signTypedData(domain, types, value) };
    const file = `${clientDir}/quote-${tag}.json`;
    writeFileSync(file, JSON.stringify(quote, null, 2) + "\n");
    const cipher = wd(["encrypt", `@quote-${tag}.json`]);
    const out = JSON.parse(wd(["submit", "-op-command", "QUOTE_SUBMIT", "-message", cipher]));
    const id = out?.data?.id ?? out?.id;
    if (!id) throw new Error(`no action id for ${tag}`);
    const qAck = payload(await pollResultTagged(id, "submit", { timeoutMs: 120_000 }));
    log(`  ${tag}: ${wallet.address} @ ${ethers.formatUnits(price, 18)} -> accepted=${qAck.accepted}`);
    if (!qAck.accepted) throw new Error(`${tag} rejected`);
    // The ack is the maker's ONLY feedback. If it ever carried a rival's price or even a count of
    // rival quotes, the blindness claim would be false — so assert the shape stays minimal.
    const leaked = Object.keys(qAck).filter((k) => !["accepted", "replaced", "rfqId", "v"].includes(k));
    if (leaked.length) log(`  ! QuoteAck carried unexpected fields: ${leaked.join(", ")}`);
    return qAck;
  };

  log("submitting two competing quotes");
  await submitQuote(makerA, priceA, "makerA");
  await submitQuote(makerB, priceB, "makerB");

  // --- 3. close the window, trigger the match ----------------------------------------------------
  const waitFor = Number(ack.windowEndsAt) * 1000 - Date.now() + 5_000;
  if (waitFor > 0) {
    log(`waiting ${Math.ceil(waitFor / 1000)}s for the auction window`);
    await new Promise((f) => setTimeout(f, waitFor));
  }
  const mTx = await sender.triggerMatch(rfqId, { value: RELAY_FEE });
  const mRc = await mTx.wait();
  const mEv = mRc.logs
    .map((l) => {
      try {
        return sender.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p) => p?.name === "MatchTriggered");
  log(`triggerMatch tx ${mTx.hash}`);
  const match = payload(await pollResultTagged(mEv.args.instructionId));

  if (match.outcome !== "MATCHED") {
    console.log(JSON.stringify(match, null, 2));
    throw new Error(`NO_MATCH: ${JSON.stringify(match.reasons ?? {})}`);
  }

  // --- 4. the assertions that make this a proof --------------------------------------------------
  const winner = ethers.getAddress(match.maker ?? match.Maker);
  const wonPrice = BigInt(match.priceUsd18 ?? match.PriceUsd18);
  const expected = ethers.getAddress(makerB.address);

  const better = winner === expected;
  const pricedRight = wonPrice === priceB;
  // The loser must be absent from everything the enclave emitted.
  const blob = JSON.stringify(match).toLowerCase();
  const loserHidden = !blob.includes(makerA.address.toLowerCase().slice(2)) && !blob.includes(priceA.toString());

  log(`winner  ${winner} @ ${ethers.formatUnits(wonPrice, 18)}`);
  log(`  better price won : ${better ? "YES" : "NO"}`);
  log(`  price is B's     : ${pricedRight ? "YES" : "NO"}`);
  log(`  loser not leaked : ${loserHidden ? "YES" : "NO"}`);

  console.log(
    JSON.stringify(
      {
        rfqId,
        rfqTx: rfqTx.hash,
        matchTx: mTx.hash,
        makerA: { address: makerA.address, price: priceA.toString() },
        makerB: { address: makerB.address, price: priceB.toString() },
        winner,
        winningPrice: wonPrice.toString(),
        betterPriceWon: better,
        loserNotLeaked: loserHidden,
      },
      null,
      2
    )
  );

  if (!better || !pricedRight || !loserHidden) {
    throw new Error("competing-maker assertions failed");
  }
  log("GO: two makers competed, the better price won, the loser never surfaced.");
}

main().catch((e) => {
  console.error(`\nNO-GO: ${e.message ?? e}`);
  process.exit(1);
});
