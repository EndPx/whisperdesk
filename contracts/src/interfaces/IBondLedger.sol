// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

/// @title IBondLedger
/// @notice The subset of `BondLedger` that `DvPEscrow` calls (design.md §3.9). Deposit/withdraw are
/// maker-facing and not needed by the escrow.
interface IBondLedger {
    function lockBond(bytes32 matchId, address maker, uint256 amount) external;
    function releaseBond(bytes32 matchId) external;
    function slashBond(bytes32 matchId, address to) external;
}
