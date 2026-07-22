// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {DvPEscrow} from "../../src/DvPEscrow.sol";
import {BondLedger} from "../../src/BondLedger.sol";
import {MockFXRP} from "../../src/mocks/MockFXRP.sol";
import {MockFtsoV2} from "../../src/mocks/MockFtsoV2.sol";
import {MockFdcVerification} from "../../src/mocks/MockFdcVerification.sol";
import {IXRPPayment} from "../../src/interfaces/IXRPPayment.sol";
import {MatchInstructionLib} from "../../src/libraries/MatchInstructionLib.sol";

/// @notice Shared fixture + helpers for DvPEscrow/BondLedger tests: deploys the full mock stack,
/// wires the TEE signer via a known private key (vm.sign), and provides builders for
/// MatchInstruction encoding/signing and FDC Proof construction (design.md §3.5/§3.7/§10).
abstract contract WhisperDeskTestBase is Test {
    // 6-decimal FXRP raw units
    uint256 internal constant ONE_FXRP = 1e6;
    uint256 internal constant MIN_BLOCK = 5_000e6;
    uint256 internal constant ONE_USD18 = 1e18;

    uint32 internal constant SETTLEMENT_WINDOW = 1800;
    uint32 internal constant ATTESTATION_BUDGET = 360;
    uint32 internal constant PAYMENT_WINDOW = SETTLEMENT_WINDOW - ATTESTATION_BUDGET;

    bytes32 internal constant SOURCE_ID = bytes32("testXRP");
    bytes32 internal constant ATTESTATION_TYPE = bytes32("XRPPayment");
    string internal constant TAKER_XRPL_ADDR = "rLLsk7Ac3eDPRRPFPeeC1nCPKMWnQ38rTL";

    // secp256k1 group order and its half — vm.sign does NOT guarantee a low-S canonical signature,
    // so _signMatch normalizes it here (mirrors the real TEE identity key / go-ethereum crypto.Sign
    // behavior, which always emits low-S per design.md §3.5/§5.1).
    uint256 internal constant SECP256K1N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant SECP256K1N_HALF = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    DvPEscrow internal escrow;
    BondLedger internal bondLedger;
    MockFXRP internal fxrp;
    MockFtsoV2 internal ftso;
    MockFdcVerification internal fdc;

    uint256 internal teeSignerPk = 0xA11CE5EED; // arbitrary nonzero private key
    address internal teeSigner;

    address internal owner = makeAddr("owner");
    address internal taker = makeAddr("taker");
    address internal maker = makeAddr("maker");
    address internal feeTreasury = makeAddr("feeTreasury");
    address internal relayer = makeAddr("relayer");

    function setUp() public virtual {
        teeSigner = vm.addr(teeSignerPk);

        vm.startPrank(owner);
        fxrp = new MockFXRP();
        bondLedger = new BondLedger(fxrp);
        ftso = new MockFtsoV2();
        fdc = new MockFdcVerification();

        escrow = new DvPEscrow(
            fxrp,
            bondLedger,
            teeSigner,
            ftso,
            fdc,
            SOURCE_ID,
            feeTreasury,
            SETTLEMENT_WINDOW,
            ATTESTATION_BUDGET
        );
        bondLedger.setEscrow(address(escrow));
        vm.stopPrank();

        // default oracle: 1 XRP == 1 USD, fresh
        ftso.setFeed(ONE_USD18, uint64(block.timestamp));
        ftso.setFee(0);
    }

    // ---------------------------------------------------------------------------------------
    // Funding helpers
    // ---------------------------------------------------------------------------------------

    function _fundTaker(address who, uint256 amount, uint64 armedUntil) internal {
        fxrp.mint(who, amount);
        vm.startPrank(who);
        fxrp.approve(address(escrow), amount);
        escrow.deposit(amount, armedUntil);
        vm.stopPrank();
    }

    function _fundMakerBond(address who, uint256 amount) internal {
        fxrp.mint(who, amount);
        vm.startPrank(who);
        fxrp.approve(address(bondLedger), amount);
        bondLedger.depositBond(amount);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------
    // MatchInstruction builders
    // ---------------------------------------------------------------------------------------

    function _defaultMatch(bytes32 matchId, address takerAddr, address makerAddr)
        internal
        view
        returns (MatchInstructionLib.MatchInstruction memory)
    {
        return MatchInstructionLib.MatchInstruction({
            matchId: matchId,
            escrow: address(escrow),
            taker: takerAddr,
            maker: makerAddr,
            amountFxrp: MIN_BLOCK,
            priceUsd18: ONE_USD18,
            takerXrplAddress: TAKER_XRPL_ADDR,
            instructionExpiresAt: uint64(block.timestamp + 300)
        });
    }

    /// @dev Signs `mi` with the fixture's TEE key, low-S canonical, V normalized to 27/28.
    function _signMatch(MatchInstructionLib.MatchInstruction memory mi)
        internal
        view
        returns (bytes memory instructionData, bytes memory sig)
    {
        instructionData = abi.encode(mi);
        bytes32 dataHash = keccak256(instructionData);
        bytes32 digest = MatchInstructionLib.ethSignedDigest(dataHash, block.chainid);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(teeSignerPk, digest);
        // vm.sign does not guarantee low-S; normalize to the canonical sibling signature so tests
        // exercise the real happy path (the escrow's low-S check rejects the high-S form).
        if (uint256(s) > SECP256K1N_HALF) {
            s = bytes32(SECP256K1N - uint256(s));
            v = v == 27 ? 28 : 27;
        }
        sig = abi.encodePacked(r, s, v);
    }

    /// @dev Full happy-path lock() call: funds taker+maker bond, builds+signs a MatchInstruction,
    /// and calls lock().
    function _lockDefaultMatch(bytes32 matchId) internal {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        _fundMakerBond(maker, MIN_BLOCK / 100 + 1);

        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(matchId, taker, maker);
        (bytes memory data, bytes memory sig) = _signMatch(mi);

        vm.prank(relayer);
        escrow.lock(data, sig);
    }

    function _readMatch(bytes32 matchId)
        internal
        view
        returns (
            address mTaker,
            uint32 destinationTag,
            uint40 lockedAt,
            DvPEscrow.MatchState state,
            address mMaker,
            uint40 paymentDeadline,
            uint40 refundAfter,
            uint128 amountFxrp,
            uint128 xrpDrops,
            uint128 bondAmount,
            bytes32 takerXrplAddressHash
        )
    {
        (
            mTaker,
            destinationTag,
            lockedAt,
            state,
            mMaker,
            paymentDeadline,
            refundAfter,
            amountFxrp,
            xrpDrops,
            bondAmount,
            takerXrplAddressHash
        ) = escrow.matches(matchId);
    }

    // ---------------------------------------------------------------------------------------
    // FDC proof builder
    // ---------------------------------------------------------------------------------------

    /// @dev Builds a valid IXRPPayment.Proof for `matchId`'s current onchain match state — the
    /// caller can then mutate individual fields to exercise each revert branch.
    function _validProof(bytes32 matchId, bytes32 txId) internal view returns (IXRPPayment.Proof memory proof) {
        (
            ,
            uint32 destinationTag,
            uint40 lockedAt,
            ,
            ,
            ,
            ,
            ,
            uint128 xrpDrops,
            ,
            bytes32 addrHash
        ) = _readMatch(matchId);

        proof.merkleProof = new bytes32[](0);
        proof.data.attestationType = ATTESTATION_TYPE;
        proof.data.sourceId = SOURCE_ID;
        proof.data.votingRound = 1;
        proof.data.lowestUsedTimestamp = lockedAt;
        proof.data.requestBody.transactionId = txId;
        proof.data.requestBody.proofOwner = address(escrow);
        proof.data.responseBody.blockNumber = 1;
        proof.data.responseBody.blockTimestamp = lockedAt + 60;
        proof.data.responseBody.sourceAddress = "rMakerXrplAddressXXXXXXXXXXXXXXXX";
        proof.data.responseBody.sourceAddressHash = keccak256(bytes(proof.data.responseBody.sourceAddress));
        proof.data.responseBody.receivingAddressHash = addrHash;
        proof.data.responseBody.intendedReceivingAddressHash = bytes32(0);
        proof.data.responseBody.spentAmount = int256(uint256(xrpDrops));
        proof.data.responseBody.intendedSpentAmount = int256(uint256(xrpDrops));
        proof.data.responseBody.receivedAmount = int256(uint256(xrpDrops));
        proof.data.responseBody.intendedReceivedAmount = int256(uint256(xrpDrops));
        proof.data.responseBody.hasMemoData = false;
        proof.data.responseBody.firstMemoData = "";
        proof.data.responseBody.hasDestinationTag = true;
        proof.data.responseBody.destinationTag = uint256(destinationTag);
        proof.data.responseBody.status = 0;
    }
}
