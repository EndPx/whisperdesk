// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {IFdcVerification} from "../interfaces/IFdcVerification.sol";
import {IXRPPayment} from "../interfaces/IXRPPayment.sol";

/// @title MockFdcVerification
/// @notice Configurable verify result for DvPEscrow.release() tests. Defaults to `true` so tests
/// exercise the escrow's own field checks (proofOwner, status, destination, tag, amount, window)
/// rather than being gated by this mock.
contract MockFdcVerification is IFdcVerification {
    bool public result = true;

    function setResult(bool _result) external {
        result = _result;
    }

    function verifyXRPPayment(IXRPPayment.Proof calldata) external view returns (bool) {
        return result;
    }
}
