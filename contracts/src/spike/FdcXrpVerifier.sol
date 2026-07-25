// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {IFdcVerification} from "../interfaces/IFdcVerification.sol";
import {IXRPPayment} from "../interfaces/IXRPPayment.sol";

/// @title FdcXrpVerifier
/// @notice STEP 2 SPIKE ONLY — not production code, not imported by DvPEscrow. Exists to prove
/// end-to-end that a real XRPL testnet payment can be turned into an FDC `XRPPayment` attestation
/// whose Merkle proof verifies onchain on Coston2 via `IFdcVerification.verifyXRPPayment`, mirroring
/// the exact checks `DvPEscrow.release()` will perform (docs/design.md §3.7). The real
/// `FdcVerification` address is resolved once at construction and held immutable, exactly like the
/// shipped `DvPEscrow`: `script/DeployIntegration.s.sol` resolves both `FtsoV2` and `FdcVerification`
/// live from `FlareContractRegistry` once, before the escrow is deployed, and neither address is ever
/// re-resolved afterward. Never hardcode this address outside that one registry lookup — the docs
/// note it can change across network releases.
contract FdcXrpVerifier {
    IFdcVerification public immutable fdcVerification;

    error ProofInvalid();
    error PaymentFailedStatus(uint8 status);

    constructor(address _fdcVerification) {
        fdcVerification = IFdcVerification(_fdcVerification);
    }

    /// @notice Raw pass-through check — does NOT assert status==0, just Merkle-proof validity.
    /// Returns the decoded fields the spike harness (verify.mjs) compares against the payment made.
    function verify(IXRPPayment.Proof calldata _proof)
        external
        view
        returns (
            bool ok,
            string memory sourceAddress,
            bytes32 receivingAddressHash,
            int256 receivedAmount,
            bool hasDestinationTag,
            uint256 destinationTag,
            uint8 status,
            uint64 blockTimestamp
        )
    {
        ok = fdcVerification.verifyXRPPayment(_proof);
        IXRPPayment.ResponseBody calldata r = _proof.data.responseBody;
        sourceAddress = r.sourceAddress;
        receivingAddressHash = r.receivingAddressHash;
        receivedAmount = r.receivedAmount;
        hasDestinationTag = r.hasDestinationTag;
        destinationTag = r.destinationTag;
        status = r.status;
        blockTimestamp = r.blockTimestamp;
    }

    /// @notice Mirrors the `release()` guard order from docs/design.md §3.7: Merkle proof valid
    /// first, then `status == 0` (receivingAddressHash is zeroed when status != 0, so status MUST
    /// be checked before trusting the destination fields).
    function verifyStrict(IXRPPayment.Proof calldata _proof)
        external
        view
        returns (
            bytes32 receivingAddressHash,
            int256 receivedAmount,
            bool hasDestinationTag,
            uint256 destinationTag,
            uint64 blockTimestamp
        )
    {
        if (!fdcVerification.verifyXRPPayment(_proof)) revert ProofInvalid();
        IXRPPayment.ResponseBody calldata r = _proof.data.responseBody;
        if (r.status != 0) revert PaymentFailedStatus(r.status);
        return (r.receivingAddressHash, r.receivedAmount, r.hasDestinationTag, r.destinationTag, r.blockTimestamp);
    }
}
