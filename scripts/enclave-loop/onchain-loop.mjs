// The whole enclave loop driven through the ONCHAIN ingress, in one process.
//
//   submitRfq (onchain, binds msg.sender) -> RfqAck -> maker quote (EIP-712, sealed, /direct)
//   -> triggerMatch (onchain) -> enclave-signed MatchInstruction -> local ecrecover check
//
// Runs ON THE VPS, next to the wd-client binary: the RFQ auction window is short, and the quote
// binds an rfqId that only exists once the RFQ transaction has mined, so every step has to run back
// to back. Sealing needs go-ethereum's ECIES (eciesjs is not wire-compatible), which is why this
// shells out to wd-client rather than doing it in JS.
//
// Quotes deliberately stay on /direct — they are private maker data and never touch the chain. Only
// the RFQ and the match trigger go onchain, which is exactly where identity matters.
//
// Usage (on the VPS):  node onchain-loop.mjs <rfq.json> [wd-client dir]
//   env: TAKER_PRIVATE_KEY, MAKER_PRIVATE_KEY, DIRECT_API_KEY, ESCROW_ADDRESS, COSTON2_RPC
import { ethers } from "ethers";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const RPC = process.env.COSTON2_RPC ?? "https://coston2-api.flare.network/ext/C/rpc";
const EXT_PROXY = process.env.EXT_PROXY_URL ?? "https://fce.endpx.cloud";
const SENDER = process.env.WD_SENDER ?? "0x56A903F408C4745D34354Ec230BbfBDD78eC6426";
const ESCROW = process.env.ESCROW_ADDRESS ?? "0x20A885cb6ed3F652C5Fcb6a683CE74436F6a7023";
const RELAY_FEE = 1_000_000n; // wei — same value the scaffold's own sender uses

const rfqFile = process.argv[2] ?? "rfq.json";
const clientDir = process.argv[3] ?? "/root/wd-client";
const WD = `${clientDir}/wd-client`;

const provider = new ethers.JsonRpcProvider(RPC, 114);
const taker = new ethers.Wallet(process.env.TAKER_PRIVATE_KEY, provider);
const maker = new ethers.Wallet(process.env.MAKER_PRIVATE_KEY, provider);
const log = (...a) => console.error("[onchain-loop]", ...a);

const wd = (args) =>
  execFileSync(WD, args, {
    cwd: clientDir,
    encoding: "utf8",
    env: { ...process.env, EXT_PROXY_URL: EXT_PROXY },
  }).trim();

const sender = new ethers.Contract(
  SENDER,
  [
    "function submitRfq(bytes) payable returns (bytes32)",
    "function triggerMatch(bytes32) payable returns (bytes32)",
    "event SealedRfqSubmitted(bytes32 indexed instructionId, address indexed taker)",
    "event MatchTriggered(bytes32 indexed instructionId, bytes32 indexed rfqId, address indexed caller)",
  ],
  taker
);

// Onchain instruction results are polled with the default (threshold) tag; /direct results carry
// submissionTag=submit and a much shorter TTL.
const pollResultTagged = async (id, tag = null, { timeoutMs = 300_000, everyMs = 5_000 } = {}) => {
  const url = `${EXT_PROXY}/action/result/${id}` + (tag ? `?submissionTag=${tag}` : "");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        const body = await res.json();
        if (body?.result) return body.result;
      }
    } catch {
      // transient — keep polling
    }
    await new Promise((f) => setTimeout(f, everyMs));
  }
  throw new Error(`timed out waiting for result ${id}${tag ? ` (tag ${tag})` : ""}`);
};
const pollResult = (id, opts) => pollResultTagged(id, null, opts);
const payload = (r) => JSON.parse(Buffer.from(r.data.slice(2), "hex").toString());

// --- 0. live price first ------------------------------------------------------------------------
// Both the taker's limit and the maker's quote are derived from the live FTSOv2 mid. Hardcoding
// either one makes the run fail as soon as XRP moves: a stale quote trips OUT_OF_BAND (±1% band),
// a stale limit trips BELOW_LIMIT. The enclave checks against the same feed the escrow re-checks
// at lock() time.
const XRP_USD_FEED_ID = "0x015852502f55534400000000000000000000000000";
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
log(`live FTSOv2 XRP/USD mid: ${ethers.formatUnits(liveMid, 18)}`);

// Taker sells at 3% below mid — comfortably satisfied by a quote struck at mid.
const takerLimit = (liveMid * 97n) / 100n;
const rfq = JSON.parse(readFileSync(`${clientDir}/${rfqFile}`, "utf8"));
rfq.limitPriceUsdE18 = takerLimit.toString();
rfq.taker = taker.address;
writeFileSync(`${clientDir}/rfq-live.json`, JSON.stringify(rfq, null, 2) + "\n");
log(`taker limit set to ${ethers.formatUnits(takerLimit, 18)} (3% below mid)`);

// --- 1. RFQ, onchain (msg.sender is the taker) -------------------------------------------------
log("sealing RFQ (rfq-live.json)");
const ciphertext = wd(["encrypt", "@rfq-live.json"]);

log(`submitRfq onchain — taker ${taker.address}`);
const rfqTx = await sender.submitRfq(ciphertext, { value: RELAY_FEE });
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
  throw new Error("taker in event != tx sender — sender binding broken");
}
log(`  tx ${rfqTx.hash}`);
log(`  rfqId ${rfqId} (taker bound onchain: ${ev.args.taker})`);

const ack = payload(await pollResult(rfqId));
log(`  enclave RfqAck: windowEndsAt=${ack.windowEndsAt}`);

// --- 2. maker quote — EIP-712 signed, sealed, over /direct -------------------------------------
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
const value = {
  rfqId,
  maker: maker.address,
  priceUsdE18: process.env.PRICE_USD_E18 ?? liveMid.toString(),
  maxFxrpRaw: process.env.MAX_FXRP_RAW ?? "1000000",
  nonce: process.env.QUOTE_NONCE ?? "1",
};
const quote = { v: 1, ...value, sig: await maker.signTypedData(domain, types, value) };
writeFileSync(`${clientDir}/quote-onchain.json`, JSON.stringify(quote, null, 2) + "\n");
log(`quote signed by ${maker.address}, submitting over /direct`);

const quoteCipher = wd(["encrypt", "@quote-onchain.json"]);
const quoteOut = wd(["submit", "-op-command", "QUOTE_SUBMIT", "-message", quoteCipher]);
const quoteAction = JSON.parse(quoteOut);
const quoteActionId = quoteAction?.data?.id ?? quoteAction?.id;
if (!quoteActionId) throw new Error(`could not read action id from submit output: ${quoteOut.slice(0, 200)}`);
const quoteAck = payload(
  await pollResultTagged(quoteActionId, "submit", { timeoutMs: 120_000 })
);
log(`  QuoteAck accepted=${quoteAck.accepted} replaced=${quoteAck.replaced}`);
if (!quoteAck.accepted) throw new Error("quote rejected");

// --- 3. match trigger, onchain -----------------------------------------------------------------
const waitFor = Number(ack.windowEndsAt) * 1000 - Date.now() + 5_000;
if (waitFor > 0) {
  log(`waiting ${Math.ceil(waitFor / 1000)}s for the auction window to close`);
  await new Promise((f) => setTimeout(f, waitFor));
}

log("triggerMatch onchain");
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
log(`  tx ${mTx.hash}`);
const match = payload(await pollResult(mEv.args.instructionId));
log(`  outcome=${match.outcome}`);
if (match.outcome !== "MATCHED") {
  console.log(JSON.stringify(match, null, 2));
  throw new Error(`no match: ${JSON.stringify(match.reasons ?? {})}`);
}

// --- 4. verify the enclave's signature locally before trusting it ------------------------------
const infoOut = JSON.parse(wd(["info"]));
const TAG = ethers.encodeBytes32String("WD_MATCH_V1");
const dataHash = ethers.keccak256(match.abiEncoded);
const inner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256", "bytes32"], [TAG, 114, dataHash]));
const recovered = ethers.recoverAddress(ethers.hashMessage(ethers.getBytes(inner)), match.teeSignature);
const verified = recovered.toLowerCase() === infoOut.address.toLowerCase();
log(`  ecrecover ${recovered} vs enclave ${infoOut.address} -> ${verified ? "VERIFIED" : "MISMATCH"}`);
if (!verified) throw new Error("enclave signature did not verify");

console.log(
  JSON.stringify(
    {
      ...match.match,
      abiEncoded: match.abiEncoded,
      teeSignature: match.teeSignature,
      chainId: 114,
      enclaveAddress: infoOut.address,
      recoveredSigner: recovered,
      verified,
      rfqTx: rfqTx.hash,
      matchTx: mTx.hash,
      ingress: "onchain (submitRfq / triggerMatch)",
    },
    null,
    2
  )
);
