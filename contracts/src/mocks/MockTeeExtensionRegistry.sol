// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {ITeeExtensionRegistry} from "../interfaces/ITeeExtensionRegistry.sol";

/// @notice Minimal mock of Flare's `TeeExtensionRegistry` diamond facet — test-only. Records the
/// last `sendInstructions` call's params/teeIds/value so tests can assert on them, and supports the
/// `setExtensionId()` discovery flow (`nextPublicExtensionId` + `getTeeExtensionInstructionsSender`)
/// the scaffold's sender contracts depend on.
contract MockTeeExtensionRegistry is ITeeExtensionRegistry {
    uint256 public callCount;
    uint256 public lastValue;
    address[] internal _lastTeeIds;
    TeeInstructionParams internal _lastParams;

    uint256 public nextInstructionIdSeed;

    mapping(uint256 => address) internal _senderForId;
    uint256 internal _nextPublicExtensionId = 0x10001; // one public slot reserved by default

    /// @notice Registers `sender` as the instructions-sender for extension id `id`, and ensures
    /// `nextPublicExtensionId()` covers it — used by tests to drive `setExtensionId()`.
    function registerExtension(uint256 id, address sender) external {
        _senderForId[id] = sender;
        if (id >= _nextPublicExtensionId) {
            _nextPublicExtensionId = id + 1;
        }
    }

    function sendInstructions(address[] calldata _teeIds, TeeInstructionParams calldata _instructionParams)
        external
        payable
        override
        returns (bytes32 _instructionId)
    {
        callCount++;
        lastValue = msg.value;
        _lastTeeIds = _teeIds;
        _lastParams = _instructionParams;

        _instructionId = keccak256(abi.encode(address(this), nextInstructionIdSeed, _instructionParams.message));
        nextInstructionIdSeed++;
    }

    function nextPublicExtensionId() external view override returns (uint256) {
        return _nextPublicExtensionId;
    }

    function getTeeExtensionInstructionsSender(uint256 _extensionId) external view override returns (address) {
        return _senderForId[_extensionId];
    }

    function lastTeeIds() external view returns (address[] memory) {
        return _lastTeeIds;
    }

    function lastOpType() external view returns (bytes32) {
        return _lastParams.opType;
    }

    function lastOpCommand() external view returns (bytes32) {
        return _lastParams.opCommand;
    }

    function lastMessage() external view returns (bytes memory) {
        return _lastParams.message;
    }

    function lastCosigners() external view returns (address[] memory) {
        return _lastParams.cosigners;
    }

    function lastCosignersThreshold() external view returns (uint64) {
        return _lastParams.cosignersThreshold;
    }

    function lastClaimBackAddress() external view returns (address) {
        return _lastParams.claimBackAddress;
    }
}
