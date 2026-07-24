// Signs a maker Quote (EIP-712) for the enclave loop.
//
// The signature binds rfqId, and rfqId is keccak256(the RFQ ciphertext) — knowable only from the
// RfqAck the enclave returns. So the order is always: submit the RFQ first, then sign the quote
// against the rfqId that came back, then submit the quote.
//
// Runs locally so the maker key never leaves this machine: the enclave only ever sees the
// resulting 65-byte signature, and verifies it with fcewire.VerifyQuoteSignature.
//
// Usage:  node sign-quote.mjs <rfqId 0x…32B> [outFile]
//   env:  MAKER_PRIVATE_KEY, ESCROW_ADDRESS (EIP-712 verifyingContract), optional PRICE_USD_E18,
//         MAX_FXRP_RAW, QUOTE_NONCE
import { ethers } from "ethers";
import dotenv from "dotenv";
import { writeFileSync } from "node:fs";

dotenv.config({ path: new URL("../../.env", import.meta.url) });

const rfqId = process.argv[2];
const outFile = process.argv[3] ?? "quote-signed.json";
if (!rfqId || !/^0x[0-9a-fA-F]{64}$/.test(rfqId)) {
  throw new Error("usage: node sign-quote.mjs <rfqId 0x…64 hex> [outFile]");
}

const escrow = process.env.ESCROW_ADDRESS;
if (!escrow) throw new Error("set ESCROW_ADDRESS (the DvPEscrow — EIP-712 verifyingContract)");
const makerKey = process.env.MAKER_PRIVATE_KEY;
if (!makerKey) throw new Error("set MAKER_PRIVATE_KEY in the repo-root .env");

const priceUsdE18 = process.env.PRICE_USD_E18 ?? "1112265000000000000";
const maxFxrpRaw = process.env.MAX_FXRP_RAW ?? "1000000";
const nonce = process.env.QUOTE_NONCE ?? "1";

const wallet = new ethers.Wallet(makerKey);

// Mirrors extension/fcewire/quoteauth.go exactly (domain + Quote type).
const domain = {
  name: "WhisperDesk",
  version: "1",
  chainId: 114,
  verifyingContract: ethers.getAddress(escrow),
};
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
  maker: wallet.address,
  priceUsdE18,
  maxFxrpRaw,
  nonce,
};

const sig = await wallet.signTypedData(domain, types, value);

const quote = {
  v: 1,
  rfqId,
  maker: wallet.address,
  priceUsdE18,
  maxFxrpRaw,
  nonce,
  sig,
};
writeFileSync(outFile, JSON.stringify(quote, null, 2) + "\n");

console.log(`signed quote -> ${outFile}`);
console.log(`  maker             ${wallet.address}`);
console.log(`  rfqId             ${rfqId}`);
console.log(`  verifyingContract ${domain.verifyingContract}`);
console.log(`  priceUsdE18       ${priceUsdE18}`);
console.log(`  recovered check   ${ethers.verifyTypedData(domain, types, value, sig)}`);
