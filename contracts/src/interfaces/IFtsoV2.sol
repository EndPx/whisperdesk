// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

/// @title IFtsoV2
/// @notice Minimal local interface mirroring Flare's `FtsoV2Interface` block-latency feed reads
/// (.claude/context/flare-docs/ftsov2.md §4). Only the wei-variant + fee are exposed — decimals are
/// never hand-parsed (ftsov2.md §5: "Do not hardcode the number of decimals for a feed"). Step 1:
/// injected as a mock address via the DvPEscrow constructor. TODO(Step 5): resolve the real
/// `FtsoV2` address via FlareContractRegistry.getFtsoV2() instead of constructor injection.
interface IFtsoV2 {
    /// @notice Returns the feed value already normalized to 18 decimals, and its timestamp.
    function getFeedByIdInWei(bytes21 _feedId) external payable returns (uint256 _value, uint64 _timestamp);

    /// @notice Fee (in wei) required to call `getFeedByIdInWei` for this feed. Currently 0 on all
    /// networks but must always be queried and forwarded — the payable pattern survives fee
    /// activation (ftsov2.md §6).
    function calculateFeeById(bytes21 _feedId) external view returns (uint256 _fee);
}
