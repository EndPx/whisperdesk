// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {IXRPPayment} from "./IXRPPayment.sol";

/// @title IFdcVerification
/// @notice Minimal local interface for Flare's `FdcVerification` contract — only the one function
/// WhisperDesk needs. `verifyXRPPayment`, NOT `verifyPayment` (different struct shape; see
/// .claude/context/flare-docs/fdc.md gotcha #1). Step 1: injected as a mock address via the
/// DvPEscrow constructor. TODO(Step 5): resolve the real address via
/// FlareContractRegistry.getFdcVerification() (0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019) — never
/// hardcode a FdcVerification address (flare-docs/fdc.md and flare-docs/fdc-request-fee.md disagree
/// on it; the registry is the only truth).
interface IFdcVerification {
    function verifyXRPPayment(IXRPPayment.Proof calldata _proof) external view returns (bool);
}
