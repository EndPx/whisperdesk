// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;

// Minimal local interface for Flare's `TeeExtensionRegistry` diamond facet — copied verbatim from
// fce-extension-scaffold/contracts/interfaces/ITeeExtensionRegistry.sol (the scaffold's own
// HelloWorldInstructionSender depends on this exact shape). TODO: replace with the published
// flare-smart-contracts-v2 import once available:
//   import { ITeeExtensionRegistry } from "flare-smart-contracts-v2/contracts/userInterfaces/tee/ITeeExtensionRegistry.sol";
interface ITeeExtensionRegistry {
    struct TeeInstructionParams {
        bytes32 opType;
        bytes32 opCommand;
        bytes message;
        address[] cosigners;
        uint64 cosignersThreshold;
        address claimBackAddress;
    }

    function sendInstructions(
        address[] calldata _teeIds,
        TeeInstructionParams calldata _instructionParams
    ) external payable returns (bytes32 _instructionId);

    function nextPublicExtensionId() external view returns (uint256);

    function getTeeExtensionInstructionsSender(uint256 _extensionId)
        external view returns (address);
}
