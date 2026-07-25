// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;

// Minimal local interface for Flare's `TeeMachineRegistry` — copied verbatim from
// fce-extension-scaffold/contracts/interfaces/ITeeMachineRegistry.sol. TODO: replace with the
// published flare-smart-contracts-v2 import once available:
//   import { ITeeMachineRegistry } from "flare-smart-contracts-v2/contracts/userInterfaces/tee/ITeeMachineRegistry.sol";
interface ITeeMachineRegistry {
    function getRandomTeeIds(uint256 _extensionId, uint256 _count)
        external view returns (address[] memory);
}
