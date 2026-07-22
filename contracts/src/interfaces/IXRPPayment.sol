// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

/// @title IXRPPayment
/// @notice Local mirror of Flare's FDC `IXRPPayment` attestation type (@custom:id 0x08),
/// matching the shape documented in `.claude/context/flare-docs/fdc.md` §3 and design.md §5.4/§6.5.
/// This is NOT imported from `flare-periphery-contracts` — Step 1 intentionally stays dependency-free
/// (see design.md §12 Step 1 DoD: "flare-periphery-contracts installed & verified to export
/// IXRPPayment + verifyXRPPayment" is a Step-1 verification task, not yet wired here). Struct layout
/// must stay byte-identical to the real package so swapping the import in a later step is a no-op.
interface IXRPPayment {
    struct RequestBody {
        bytes32 transactionId; // hash of the XRPL Payment transaction
        address proofOwner; // lower-cased by the verifier; address(0) if unused
    }

    struct ResponseBody {
        uint64 blockNumber;
        uint64 blockTimestamp; // XRPL ledger close_time -> UNIX
        string sourceAddress;
        bytes32 sourceAddressHash;
        bytes32 receivingAddressHash; // zero bytes32 when status != 0
        bytes32 intendedReceivingAddressHash; // = hash(Destination) when the tx failed
        int256 spentAmount; // drops (Amount + Fee)
        int256 intendedSpentAmount;
        int256 receivedAmount; // drops
        int256 intendedReceivedAmount;
        bool hasMemoData;
        bytes firstMemoData; // first Memo only
        bool hasDestinationTag;
        uint256 destinationTag; // 0 when hasDestinationTag == false
        uint8 status; // 0 SUCCESS, 1 SENDER_FAILURE, 2 RECEIVER_FAILURE (incl. tecDST_TAG_NEEDED)
    }

    struct Response {
        bytes32 attestationType;
        bytes32 sourceId;
        uint64 votingRound;
        uint64 lowestUsedTimestamp;
        RequestBody requestBody;
        ResponseBody responseBody;
    }

    struct Proof {
        bytes32[] merkleProof;
        Response data;
    }
}
