// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

/// @title WhisperDeskInstructionSender (Step 1 stub)
/// @notice Placeholder for the real scaffold-derived sender (design.md §3.10). The production
/// version is modeled 1:1 on the fce-extension-scaffold's `HelloWorldInstructionSender`
/// (constructor + `setExtensionId()` + `_getExtensionId()` copied verbatim, DO NOT MODIFY) and
/// wires `submitRfq`/`triggerMatch` through `getRandomTeeIds(_getExtensionId(), 1)` ->
/// `TeeInstructionParams` -> `sendInstructions{value: msg.value}` on the `FlareTeeManager` diamond.
///
/// TODO(Step 3): once `fce-extension-scaffold` is forked into `engine/` and `TeeExtensionRegistry`
/// is available to build/test against, replace this stub with the real implementation and finalize
/// `submitRfq`/`triggerMatch` per design.md §3.10 (sender-binding: `message =
/// abi.encode(msg.sender, ciphertext)` for `submitRfq` is load-bearing security — without it a
/// spoofed RFQ could drain a victim's armed deposit).
///
/// DvPEscrow + BondLedger are prioritized first for Step 1 per the task brief; this contract exists
/// only so the constants/events/signatures are locked in and referenceable by the rest of the
/// monorepo ahead of Step 3.
contract WhisperDeskInstructionSender {
    bytes32 public constant OP_TYPE_WD_RFQ = bytes32("WD_RFQ"); // byte-identical in Go config
    bytes32 public constant OP_COMMAND_RFQ_SUBMIT = bytes32("RFQ_SUBMIT");
    bytes32 public constant OP_COMMAND_RFQ_MATCH = bytes32("RFQ_MATCH");
    // OP_COMMAND_QUOTE_SUBMIT = bytes32("QUOTE_SUBMIT") exists in Go only — /direct ingress, never
    // sent through this contract.

    event SealedRfqSubmitted(bytes32 indexed instructionId, address indexed taker);
    event MatchTriggered(bytes32 indexed instructionId, bytes32 indexed rfqId, address indexed caller);

    error NotImplemented();

    /// @notice STUB — Step 3 wires this through TeeExtensionRegistry.sendInstructions.
    /// message = abi.encode(msg.sender, ciphertext) once implemented (design.md §3.10/§5.3).
    function submitRfq(bytes calldata /* ciphertext */ ) external payable returns (bytes32) {
        revert NotImplemented();
    }

    /// @notice STUB — Step 3 wires this through TeeExtensionRegistry.sendInstructions.
    /// message = abi.encode(rfqId) once implemented; permissionless, idempotent enclave-side.
    function triggerMatch(bytes32 /* rfqId */ ) external payable returns (bytes32) {
        revert NotImplemented();
    }
}
