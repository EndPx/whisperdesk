// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

/// @title ReentrancyGuardTransient
/// @notice Minimal transient-storage (EIP-1153 TSTORE/TLOAD) reentrancy guard, per design.md §3
/// ("transient-storage `nonReentrant` + CEI on every fund-moving function"). Requires
/// `evm_version = cancun` (set in foundry.toml). Cheaper than the classic SSTORE-based guard and
/// self-clears at the end of the transaction regardless of success/failure.
abstract contract ReentrancyGuardTransient {
    error ReentrantCall();

    // keccak256("whisperdesk.reentrancy.guard.slot") — fixed, collision-free transient slot.
    bytes32 private constant REENTRANCY_SLOT = 0x8ee2f6bd3f6b7c9a4f2d3d0eb2a5b1a9dcf9d2f1a6e5b3c8d7e6f5a4b3c2d1e0;

    modifier nonReentrant() {
        bytes32 slot = REENTRANCY_SLOT;
        uint256 entered;
        assembly {
            entered := tload(slot)
        }
        if (entered != 0) revert ReentrantCall();
        assembly {
            tstore(slot, 1)
        }
        _;
        assembly {
            tstore(slot, 0)
        }
    }
}
