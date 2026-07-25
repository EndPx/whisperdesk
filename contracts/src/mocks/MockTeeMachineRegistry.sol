// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {ITeeMachineRegistry} from "../interfaces/ITeeMachineRegistry.sol";

/// @notice Minimal mock of Flare's `TeeMachineRegistry` — test-only. Returns a fixed, configurable
/// set of TEE machine addresses regardless of extension id (randomness is out of scope for unit
/// tests; the real registry's selection logic is Flare's to test, not WhisperDesk's).
contract MockTeeMachineRegistry is ITeeMachineRegistry {
    address[] internal _teeIds;

    constructor() {
        _teeIds.push(address(uint160(1)));
    }

    function setTeeIds(address[] calldata ids) external {
        delete _teeIds;
        for (uint256 i = 0; i < ids.length; i++) {
            _teeIds.push(ids[i]);
        }
    }

    function getRandomTeeIds(uint256, /* _extensionId */ uint256 _count) external view override returns (address[] memory) {
        address[] memory out = new address[](_count);
        for (uint256 i = 0; i < _count; i++) {
            out[i] = _teeIds[i % _teeIds.length];
        }
        return out;
    }
}
