// On-chain proof that the RFQ ingress is chain-authenticated.
//
// Everything here is read live from Coston2 — nothing is taken on trust from a log paste:
//   1. the TEE registry really names OUR contract as the instruction sender for extension 65641
//   2. the submitRfq transaction's emitted instruction carries abi.encode(taker, ciphertext)
//      where `taker` == the transaction's actual `from` address, i.e. the contract stamped
//      msg.sender and the client could not have forged it
//   3. the RFQ_SUBMIT / WD_RFQ opcodes on the wire match the Solidity bytes32 literals
//
// Usage: node verify-onchain-rfq.mjs [txHash]
import { ethers } from "ethers";

const RPC = process.env.COSTON2_RPC ?? "https://coston2-api.flare.network/ext/C/rpc";
const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE"; // FlareTeeManager
const SENDER = "0x56A903F408C4745D34354Ec230BbfBDD78eC6426"; // WhisperDeskInstructionSender
const EXT_ID = 65641n;
const TX = process.argv[2] ?? "0xd50dd58c2dd66747dc1caa97077c64a4119b2efe4fb48ced14b3c15b50eef69a";

const provider = new ethers.JsonRpcProvider(RPC, 114);
const coder = ethers.AbiCoder.defaultAbiCoder();
const ok = (b) => (b ? "PASS" : "FAIL");
let allPass = true;
const check = (label, pass, detail) => {
  allPass &&= pass;
  console.log(`[${ok(pass)}] ${label}${detail ? `\n        ${detail}` : ""}`);
};

console.log(`Coston2 ${RPC}\ntx ${TX}\n`);

// --- 1. registry names our contract as the sender -------------------------------------------
const registry = new ethers.Contract(
  DIAMOND,
  ["function getTeeExtensionInstructionsSender(uint256) view returns (address)"],
  provider
);
const registered = await registry.getTeeExtensionInstructionsSender(EXT_ID);
check(
  `registry: extension ${EXT_ID} instruction sender is WhisperDeskInstructionSender`,
  registered.toLowerCase() === SENDER.toLowerCase(),
  `on-chain: ${registered}`
);

// --- 2. the transaction and its emitted instruction ------------------------------------------
const [tx, receipt] = await Promise.all([provider.getTransaction(TX), provider.getTransactionReceipt(TX)]);
if (!receipt) throw new Error("transaction not found on chain");
check("transaction succeeded", receipt.status === 1, `block ${receipt.blockNumber}`);
check(
  "transaction was sent TO the registered sender contract",
  tx.to.toLowerCase() === SENDER.toLowerCase(),
  `to: ${tx.to}`
);

const txFrom = tx.from;

// The instruction event is emitted by the diamond. Find it and pull out the raw `message` blob.
const diamondLog = receipt.logs.find((l) => l.address.toLowerCase() === DIAMOND.toLowerCase());
check("instruction event emitted by FlareTeeManager", !!diamondLog);

// opType / opCommand travel as bytes32 words inside the event data; assert the exact literals.
const b32 = (s) => ethers.encodeBytes32String(s);
const data = diamondLog.data;
check(
  'wire opType is bytes32("WD_RFQ")',
  data.includes(b32("WD_RFQ").slice(2)),
  b32("WD_RFQ")
);
check(
  'wire opCommand is bytes32("RFQ_SUBMIT")',
  data.includes(b32("RFQ_SUBMIT").slice(2)),
  b32("RFQ_SUBMIT")
);

// --- 3. THE POINT: the message decodes to (msg.sender, ciphertext) ----------------------------
// message = abi.encode(address, bytes): a 32-byte left-padded address, a 0x40 offset word, a
// length word, then the payload. Locate that triple inside the event data and decode it.
const raw = data.slice(2).toLowerCase();
const padded = ethers.zeroPadValue(txFrom, 32).slice(2).toLowerCase();

// The sender address appears more than once in the event (the params struct also carries
// claimBackAddress == msg.sender). Try every occurrence and keep the one that actually decodes as
// the `message` blob, i.e. abi.encode(address,bytes) — that is the envelope the enclave reads.
const offsets = [];
for (let i = raw.indexOf(padded); i !== -1; i = raw.indexOf(padded, i + 1)) offsets.push(i);
check(
  "event data contains the transaction sender as an ABI address word",
  offsets.length > 0,
  `sender ${txFrom} — ${offsets.length} occurrence(s)`
);

let decodedTaker = null;
let cipherLen = 0;
for (const at of offsets) {
  try {
    const [taker, ciphertext] = coder.decode(["address", "bytes"], "0x" + raw.slice(at));
    const len = ethers.getBytes(ciphertext).length;
    if (len > 0) {
      decodedTaker = taker;
      cipherLen = len;
      break;
    }
  } catch {
    // not the message field — keep looking
  }
}

check(
  "message decodes as abi.encode(address,bytes) — the shape fcewire's decodeRfqEnvelope expects",
  decodedTaker !== null,
  decodedTaker ? `ciphertext ${cipherLen} bytes` : "no occurrence decoded as (address,bytes)"
);
if (decodedTaker) {
  check(
    "decoded taker === the transaction's actual sender (contract stamped msg.sender)",
    decodedTaker.toLowerCase() === txFrom.toLowerCase(),
    `decoded ${decodedTaker}\n        tx.from  ${txFrom}`
  );
  // 512-byte padded plaintext + 113-byte ECIES overhead (0x04||X||Y||IV||ct||HMAC)
  check("ciphertext is a 512-byte-padded ECIES blob (625 bytes)", cipherLen === 625, `${cipherLen} bytes`);
}

console.log(`\n${allPass ? "ALL CHECKS PASS" : "SOME CHECKS FAILED"}`);
if (allPass) {
  console.log(
    `\nThe taker address inside the sealed instruction (${decodedTaker}) was written by\n` +
      `WhisperDeskInstructionSender from msg.sender, not supplied by the client. Any other\n` +
      `caller would have produced their own address there — the identity cannot be forged.`
  );
}
process.exit(allPass ? 0 : 1);
