// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {ITeeExtensionRegistry} from "./interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "./interfaces/ITeeMachineRegistry.sol";

/// @title WhisperDeskInstructionSender
/// @notice On-chain entry point that hands sealed RFQ ciphertext and permissionless match triggers
/// to the TEE, modeled 1:1 on fce-extension-scaffold's `HelloWorldInstructionSender`
/// (contracts/InstructionSender.sol, `sendSayHello`, ~lines 75-93): same two registries, same
/// `TeeInstructionParams` struct, same `msg.value` forwarding. See design.md §3.10.
///
/// Constructor + `setExtensionId()` + `_getExtensionId()` are copied verbatim from the scaffold
/// (per the Step 1 stub's own comment) — DO NOT MODIFY these three.
contract WhisperDeskInstructionSender {
    // Hashed with the same right-pad-ASCII-into-32-bytes scheme fcewire/handler.go's `opHash` and
    // tee-node's `teeutils.ToHash` use — byte-identical to a Solidity `bytes32("…")` literal, so no
    // conversion step is needed on either side of the wire (see extension/fcewire/PROTOCOL.md §1).
    bytes32 public constant OP_TYPE_WD_RFQ = bytes32("WD_RFQ"); // byte-identical in Go config
    bytes32 public constant OP_COMMAND_RFQ_SUBMIT = bytes32("RFQ_SUBMIT");
    bytes32 public constant OP_COMMAND_RFQ_MATCH = bytes32("RFQ_MATCH");
    // OP_COMMAND_QUOTE_SUBMIT = bytes32("QUOTE_SUBMIT") exists in Go only — /direct ingress, never
    // sent through this contract.

    /// @notice Reference to the TEE extension registry contract (copied from the scaffold).
    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    /// @notice Reference to the TEE machine registry contract (copied from the scaffold).
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    /// @notice First public extension ID. The registry reserves IDs below this
    /// for system/reserved extensions; public extensions are assigned from here up.
    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000; // 65536

    uint256 private _extensionId;

    event SealedRfqSubmitted(bytes32 indexed instructionId, address indexed taker);
    event MatchTriggered(bytes32 indexed instructionId, bytes32 indexed rfqId, address indexed caller);

    error NotImplemented();

    /// @notice Initializes the contract with registry addresses. Copied verbatim from
    /// HelloWorldInstructionSender's constructor — DO NOT MODIFY.
    constructor(ITeeExtensionRegistry _teeExtensionRegistry, ITeeMachineRegistry _teeMachineRegistry) {
        require(address(_teeExtensionRegistry) != address(0), "TeeExtensionRegistry cannot be zero address");
        require(address(_teeMachineRegistry) != address(0), "TeeMachineRegistry cannot be zero address");
        require(address(_teeExtensionRegistry).code.length > 0, "TeeExtensionRegistry has no code");
        require(address(_teeMachineRegistry).code.length > 0, "TeeMachineRegistry has no code");
        TEE_EXTENSION_REGISTRY = _teeExtensionRegistry;
        TEE_MACHINE_REGISTRY = _teeMachineRegistry;
    }

    /// @notice Finds and sets this contract's extension id. Can only be set once.
    /// DO NOT MODIFY this function (copied verbatim from HelloWorldInstructionSender).
    function setExtensionId() external {
        require(_extensionId == 0, "Extension ID already set.");

        uint256 c = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                return;
            }
        }
        revert("Extension ID not found.");
    }

    /// @notice Seals a taker's RFQ into the TEE. `message = abi.encode(msg.sender, ciphertext)` is
    /// load-bearing: binding the taker address to the on-chain transaction sender (rather than
    /// trusting a self-attested field inside the ciphertext) is what makes RFQ_SUBMIT
    /// chain-authenticated instead of spoofable — without it a forged RFQ could target another
    /// taker's armed deposit (design.md §3.10/§5.3, extension/fcewire/PROTOCOL.md §3.1).
    /// @param ciphertext ECIES-sealed `RfqPlaintext` (extension/fcewire/PROTOCOL.md §3.1).
    /// @return instructionId The onchain instruction id — this becomes the RFQ's `rfqId` for every
    /// downstream purpose (QUOTE_SUBMIT's `rfqId` field, RFQ_MATCH's target).
    function submitRfq(bytes calldata ciphertext) external payable returns (bytes32) {
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        address[] memory cosigners = new address[](0);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_WD_RFQ,
            opCommand: OP_COMMAND_RFQ_SUBMIT,
            message: abi.encode(msg.sender, ciphertext),
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        bytes32 instructionId = TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(teeIds, params);

        emit SealedRfqSubmitted(instructionId, msg.sender);
        return instructionId;
    }

    /// @notice Permissionlessly triggers matching for an already-submitted RFQ. Carries no secret
    /// data — `rfqId` is already public (emitted by `SealedRfqSubmitted` above) — so the payload is
    /// sent as a plain ABI value, never ECIES/JSON.
    ///
    /// Payload choice: `message = abi.encode(rfqId)`, NOT the bare 32 bytes, even though the two are
    /// byte-identical here. `rfqId` is a single static `bytes32` argument, and `abi.encode` of a lone
    /// static value has no length prefix or offset word — it IS the raw 32 bytes. That identity is
    /// exactly what extension/fcewire/handler.go's `decodeRfqID` relies on: it first tries
    /// `len(data) == 32` (the fast path both this instruction and the `/direct` fallback hit) and
    /// only falls back to ABI-unpacking for other payload shapes (see PROTOCOL.md §3.3). Using
    /// `abi.encode(rfqId)` here (rather than hand-rolling `bytes.concat(rfqId)`) keeps the call site
    /// idiomatic Solidity while producing byte-identical calldata.
    /// @param rfqId The RFQ's onchain instruction id, as emitted by `submitRfq`.
    /// @return instructionId The onchain instruction id for this RFQ_MATCH trigger.
    function triggerMatch(bytes32 rfqId) external payable returns (bytes32) {
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        address[] memory cosigners = new address[](0);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_WD_RFQ,
            opCommand: OP_COMMAND_RFQ_MATCH,
            message: abi.encode(rfqId),
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        bytes32 instructionId = TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(teeIds, params);

        emit MatchTriggered(instructionId, rfqId, msg.sender);
        return instructionId;
    }

    /// @notice Returns the cached extension ID, reverting if not yet set.
    /// DO NOT MODIFY this function (copied verbatim from HelloWorldInstructionSender).
    function _getExtensionId() internal view returns (uint256) {
        require(_extensionId != 0, "Extension ID is not set.");
        return _extensionId;
    }
}
