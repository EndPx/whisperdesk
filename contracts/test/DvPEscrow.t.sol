// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {WhisperDeskTestBase} from "./helpers/WhisperDeskTestBase.sol";
import {DvPEscrow} from "../src/DvPEscrow.sol";
import {BondLedger} from "../src/BondLedger.sol";
import {MockFXRP} from "../src/mocks/MockFXRP.sol";
import {MockFtsoV2} from "../src/mocks/MockFtsoV2.sol";
import {MockFdcVerification} from "../src/mocks/MockFdcVerification.sol";
import {IXRPPayment} from "../src/interfaces/IXRPPayment.sol";
import {MatchInstructionLib} from "../src/libraries/MatchInstructionLib.sol";

contract DvPEscrowTest is WhisperDeskTestBase {
    // =========================================================================================
    // Constructor / admin — mandatory sub-task (c): zero-address guards
    // =========================================================================================

    function test_Constructor_RevertsZeroAddress_TeeSigner() public {
        vm.expectRevert(DvPEscrow.ZeroAddress.selector);
        new DvPEscrow(
            fxrp, bondLedger, address(0), ftso, fdc, SOURCE_ID, feeTreasury, SETTLEMENT_WINDOW, ATTESTATION_BUDGET, MIN_BLOCK
        );
    }

    function test_Constructor_RevertsZeroAddress_Fxrp() public {
        vm.expectRevert(DvPEscrow.ZeroAddress.selector);
        new DvPEscrow(
            MockFXRP(address(0)),
            bondLedger,
            teeSigner,
            ftso,
            fdc,
            SOURCE_ID,
            feeTreasury,
            SETTLEMENT_WINDOW,
            ATTESTATION_BUDGET,
            MIN_BLOCK
        );
    }

    function test_Constructor_RevertsInvalidWindowConfig() public {
        vm.expectRevert(DvPEscrow.InvalidWindowConfig.selector);
        new DvPEscrow(fxrp, bondLedger, teeSigner, ftso, fdc, SOURCE_ID, feeTreasury, 100, 100, MIN_BLOCK);
    }

    /// @notice Step 5: MIN_BLOCK_FXRP is now constructor-set immutable — a testnet/demo instance
    /// can use a small block size (e.g. 1 FXRP) instead of the canonical 5,000 FXRP.
    function test_Constructor_SetsCustomMinBlockFxrp() public {
        DvPEscrow small = new DvPEscrow(
            fxrp, bondLedger, teeSigner, ftso, fdc, SOURCE_ID, feeTreasury, SETTLEMENT_WINDOW, ATTESTATION_BUDGET, ONE_FXRP
        );
        assertEq(small.MIN_BLOCK_FXRP(), ONE_FXRP);
    }

    function test_SetTeeSigner_RevertsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(DvPEscrow.ZeroAddress.selector);
        escrow.setTeeSigner(address(0));
    }

    function test_SetTeeSigner_RevertsNotOwner() public {
        vm.expectRevert(DvPEscrow.NotOwner.selector);
        escrow.setTeeSigner(makeAddr("newSigner"));
    }

    function test_SetTeeSigner_UpdatesSigner_EmitsEvent() public {
        address newSigner = makeAddr("newSigner");
        vm.prank(owner);
        vm.expectEmit(true, true, false, false, address(escrow));
        emit DvPEscrow.TeeSignerUpdated(teeSigner, newSigner);
        escrow.setTeeSigner(newSigner);
        assertEq(escrow.teeSigner(), newSigner);
    }

    // audit note (22 Jul): setFeeTreasury must reject address(0), consistent with setTeeSigner.
    function test_SetFeeTreasury_RevertsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(DvPEscrow.ZeroAddress.selector);
        escrow.setFeeTreasury(address(0));
    }

    // =========================================================================================
    // deposit / withdraw — mandatory sub-task (a): committed-exposure counter
    // =========================================================================================

    function test_Deposit_ArmsBalance() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 1000));
        (uint128 armed, uint128 committed, uint64 armedUntil) = escrow.balances(taker);
        assertEq(armed, MIN_BLOCK);
        assertEq(committed, 0);
        assertEq(armedUntil, block.timestamp + 1000);
    }

    function test_Deposit_ExtendsArmedUntilMonotonically() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 1000));
        // a second, shorter armedUntil must NOT shrink the window
        fxrp.mint(taker, ONE_FXRP);
        vm.startPrank(taker);
        fxrp.approve(address(escrow), ONE_FXRP);
        escrow.deposit(ONE_FXRP, uint64(block.timestamp + 10));
        vm.stopPrank();
        (,, uint64 armedUntil) = escrow.balances(taker);
        assertEq(armedUntil, block.timestamp + 1000);
    }

    function test_Withdraw_RevertsWithdrawLocked_WhileArmed() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 1000));
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.WithdrawLocked.selector, uint64(block.timestamp + 1000)));
        escrow.withdraw(1);
    }

    function test_Withdraw_Succeeds_AfterArmedExpires() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 100));
        vm.warp(block.timestamp + 101);
        vm.prank(taker);
        escrow.withdraw(MIN_BLOCK);
        assertEq(fxrp.balanceOf(taker), MIN_BLOCK);
    }

    /// @notice Mandatory sub-task (a): withdraw() must revert ExceedsUncommitted while
    /// `committed > 0` backs an open Locked match, INDEPENDENT of, and even after, `armedUntil`
    /// has expired. This is the exact review-flagged gap the `committed` counter closes.
    function test_Withdraw_RevertsExceedsUncommitted_WhileMatchOpen_EvenAfterArmedUntilExpires() public {
        // armedUntil is short (RFQ TTL + margin); the match's real settlement deadline outlives it.
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 100));
        _fundMakerBond(maker, MIN_BLOCK / 100 + 1);

        bytes32 matchId = keccak256("match-1");
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(matchId, taker, maker);
        (bytes memory data, bytes memory sig) = _signMatch(mi);
        vm.prank(relayer);
        escrow.lock(data, sig);

        // armedUntil has long since elapsed, but the full amount is still committed.
        vm.warp(block.timestamp + 1000);
        (uint128 armed, uint128 committed,) = escrow.balances(taker);
        assertEq(armed, committed);

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.ExceedsUncommitted.selector, uint256(1), uint256(0)));
        escrow.withdraw(1);
    }

    function test_Withdraw_SucceedsForUncommittedPortion_WhileMatchOpen() public {
        _fundTaker(taker, MIN_BLOCK * 2, uint64(block.timestamp + 100));
        _fundMakerBond(maker, MIN_BLOCK / 100 + 1);

        bytes32 matchId = keccak256("match-1");
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(matchId, taker, maker);
        (bytes memory data, bytes memory sig) = _signMatch(mi);
        vm.prank(relayer);
        escrow.lock(data, sig);

        vm.warp(block.timestamp + 1000);
        vm.prank(taker);
        escrow.withdraw(MIN_BLOCK); // the uncommitted half is still withdrawable
        assertEq(fxrp.balanceOf(taker), MIN_BLOCK);
    }

    /// @notice Regression for the armed/committed solvency fix: after release() pays the maker,
    /// the taker must NOT retain phantom withdrawable "capacity" for tokens that already left the
    /// contract. `armed` must shrink alongside `committed`, not just committed.
    function test_Withdraw_RevertsExceedsUncommitted_NoPhantomCapacity_AfterRelease() public {
        bytes32 matchId = keccak256("m-no-phantom");
        _lockDefaultMatch(matchId);
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx"));
        escrow.release(matchId, proof);

        (uint128 armed, uint128 committed,) = escrow.balances(taker);
        assertEq(armed, 0);
        assertEq(committed, 0);

        vm.warp(block.timestamp + 10_000); // armedUntil long elapsed
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.ExceedsUncommitted.selector, uint256(1), uint256(0)));
        escrow.withdraw(1);
    }

    function test_Release_And_Refund_DecrementCommitted() public {
        bytes32 matchId = keccak256("m-release");
        _lockDefaultMatch(matchId);
        (, uint128 committedBefore,) = escrow.balances(taker);
        assertEq(committedBefore, MIN_BLOCK);

        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx-1"));
        escrow.release(matchId, proof);

        (, uint128 committedAfter,) = escrow.balances(taker);
        assertEq(committedAfter, 0);
    }

    // =========================================================================================
    // lock() — signature verification — mandatory sub-task (c)
    // =========================================================================================

    function test_Lock_RevertsBadSignatureLength() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        _fundMakerBond(maker, MIN_BLOCK / 100 + 1);
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        bytes memory data = abi.encode(mi);
        bytes memory badSig = new bytes(64);
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.BadSignatureLength.selector, uint256(64)));
        escrow.lock(data, badSig);
    }

    function test_Lock_RevertsMalleableSignature_HighS() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        _fundMakerBond(maker, MIN_BLOCK / 100 + 1);
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        bytes memory data = abi.encode(mi);
        bytes32 digest = MatchInstructionLib.ethSignedDigest(keccak256(data), block.chainid);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(teeSignerPk, digest);

        // flip to the malleable high-S sibling signature (same signer, invalid per our canonicality rule)
        bytes32 sFlipped = bytes32(SECP256K1N - uint256(s));
        uint8 vFlipped = v == 27 ? 28 : 27;
        bytes memory badSig = abi.encodePacked(r, sFlipped, vFlipped);

        vm.expectRevert(DvPEscrow.MalleableSignature.selector);
        escrow.lock(data, badSig);
    }

    /// @notice Mandatory sub-task (c): a garbage signature that causes `ecrecover` to return
    /// address(0) must be rejected BEFORE comparison to teeSigner, via an explicit zero-address
    /// check (not merely because address(0) happens not to equal teeSigner).
    function test_Lock_RevertsInvalidTeeSignature_ZeroAddressRecovered() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        _fundMakerBond(maker, MIN_BLOCK / 100 + 1);
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        bytes memory data = abi.encode(mi);

        // r = 0 is outside the valid secp256k1 range for the ecrecover precompile — it
        // deterministically returns address(0) without reverting.
        bytes memory garbageSig = abi.encodePacked(bytes32(0), bytes32(uint256(1)), uint8(27));

        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.InvalidTeeSignature.selector, address(0)));
        escrow.lock(data, garbageSig);
    }

    function test_Lock_RevertsInvalidTeeSignature_WrongSigner() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        _fundMakerBond(maker, MIN_BLOCK / 100 + 1);
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        bytes memory data = abi.encode(mi);
        bytes32 digest = MatchInstructionLib.ethSignedDigest(keccak256(data), block.chainid);

        uint256 wrongPk = 0xBEEF;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, digest);
        bytes memory wrongSig = abi.encodePacked(r, s, v);

        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.InvalidTeeSignature.selector, vm.addr(wrongPk)));
        escrow.lock(data, wrongSig);
    }

    // =========================================================================================
    // lock() — structural / policy checks
    // =========================================================================================

    function test_Lock_RevertsWrongEscrow() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        _fundMakerBond(maker, MIN_BLOCK / 100 + 1);
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        mi.escrow = address(0xdead);
        (bytes memory data, bytes memory sig) = _signMatch(mi);
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.WrongEscrow.selector, address(escrow)));
        escrow.lock(data, sig);
    }

    function test_Lock_RevertsMatchExists_OnReplay() public {
        bytes32 matchId = keccak256("m-replay");
        _lockDefaultMatch(matchId);

        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(matchId, taker, maker);
        (bytes memory data, bytes memory sig) = _signMatch(mi);
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.MatchExists.selector, matchId));
        escrow.lock(data, sig);
    }

    function test_Lock_RevertsInstructionExpired() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        _fundMakerBond(maker, MIN_BLOCK / 100 + 1);
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        mi.instructionExpiresAt = uint64(block.timestamp + 10);
        (bytes memory data, bytes memory sig) = _signMatch(mi);

        vm.warp(block.timestamp + 11);
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.InstructionExpired.selector, mi.instructionExpiresAt));
        escrow.lock(data, sig);
    }

    function test_Lock_RevertsSelfMatch() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, taker);
        (bytes memory data, bytes memory sig) = _signMatch(mi);
        vm.expectRevert(DvPEscrow.SelfMatch.selector);
        escrow.lock(data, sig);
    }

    function test_Lock_RevertsBelowMinBlock() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        mi.amountFxrp = MIN_BLOCK - 1;
        (bytes memory data, bytes memory sig) = _signMatch(mi);
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.BelowMinBlock.selector, mi.amountFxrp));
        escrow.lock(data, sig);
    }

    function test_Lock_RevertsEmptyXrplAddress() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        mi.takerXrplAddress = "";
        (bytes memory data, bytes memory sig) = _signMatch(mi);
        vm.expectRevert(DvPEscrow.EmptyXrplAddress.selector);
        escrow.lock(data, sig);
    }

    function test_Lock_RevertsLockIsPaused() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        (bytes memory data, bytes memory sig) = _signMatch(mi);

        vm.prank(owner);
        escrow.setLockPaused(true);

        vm.expectRevert(DvPEscrow.LockIsPaused.selector);
        escrow.lock(data, sig);
    }

    // =========================================================================================
    // lock() — FTSOv2 band re-check
    // =========================================================================================

    function test_Lock_RevertsFeeTooLow() public {
        ftso.setFee(1000);
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        _fundMakerBond(maker, MIN_BLOCK / 100 + 1);
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        (bytes memory data, bytes memory sig) = _signMatch(mi);
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.FeeTooLow.selector, uint256(1000), uint256(0)));
        escrow.lock(data, sig);
    }

    function test_Lock_RevertsOracleZero() public {
        ftso.setFeed(0, uint64(block.timestamp));
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        _fundMakerBond(maker, MIN_BLOCK / 100 + 1);
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        (bytes memory data, bytes memory sig) = _signMatch(mi);
        vm.expectRevert(DvPEscrow.OracleZero.selector);
        escrow.lock(data, sig);
    }

    function test_Lock_RevertsStaleOracle() public {
        ftso.setFeed(ONE_USD18, uint64(block.timestamp));
        vm.warp(block.timestamp + 61);
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        _fundMakerBond(maker, MIN_BLOCK / 100 + 1);
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        (bytes memory data, bytes memory sig) = _signMatch(mi);
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.StaleOracle.selector, uint64(block.timestamp - 61)));
        escrow.lock(data, sig);
    }

    function test_Lock_RevertsPriceOutOfBand_Above() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        _fundMakerBond(maker, MIN_BLOCK / 100 + 1);
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        mi.priceUsd18 = (ONE_USD18 * 10101) / 10000; // 1.0101x mid, just outside +1%
        (bytes memory data, bytes memory sig) = _signMatch(mi);
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.PriceOutOfBand.selector, mi.priceUsd18, ONE_USD18));
        escrow.lock(data, sig);
    }

    function test_Lock_RevertsPriceOutOfBand_Below() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        _fundMakerBond(maker, MIN_BLOCK / 100 + 1);
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        mi.priceUsd18 = (ONE_USD18 * 9899) / 10000; // just outside -1%
        (bytes memory data, bytes memory sig) = _signMatch(mi);
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.PriceOutOfBand.selector, mi.priceUsd18, ONE_USD18));
        escrow.lock(data, sig);
    }

    function test_Lock_AllowsExactBandEdge_Plus1Percent() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        _fundMakerBond(maker, MIN_BLOCK / 100 + 1);
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        mi.priceUsd18 = (ONE_USD18 * 10100) / 10000; // exactly +1.00%
        (bytes memory data, bytes memory sig) = _signMatch(mi);
        escrow.lock(data, sig); // must not revert
    }

    function test_Lock_AllowsExactBandEdge_Minus1Percent() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        _fundMakerBond(maker, MIN_BLOCK / 100 + 1);
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        mi.priceUsd18 = (ONE_USD18 * 9900) / 10000; // exactly -1.00%
        (bytes memory data, bytes memory sig) = _signMatch(mi);
        escrow.lock(data, sig); // must not revert
    }

    // =========================================================================================
    // lock() — armed balance / committed reservation
    // =========================================================================================

    function test_Lock_RevertsInsufficientArmedBalance_NotArmed() public {
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        (bytes memory data, bytes memory sig) = _signMatch(mi);
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.InsufficientArmedBalance.selector, MIN_BLOCK, uint256(0)));
        escrow.lock(data, sig);
    }

    function test_Lock_RevertsInsufficientArmedBalance_TooLittleFunds() public {
        _fundTaker(taker, MIN_BLOCK - 1, uint64(block.timestamp + 3600));
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        (bytes memory data, bytes memory sig) = _signMatch(mi);
        vm.expectRevert(
            abi.encodeWithSelector(DvPEscrow.InsufficientArmedBalance.selector, MIN_BLOCK, MIN_BLOCK - 1)
        );
        escrow.lock(data, sig);
    }

    function test_Lock_RevertsInsufficientFreeBond_BubblesFromBondLedger() public {
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        // no bond deposited for maker
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        (bytes memory data, bytes memory sig) = _signMatch(mi);
        uint256 needBond = MIN_BLOCK / 100;
        vm.expectRevert(abi.encodeWithSelector(BondLedger.InsufficientFreeBond.selector, needBond, uint256(0)));
        escrow.lock(data, sig);
    }

    // =========================================================================================
    // lock() — happy path + surplus refund (mandatory sub-task (d))
    // =========================================================================================

    function test_Lock_HappyPath_ReservesFundsAndEmitsMatchLocked() public {
        bytes32 matchId = keccak256("m-happy");
        _lockDefaultMatch(matchId);

        (
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
        ) = _readMatch(matchId);

        assertEq(mTaker, taker);
        assertEq(mMaker, maker);
        assertEq(destinationTag, 1);
        assertEq(uint8(state), uint8(DvPEscrow.MatchState.Locked));
        assertEq(amountFxrp, MIN_BLOCK);
        assertEq(xrpDrops, MIN_BLOCK); // price == mid == 1.0 => 1:1
        assertEq(bondAmount, MIN_BLOCK / 100);
        assertEq(paymentDeadline, lockedAt + PAYMENT_WINDOW);
        assertEq(refundAfter, lockedAt + SETTLEMENT_WINDOW);

        (, uint128 committed,) = escrow.balances(taker);
        assertEq(committed, MIN_BLOCK);
        assertEq(bondLedger.freeBond(maker), 1); // deposited 1% + 1, all-but-1 wei locked
    }

    function test_Lock_AssignsIncrementingDestinationTags() public {
        _lockDefaultMatch(keccak256("m1"));
        (, uint32 tag1,,,,,,,,,) = _readMatch(keccak256("m1"));
        assertEq(tag1, 1);

        address taker2 = makeAddr("taker2");
        address maker2 = makeAddr("maker2");
        _fundTaker(taker2, MIN_BLOCK, uint64(block.timestamp + 3600));
        _fundMakerBond(maker2, MIN_BLOCK / 100 + 1);
        MatchInstructionLib.MatchInstruction memory mi2 = _defaultMatch(keccak256("m2"), taker2, maker2);
        (bytes memory data2, bytes memory sig2) = _signMatch(mi2);
        escrow.lock(data2, sig2);

        (, uint32 tag2,,,,,,,,,) = _readMatch(keccak256("m2"));
        assertEq(tag2, 2);
    }

    /// @notice Mandatory sub-task (d): lock() refunds msg.value surplus over the FTSOv2 fee — no
    /// stranded C2FLR.
    function test_Lock_RefundsSurplusMsgValue() public {
        ftso.setFee(1_000);
        _fundTaker(taker, MIN_BLOCK, uint64(block.timestamp + 3600));
        _fundMakerBond(maker, MIN_BLOCK / 100 + 1);
        MatchInstructionLib.MatchInstruction memory mi = _defaultMatch(keccak256("m"), taker, maker);
        (bytes memory data, bytes memory sig) = _signMatch(mi);

        vm.deal(relayer, 1 ether);
        vm.txGasPrice(0); // isolate the balance delta from gas cost
        uint256 before = relayer.balance;

        vm.prank(relayer);
        escrow.lock{value: 10_000}(data, sig);

        // exactly the fee (1,000) should have left the relayer's balance; the 9,000 surplus refunded
        assertEq(before - relayer.balance, 1_000);
        // the fee is forwarded to FTSOv2 (getFeedByIdInWei is payable), so the escrow keeps nothing
        assertEq(address(escrow).balance, 0);
        assertEq(address(ftso).balance, 1_000);
    }

    // =========================================================================================
    // release() — mandatory sub-task (b): proofOwner FIRST + usedTxId consumed-mapping
    // =========================================================================================

    function test_Release_HappyPath() public {
        bytes32 matchId = keccak256("m-release-happy");
        _lockDefaultMatch(matchId);
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx-happy"));

        vm.expectEmit(true, true, false, true, address(escrow));
        emit DvPEscrow.MatchReleased(matchId, maker, MIN_BLOCK, keccak256("tx-happy"));
        escrow.release(matchId, proof);

        (,,, DvPEscrow.MatchState state,,,,,,,) = _readMatch(matchId);
        assertEq(uint8(state), uint8(DvPEscrow.MatchState.Released));
        assertEq(fxrp.balanceOf(maker), MIN_BLOCK);
        assertEq(bondLedger.freeBond(maker), MIN_BLOCK / 100 + 1); // bond returned in full
    }

    function test_Release_RevertsNotLocked_UnknownMatch() public {
        IXRPPayment.Proof memory proof = _validProof(keccak256("nope"), keccak256("tx"));
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.NotLocked.selector, keccak256("nope")));
        escrow.release(keccak256("nope"), proof);
    }

    /// @notice Mandatory sub-task (b): proofOwner is checked FIRST, before any other proof content.
    function test_Release_RevertsWrongProofOwner() public {
        bytes32 matchId = keccak256("m-wrong-owner");
        _lockDefaultMatch(matchId);
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx"));
        proof.data.requestBody.proofOwner = address(0xBADBAD);

        vm.expectRevert(DvPEscrow.WrongProofOwner.selector);
        escrow.release(matchId, proof);
    }

    /// @notice Mandatory sub-task (b): a second release() attempt reusing the same XRPL
    /// transactionId (e.g. against a fresh Locked match at the same or another matchId) is
    /// rejected by the usedTxId consumed-mapping, independent of the one-shot Locked state.
    function test_Release_RevertsProofInvalid_OnTxIdReplay() public {
        bytes32 matchId1 = keccak256("m-replay-1");
        bytes32 matchId2 = keccak256("m-replay-2");
        _lockDefaultMatch(matchId1);

        // second match, second taker/maker, same underlying escrow instance
        address taker2 = makeAddr("taker2");
        address maker2 = makeAddr("maker2");
        _fundTaker(taker2, MIN_BLOCK, uint64(block.timestamp + 3600));
        _fundMakerBond(maker2, MIN_BLOCK / 100 + 1);
        MatchInstructionLib.MatchInstruction memory mi2 = _defaultMatch(matchId2, taker2, maker2);
        (bytes memory data2, bytes memory sig2) = _signMatch(mi2);
        escrow.lock(data2, sig2);

        bytes32 txId = keccak256("shared-tx");
        IXRPPayment.Proof memory proof1 = _validProof(matchId1, txId);
        escrow.release(matchId1, proof1);
        assertTrue(escrow.usedTxId(txId));

        IXRPPayment.Proof memory proof2 = _validProof(matchId2, txId);
        vm.expectRevert(DvPEscrow.ProofInvalid.selector);
        escrow.release(matchId2, proof2);
    }

    function test_Release_RevertsProofInvalid_WhenVerifierRejects() public {
        bytes32 matchId = keccak256("m-verifier-false");
        _lockDefaultMatch(matchId);
        fdc.setResult(false);
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx"));
        vm.expectRevert(DvPEscrow.ProofInvalid.selector);
        escrow.release(matchId, proof);
    }

    function test_Release_RevertsWrongSource_AttestationType() public {
        bytes32 matchId = keccak256("m-wrong-attestation");
        _lockDefaultMatch(matchId);
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx"));
        proof.data.attestationType = bytes32("Payment");
        vm.expectRevert(DvPEscrow.WrongSource.selector);
        escrow.release(matchId, proof);
    }

    function test_Release_RevertsWrongSource_SourceId() public {
        bytes32 matchId = keccak256("m-wrong-source");
        _lockDefaultMatch(matchId);
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx"));
        proof.data.sourceId = bytes32("XRP");
        vm.expectRevert(DvPEscrow.WrongSource.selector);
        escrow.release(matchId, proof);
    }

    /// @notice status == 2 covers tecDST_TAG_NEEDED/tecNO_DST — must be rejected, checked before
    /// the (zeroed) receivingAddressHash comparison.
    function test_Release_RevertsPaymentFailedStatus_TecTrap() public {
        bytes32 matchId = keccak256("m-tec-trap");
        _lockDefaultMatch(matchId);
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx"));
        proof.data.responseBody.status = 2;
        proof.data.responseBody.receivingAddressHash = bytes32(0); // zeroed by the real verifier on failure
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.PaymentFailedStatus.selector, uint8(2)));
        escrow.release(matchId, proof);
    }

    function test_Release_RevertsWrongDestination() public {
        bytes32 matchId = keccak256("m-wrong-dest");
        _lockDefaultMatch(matchId);
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx"));
        proof.data.responseBody.receivingAddressHash = keccak256("some-other-address");
        vm.expectRevert(DvPEscrow.WrongDestination.selector);
        escrow.release(matchId, proof);
    }

    function test_Release_RevertsWrongDestinationTag_Missing() public {
        bytes32 matchId = keccak256("m-missing-tag");
        _lockDefaultMatch(matchId);
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx"));
        proof.data.responseBody.hasDestinationTag = false;
        vm.expectRevert(DvPEscrow.WrongDestinationTag.selector);
        escrow.release(matchId, proof);
    }

    function test_Release_RevertsWrongDestinationTag_Mismatch() public {
        bytes32 matchId = keccak256("m-mismatch-tag");
        _lockDefaultMatch(matchId);
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx"));
        proof.data.responseBody.destinationTag = 999999;
        vm.expectRevert(DvPEscrow.WrongDestinationTag.selector);
        escrow.release(matchId, proof);
    }

    function test_Release_RevertsAmountTooLow() public {
        bytes32 matchId = keccak256("m-amount-low");
        _lockDefaultMatch(matchId);
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx"));
        proof.data.responseBody.receivedAmount = int256(uint256(MIN_BLOCK)) - 1;
        vm.expectRevert(
            abi.encodeWithSelector(DvPEscrow.AmountTooLow.selector, int256(uint256(MIN_BLOCK)) - 1, MIN_BLOCK)
        );
        escrow.release(matchId, proof);
    }

    function test_Release_RevertsAmountTooLow_NegativeAmount() public {
        bytes32 matchId = keccak256("m-negative-amount");
        _lockDefaultMatch(matchId);
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx"));
        proof.data.responseBody.receivedAmount = -1;
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.AmountTooLow.selector, int256(-1), MIN_BLOCK));
        escrow.release(matchId, proof);
    }

    function test_Release_RevertsPaymentBeforeLock() public {
        bytes32 matchId = keccak256("m-before-lock");
        _lockDefaultMatch(matchId);
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx"));
        (,, uint40 lockedAt,,,,,,,,) = _readMatch(matchId);
        proof.data.responseBody.blockTimestamp = lockedAt - 1;
        vm.expectRevert(DvPEscrow.PaymentBeforeLock.selector);
        escrow.release(matchId, proof);
    }

    function test_Release_RevertsPaymentOutsideWindow() public {
        bytes32 matchId = keccak256("m-outside-window");
        _lockDefaultMatch(matchId);
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx"));
        (,,,,, uint40 paymentDeadline,,,,,) = _readMatch(matchId);
        proof.data.responseBody.blockTimestamp = paymentDeadline + 1;
        vm.expectRevert(DvPEscrow.PaymentOutsideWindow.selector);
        escrow.release(matchId, proof);
    }

    function test_Release_RevertsNotLocked_AfterAlreadyReleased() public {
        bytes32 matchId = keccak256("m-double-release");
        _lockDefaultMatch(matchId);
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx"));
        escrow.release(matchId, proof);

        IXRPPayment.Proof memory proof2 = _validProof(matchId, keccak256("tx-2"));
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.NotLocked.selector, matchId));
        escrow.release(matchId, proof2);
    }

    /// @notice Mandatory sub-task (b), cross-instance replay: a proof whose `proofOwner` points at
    /// a DIFFERENT DvPEscrow instance must be rejected by this instance, even when this instance
    /// has an open match with matching destination tag / amount / address hash.
    function test_Release_RevertsWrongProofOwner_CrossInstance() public {
        // second, independent escrow+bond stack
        vm.startPrank(owner);
        BondLedger bondLedger2 = new BondLedger(fxrp);
        DvPEscrow escrow2 = new DvPEscrow(
            fxrp,
            bondLedger2,
            teeSigner,
            ftso,
            fdc,
            SOURCE_ID,
            feeTreasury,
            SETTLEMENT_WINDOW,
            ATTESTATION_BUDGET,
            MIN_BLOCK
        );
        bondLedger2.setEscrow(address(escrow2));
        vm.stopPrank();

        bytes32 matchId = keccak256("m-cross-instance");
        fxrp.mint(taker, MIN_BLOCK);
        vm.startPrank(taker);
        fxrp.approve(address(escrow2), MIN_BLOCK);
        escrow2.deposit(MIN_BLOCK, uint64(block.timestamp + 3600));
        vm.stopPrank();

        fxrp.mint(maker, MIN_BLOCK / 100 + 1);
        vm.startPrank(maker);
        fxrp.approve(address(bondLedger2), MIN_BLOCK / 100 + 1);
        bondLedger2.depositBond(MIN_BLOCK / 100 + 1);
        vm.stopPrank();

        MatchInstructionLib.MatchInstruction memory mi = MatchInstructionLib.MatchInstruction({
            matchId: matchId,
            escrow: address(escrow2),
            taker: taker,
            maker: maker,
            amountFxrp: MIN_BLOCK,
            priceUsd18: ONE_USD18,
            takerXrplAddress: TAKER_XRPL_ADDR,
            instructionExpiresAt: uint64(block.timestamp + 300)
        });
        bytes memory data = abi.encode(mi);
        bytes32 digest = MatchInstructionLib.ethSignedDigest(keccak256(data), block.chainid);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(teeSignerPk, digest);
        if (uint256(s) > SECP256K1N_HALF) {
            s = bytes32(SECP256K1N - uint256(s));
            v = v == 27 ? 28 : 27;
        }
        escrow2.lock(data, abi.encodePacked(r, s, v));

        // Build a proof for escrow2's match, but with proofOwner bound to the FIRST escrow
        // instance (as if it were requested for, and originally intended to settle, a match on
        // `escrow`, then replayed here).
        IXRPPayment.Proof memory proof;
        proof.merkleProof = new bytes32[](0);
        proof.data.attestationType = ATTESTATION_TYPE;
        proof.data.sourceId = SOURCE_ID;
        proof.data.requestBody.transactionId = keccak256("tx-cross");
        proof.data.requestBody.proofOwner = address(escrow); // WRONG instance
        proof.data.responseBody.blockTimestamp = uint64(block.timestamp);
        proof.data.responseBody.sourceAddress = "rX";
        proof.data.responseBody.receivingAddressHash = keccak256(bytes(TAKER_XRPL_ADDR));
        proof.data.responseBody.hasDestinationTag = true;
        proof.data.responseBody.destinationTag = 1;
        proof.data.responseBody.receivedAmount = int256(MIN_BLOCK);
        proof.data.responseBody.status = 0;

        vm.expectRevert(DvPEscrow.WrongProofOwner.selector);
        escrow2.release(matchId, proof);
    }

    // =========================================================================================
    // refund()
    // =========================================================================================

    function test_Refund_HappyPath_SlashesBondToTaker() public {
        bytes32 matchId = keccak256("m-refund");
        _lockDefaultMatch(matchId);
        (,,,,,, uint40 refundAfter,,,,) = _readMatch(matchId);

        vm.warp(refundAfter + REFUND_GRACE + 1);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit DvPEscrow.MatchRefunded(matchId, taker, MIN_BLOCK, MIN_BLOCK / 100);
        escrow.refund(matchId);

        (,,, DvPEscrow.MatchState state,,,,,,,) = _readMatch(matchId);
        assertEq(uint8(state), uint8(DvPEscrow.MatchState.Refunded));
        // refund pays principal + 100% of the slashed 1% bond to the taker (design.md §3.8)
        assertEq(fxrp.balanceOf(taker), MIN_BLOCK + MIN_BLOCK / 100);
    }

    function test_Refund_SlashesBondAmountToTaker_Exactly() public {
        bytes32 matchId = keccak256("m-refund-bond");
        _lockDefaultMatch(matchId);
        (,,,,,, uint40 refundAfter,,, uint128 bondAmount,) = _readMatch(matchId);
        vm.warp(refundAfter + REFUND_GRACE + 1);

        uint256 takerBalBefore = fxrp.balanceOf(taker);
        escrow.refund(matchId);
        uint256 takerBalAfter = fxrp.balanceOf(taker);

        assertEq(takerBalAfter - takerBalBefore, MIN_BLOCK + bondAmount);
    }

    function test_Refund_RevertsRefundTooEarly() public {
        bytes32 matchId = keccak256("m-too-early");
        _lockDefaultMatch(matchId);
        (,,,,,, uint40 refundAfter,,,,) = _readMatch(matchId);
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.RefundTooEarly.selector, refundAfter));
        escrow.refund(matchId);
    }

    /// @notice Proving test for the REFUND_GRACE fix (design.md §14 item 1): refundAfter alone is
    /// no longer sufficient — refund() must still revert anywhere strictly inside the grace window,
    /// including exactly at the `refundAfter + REFUND_GRACE` boundary.
    function test_Refund_RevertsRefundTooEarly_AtExactGraceBoundary() public {
        bytes32 matchId = keccak256("m-grace-boundary");
        _lockDefaultMatch(matchId);
        (,,,,,, uint40 refundAfter,,,,) = _readMatch(matchId);

        assertEq(escrow.REFUND_GRACE(), REFUND_GRACE);

        vm.warp(refundAfter + REFUND_GRACE); // exactly at the boundary — still too early
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.RefundTooEarly.selector, refundAfter));
        escrow.refund(matchId);

        vm.warp(refundAfter + REFUND_GRACE + 1); // one second later — now callable
        escrow.refund(matchId); // must not revert
    }

    /// @notice Proving test for the REFUND_GRACE fix (design.md §14 item 1): an honest maker who
    /// paid before `paymentDeadline` must still be able to have their FDC proof consumed by
    /// release() even if the proof lands shortly after `refundAfter`, as long as it is within
    /// REFUND_GRACE — and a taker racing to snipe refund() in that exact window must fail.
    function test_Release_SucceedsWithinRefundGrace_AndRefundRevertsInGraceWindow() public {
        bytes32 matchId = keccak256("m-grace-window");
        _lockDefaultMatch(matchId);
        (,,,,, uint40 paymentDeadline, uint40 refundAfter,,,,) = _readMatch(matchId);

        // Honest maker paid before the payment deadline.
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx-grace"));
        proof.data.responseBody.blockTimestamp = paymentDeadline - 1;

        // The relayer's FDC proof lands shortly after refundAfter, still within REFUND_GRACE.
        vm.warp(refundAfter + REFUND_GRACE - 1);

        // A taker trying to snipe refund() in this exact window must still fail.
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.RefundTooEarly.selector, refundAfter));
        escrow.refund(matchId);

        // The honest release() still succeeds.
        escrow.release(matchId, proof);
        (,,, DvPEscrow.MatchState state,,,,,,,) = _readMatch(matchId);
        assertEq(uint8(state), uint8(DvPEscrow.MatchState.Released));
        assertEq(fxrp.balanceOf(maker), MIN_BLOCK);

        // And refund() is now permanently unavailable for this match (already Released).
        vm.warp(refundAfter + REFUND_GRACE + 1);
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.NotLocked.selector, matchId));
        escrow.refund(matchId);
    }

    function test_Refund_RevertsNotLocked_UnknownMatch() public {
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.NotLocked.selector, keccak256("nope")));
        escrow.refund(keccak256("nope"));
    }

    function test_Refund_RevertsNotLocked_AfterAlreadyRefunded() public {
        bytes32 matchId = keccak256("m-double-refund");
        _lockDefaultMatch(matchId);
        (,,,,,, uint40 refundAfter,,,,) = _readMatch(matchId);
        vm.warp(refundAfter + REFUND_GRACE + 1);
        escrow.refund(matchId);
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.NotLocked.selector, matchId));
        escrow.refund(matchId);
    }

    function test_Refund_RevertsNotLocked_AfterAlreadyReleased() public {
        bytes32 matchId = keccak256("m-refund-after-release");
        _lockDefaultMatch(matchId);
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx"));
        escrow.release(matchId, proof);

        vm.warp(block.timestamp + SETTLEMENT_WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.NotLocked.selector, matchId));
        escrow.refund(matchId);
    }

    /// @notice First transaction wins (design.md §3.3): release() stays callable after
    /// refundAfter until refund() actually executes.
    function test_Release_StillCallable_AfterRefundAfterElapsed_BeforeRefundCalled() public {
        bytes32 matchId = keccak256("m-race");
        _lockDefaultMatch(matchId);
        (,,,,,, uint40 refundAfter,,,,) = _readMatch(matchId);
        // warp into the refundable window, but stay within the payment window too so a payment
        // timestamp still validates
        vm.warp(refundAfter + 1);
        IXRPPayment.Proof memory proof = _validProof(matchId, keccak256("tx"));
        (,,,,, uint40 paymentDeadline,,,,,) = _readMatch(matchId);
        proof.data.responseBody.blockTimestamp = paymentDeadline; // still inside PAYMENT_WINDOW
        escrow.release(matchId, proof); // must succeed — release() has no deadline gate itself
        (,,, DvPEscrow.MatchState state,,,,,,,) = _readMatch(matchId);
        assertEq(uint8(state), uint8(DvPEscrow.MatchState.Released));
    }
}
