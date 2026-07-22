// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

/// @title MatchInstructionLib
/// @notice THE cross-domain contract (design.md §3.5). `MatchInstruction` must stay byte-identical
/// in Solidity `abi.decode`, Go `abi.Arguments.Pack`, and TS `encodeAbiParameters` — any field-order
/// drift breaks `DvPEscrow.lock()`. Do not reorder, add, or remove fields without updating the Go
/// engine (Step 3/4) and the TS client in lockstep.
library MatchInstructionLib {
    /// @dev ABI tuple: (bytes32,address,address,address,uint256,uint256,string,uint64)
    struct MatchInstruction {
        bytes32 matchId; // == rfqId == instructionId of the RFQ_SUBMIT instruction
        address escrow; // target DvPEscrow (engine config) — cross-instance replay guard
        address taker; // == SealedEnvelope.sender of the RFQ (chain-authenticated)
        address maker; // EIP-712-verified, bonded quote signer
        uint256 amountFxrp; // raw 6-dec, >= MIN_BLOCK_FXRP
        uint256 priceUsd18; // matched USD per XRP (== per FXRP at par), 18-dec
        string takerXrplAddress; // plaintext r-address for the XRPL leg (public post-match by design)
        uint64 instructionExpiresAt; // enclave matchTime + 300 s; lock() reverts after this
    }

    /// @dev Domain tag distinguishing this application-level signature from the FCE node's
    /// automatic `TEE_ACTION_RESULT` result signature (design.md §3.5 rationale).
    bytes32 internal constant WD_MATCH_TAG = bytes32("WD_MATCH_V1");

    /// @notice keccak256 over the raw `abi.encode(MatchInstruction)` bytes.
    /// @dev `instructionData` is expected to be exactly `abi.encode(mi)` — callers decode it
    /// separately via {decode}. Hashing the raw bytes (rather than re-encoding) guarantees the
    /// signer and the verifier hash identical bytes even if this library's `decode`/re-encode path
    /// were ever to diverge.
    function dataHash(bytes memory instructionData) internal pure returns (bytes32) {
        return keccak256(instructionData);
    }

    /// @notice The WD_MATCH_V1 EIP-191 personal-sign digest, mirroring the TEE sign port's own
    /// `SignedPayload` construction with our own domain tag (design.md §3.5):
    ///   message     = abi.encode(bytes32("WD_MATCH_V1"), chainId, dataHash)   // 96 bytes
    ///   payloadHash = keccak256(message)
    ///   digest      = keccak256("\x19Ethereum Signed Message:\n32" || payloadHash)
    function ethSignedDigest(bytes32 dataHash_, uint256 chainId) internal pure returns (bytes32) {
        bytes32 payloadHash = keccak256(abi.encode(WD_MATCH_TAG, chainId, dataHash_));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payloadHash));
    }

    /// @notice Decodes `instructionData` (== `abi.encode(mi)`) back into a `MatchInstruction`.
    function decode(bytes memory instructionData) internal pure returns (MatchInstruction memory mi) {
        mi = abi.decode(instructionData, (MatchInstruction));
    }
}
