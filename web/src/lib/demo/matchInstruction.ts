// matchInstruction.ts — TS port of scripts/e2e/lib/matchInstruction.mjs, itself the JS mirror of
// contracts/src/libraries/MatchInstructionLib.sol / extension/matcher/instruction.go
// (docs/design.md §3.5). MUST stay byte-identical: same field order, same ABI tuple encoding, same
// WD_MATCH_V1 EIP-191 digest construction. Do not "clean up" the encoding shape below — it is
// deliberately exercised against a live DvPEscrow.lock() call and any drift breaks signature
// verification on-chain.
import { ethers } from "ethers";

// bytes32("WD_MATCH_V1") — ASCII left-padded into 32 bytes, identical to Solidity's
// `bytes32("WD_MATCH_V1")` / Go's WDMatchTag().
export const WD_MATCH_TAG = ethers.encodeBytes32String("WD_MATCH_V1");

const MATCH_INSTRUCTION_TUPLE =
  "tuple(bytes32 matchId,address escrow,address taker,address maker,uint256 amountFxrp,uint256 priceUsd18,string takerXrplAddress,uint64 instructionExpiresAt)";

export interface MatchInstruction {
  matchId: string;
  escrow: string;
  taker: string;
  maker: string;
  amountFxrp: bigint;
  priceUsd18: bigint;
  takerXrplAddress: string;
  instructionExpiresAt: number;
}

/// Reproduces Solidity's `abi.encode(mi)` for a single MatchInstruction struct argument
/// byte-for-byte — INCLUDING the leading 32-byte offset word Solidity emits for a lone dynamic
/// top-level argument. Encoding `mi` as a single "tuple"-typed argument (via ethers' tuple(...)
/// type string), not as 8 flat top-level arguments, is what reproduces this.
export function abiEncodeMatchInstruction(mi: MatchInstruction): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return coder.encode(
    [MATCH_INSTRUCTION_TUPLE],
    [
      {
        matchId: mi.matchId,
        escrow: mi.escrow,
        taker: mi.taker,
        maker: mi.maker,
        amountFxrp: mi.amountFxrp,
        priceUsd18: mi.priceUsd18,
        takerXrplAddress: mi.takerXrplAddress,
        instructionExpiresAt: mi.instructionExpiresAt,
      },
    ]
  );
}

/// Reproduces MatchInstructionLib.dataHash(instructionData) = keccak256(instructionData).
export function dataHash(instructionData: string): string {
  return ethers.keccak256(instructionData);
}

/// Reproduces MatchInstructionLib.ethSignedDigest(dataHash, chainId) exactly:
///   payloadHash = keccak256(abi.encode(WD_MATCH_TAG, chainId, dataHash))
///   digest      = keccak256("\x19Ethereum Signed Message:\n32" || payloadHash)
export function ethSignedDigest(dataHash_: string, chainId: bigint | number): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const payloadHash = ethers.keccak256(
    coder.encode(["bytes32", "uint256", "bytes32"], [WD_MATCH_TAG, chainId, dataHash_])
  );
  return ethers.keccak256(ethers.concat([ethers.toUtf8Bytes("\x19Ethereum Signed Message:\n32"), payloadHash]));
}

const SECP256K1N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const SECP256K1N_HALF = SECP256K1N / BigInt(2);

/// Signs `mi` with `wallet` (an ethers.Wallet whose address MUST equal the target escrow's
/// teeSigner) and returns everything DvPEscrow.lock(instructionData, signature) needs. Uses a RAW
/// digest sign (`wallet.signingKey.sign`), NOT `wallet.signMessage` — the latter re-applies its own
/// EIP-191 prefix + hash, which would double-hash and produce a signature over the wrong message.
export function signMatchInstruction(mi: MatchInstruction, chainId: bigint | number, wallet: ethers.Wallet) {
  const instructionData = abiEncodeMatchInstruction(mi);
  const dHash = dataHash(instructionData);
  const digest = ethSignedDigest(dHash, chainId);

  const sig = wallet.signingKey.sign(digest);

  // Defensive low-S re-check: ethers'/@noble/curves' ECDSA signing already always emits the
  // canonical low-S form, but DvPEscrow.lock() rejects high-S with MalleableSignature() — assert
  // the invariant explicitly rather than silently producing a signature lock() would reject.
  if (BigInt(sig.s) > SECP256K1N_HALF) {
    throw new Error("signMatchInstruction: unexpected high-S signature — signing library behavior changed");
  }

  // sig.serialized is the compact 65-byte [R(32) || S(32) || V(1, in {27,28})] wire format —
  // exactly what DvPEscrow.lock()'s `_splitSignature` expects.
  const signature = sig.serialized;

  return { instructionData, signature, dataHash: dHash, digest, matchId: mi.matchId };
}
