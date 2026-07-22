// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {IFtsoV2} from "../interfaces/IFtsoV2.sol";

/// @title MockFtsoV2
/// @notice Settable XRP/USD mid price (18-dec, wei-variant) + timestamp + fee, for DvPEscrow tests.
contract MockFtsoV2 is IFtsoV2 {
    uint256 public mid18;
    uint64 public ts;
    uint256 public fee;

    /// @notice Sets the feed value and timestamp returned by `getFeedByIdInWei`.
    function setFeed(uint256 _mid18, uint64 _ts) external {
        mid18 = _mid18;
        ts = _ts;
    }

    /// @notice Sets the fee returned by `calculateFeeById` and required as `msg.value`.
    function setFee(uint256 _fee) external {
        fee = _fee;
    }

    function calculateFeeById(bytes21) external view returns (uint256) {
        return fee;
    }

    function getFeedByIdInWei(bytes21) external payable returns (uint256, uint64) {
        return (mid18, ts);
    }
}
