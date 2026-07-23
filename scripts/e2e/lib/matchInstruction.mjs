// matchInstruction.mjs — JS mirror of contracts/src/libraries/MatchInstructionLib.sol /
// extension/matcher/instruction.go (design.md §3.5). MUST stay byte-identical: same field order,
// same ABI tuple encoding, same WD_MATCH_V1 EIP-191 digest construction. This is the third leg of
// the cross-language parity already proven Solidity<->Go in Step 4 (GoldenVectors.t.sol,
// MatcherToLock.t.sol) — here it is exercised for real (not vector-replayed) against a live
// DvPEscrow.lock() call.
import { ethers } from "ethers";

// bytes32("WD_MATCH_V1") — ASCII left-padded into 32 bytes, identical to Solidity's
// `bytes32("WD_MATCH_V1")` / Go's WDMatchTag().
export const WD_MATCH_TAG = ethers.encodeBytes32String("WD_MATCH_V1");

const MATCH_INSTRUCTION_TUPLE =
  "tuple(bytes32 matchId,address escrow,address taker,address maker,uint256 amountFxrp,uint256 priceUsd18,string takerXrplAddress,uint64 instructionExpiresAt)";

/// Reproduces Solidity's `abi.encode(mi)` for a single MatchInstruction struct argument
/// byte-for-byte — INCLUDING the leading 32-byte offset word Solidity emits for a lone dynamic
/// top-level argument (see extension/matcher/instruction.go's init() comment for the full
/// rationale; proven against real solc via contracts/test/GoldenVectors.t.sol). Encoding `mi` as a
/// single "tuple"-typed argument (via ethers' tuple(...) type string), not as 8 flat top-level
/// arguments, is what reproduces this.
export function abiEncodeMatchInstruction(mi) {
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
export function dataHash(instructionData) {
  return ethers.keccak256(instructionData);
}

/// Reproduces MatchInstructionLib.ethSignedDigest(dataHash, chainId) exactly:
///   payloadHash = keccak256(abi.encode(WD_MATCH_TAG, chainId, dataHash))
///   digest      = keccak256("\x19Ethereum Signed Message:\n32" || payloadHash)
export function ethSignedDigest(dataHash_, chainId) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const payloadHash = ethers.keccak256(
    coder.encode(["bytes32", "uint256", "bytes32"], [WD_MATCH_TAG, chainId, dataHash_])
  );
  return ethers.keccak256(
    ethers.concat([ethers.toUtf8Bytes("\x19Ethereum Signed Message:\n32"), payloadHash])
  );
}

const SECP256K1N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1N_HALF = SECP256K1N / 2n;

/// Signs `mi` with `wallet` (an ethers.Wallet whose address MUST equal the target escrow's
/// teeSigner) and returns everything DvPEscrow.lock(instructionData, signature) needs, ready to
/// call. Uses a RAW digest sign (`wallet.signingKey.sign`), NOT `wallet.signMessage` — the latter
/// re-applies its own EIP-191 prefix + hash, which would double-hash and produce a signature over
/// the wrong message. This mirrors go-ethereum's `crypto.Sign(digest, privKey)` path that
/// extension/matcher.Sign uses (see that file's doc comment).
export function signMatchInstruction(mi, chainId, wallet) {
  const instructionData = abiEncodeMatchInstruction(mi);
  const dHash = dataHash(instructionData);
  const digest = ethSignedDigest(dHash, chainId);

  const sig = wallet.signingKey.sign(digest);

  // Defensive low-S re-check: ethers'/@noble/curves' ECDSA signing already always emits the
  // canonical low-S form (same convention as go-ethereum's crypto.Sign), but DvPEscrow.lock()
  // rejects high-S with MalleableSignature() — assert the invariant explicitly rather than
  // silently producing a signature lock() would reject.
  if (BigInt(sig.s) > SECP256K1N_HALF) {
    throw new Error("signMatchInstruction: unexpected high-S signature — signing library behavior changed");
  }

  // sig.serialized is the compact 65-byte [R(32) || S(32) || V(1, in {27,28})] wire format —
  // exactly what DvPEscrow.lock()'s `_splitSignature` expects.
  const signature = sig.serialized;

  return { instructionData, signature, dataHash: dHash, digest, matchId: mi.matchId };
}
