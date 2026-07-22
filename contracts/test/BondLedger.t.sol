// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {BondLedger} from "../src/BondLedger.sol";
import {MockFXRP} from "../src/mocks/MockFXRP.sol";

contract BondLedgerTest is Test {
    BondLedger internal bondLedger;
    MockFXRP internal fxrp;

    address internal owner = makeAddr("owner");
    address internal escrow = makeAddr("escrow");
    address internal maker = makeAddr("maker");
    address internal taker = makeAddr("taker");

    uint256 internal constant ONE_FXRP = 1e6;

    function setUp() public {
        vm.startPrank(owner);
        fxrp = new MockFXRP();
        bondLedger = new BondLedger(fxrp);
        bondLedger.setEscrow(escrow);
        vm.stopPrank();
    }

    function _fundBond(address who, uint256 amount) internal {
        fxrp.mint(who, amount);
        vm.startPrank(who);
        fxrp.approve(address(bondLedger), amount);
        bondLedger.depositBond(amount);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------
    // constructor / setEscrow
    // ---------------------------------------------------------------------------------------

    function test_Constructor_RevertsZeroAddress() public {
        vm.expectRevert(BondLedger.ZeroAddress.selector);
        new BondLedger(MockFXRP(address(0)));
    }

    function test_SetEscrow_RevertsEscrowAlreadySet() public {
        vm.prank(owner);
        vm.expectRevert(BondLedger.EscrowAlreadySet.selector);
        bondLedger.setEscrow(makeAddr("other"));
    }

    function test_SetEscrow_RevertsZeroAddress() public {
        BondLedger fresh = new BondLedger(fxrp);
        vm.expectRevert(BondLedger.ZeroAddress.selector);
        fresh.setEscrow(address(0));
    }

    function test_SetEscrow_RevertsNotOwner() public {
        BondLedger fresh = new BondLedger(fxrp); // deployed by this test contract -> it is the owner
        vm.prank(makeAddr("notOwner"));
        vm.expectRevert(BondLedger.NotOwner.selector);
        fresh.setEscrow(escrow);
    }

    // ---------------------------------------------------------------------------------------
    // depositBond / withdrawBond
    // ---------------------------------------------------------------------------------------

    function test_DepositBond_IncreasesFreeBond() public {
        _fundBond(maker, 100 * ONE_FXRP);
        assertEq(bondLedger.freeBond(maker), 100 * ONE_FXRP);
        assertEq(fxrp.balanceOf(address(bondLedger)), 100 * ONE_FXRP);
    }

    function test_WithdrawBond_ReducesFreeBond() public {
        _fundBond(maker, 100 * ONE_FXRP);
        vm.prank(maker);
        bondLedger.withdrawBond(40 * ONE_FXRP);
        assertEq(bondLedger.freeBond(maker), 60 * ONE_FXRP);
        assertEq(fxrp.balanceOf(maker), 40 * ONE_FXRP);
    }

    function test_WithdrawBond_RevertsInsufficientFreeBond() public {
        _fundBond(maker, 10 * ONE_FXRP);
        vm.prank(maker);
        vm.expectRevert(
            abi.encodeWithSelector(BondLedger.InsufficientFreeBond.selector, 11 * ONE_FXRP, 10 * ONE_FXRP)
        );
        bondLedger.withdrawBond(11 * ONE_FXRP);
    }

    // ---------------------------------------------------------------------------------------
    // lockBond / releaseBond / slashBond — onlyEscrow
    // ---------------------------------------------------------------------------------------

    function test_LockBond_RevertsNotEscrow() public {
        _fundBond(maker, 100 * ONE_FXRP);
        vm.expectRevert(BondLedger.NotEscrow.selector);
        bondLedger.lockBond(keccak256("m"), maker, 1 * ONE_FXRP);
    }

    function test_LockBond_RevertsInsufficientFreeBond() public {
        _fundBond(maker, 5 * ONE_FXRP);
        vm.prank(escrow);
        vm.expectRevert(
            abi.encodeWithSelector(BondLedger.InsufficientFreeBond.selector, 6 * ONE_FXRP, 5 * ONE_FXRP)
        );
        bondLedger.lockBond(keccak256("m"), maker, 6 * ONE_FXRP);
    }

    function test_LockBond_MovesFromFreeToLocked() public {
        _fundBond(maker, 100 * ONE_FXRP);
        vm.prank(escrow);
        bondLedger.lockBond(keccak256("m"), maker, 30 * ONE_FXRP);
        assertEq(bondLedger.freeBond(maker), 70 * ONE_FXRP);
        (address m, uint128 amt, bool active) = bondLedger.lockedBonds(keccak256("m"));
        assertEq(m, maker);
        assertEq(amt, 30 * ONE_FXRP);
        assertTrue(active);
    }

    function test_ReleaseBond_ReturnsToFree() public {
        _fundBond(maker, 100 * ONE_FXRP);
        vm.startPrank(escrow);
        bondLedger.lockBond(keccak256("m"), maker, 30 * ONE_FXRP);
        bondLedger.releaseBond(keccak256("m"));
        vm.stopPrank();
        assertEq(bondLedger.freeBond(maker), 100 * ONE_FXRP);
        (,, bool active) = bondLedger.lockedBonds(keccak256("m"));
        assertFalse(active);
    }

    function test_ReleaseBond_RevertsBondNotActive() public {
        vm.prank(escrow);
        vm.expectRevert(abi.encodeWithSelector(BondLedger.BondNotActive.selector, keccak256("m")));
        bondLedger.releaseBond(keccak256("m"));
    }

    function test_ReleaseBond_RevertsNotEscrow() public {
        vm.expectRevert(BondLedger.NotEscrow.selector);
        bondLedger.releaseBond(keccak256("m"));
    }

    function test_SlashBond_TransfersToHonestTaker_NotBackToMaker() public {
        _fundBond(maker, 100 * ONE_FXRP);
        vm.startPrank(escrow);
        bondLedger.lockBond(keccak256("m"), maker, 30 * ONE_FXRP);
        bondLedger.slashBond(keccak256("m"), taker);
        vm.stopPrank();

        assertEq(fxrp.balanceOf(taker), 30 * ONE_FXRP);
        assertEq(bondLedger.freeBond(maker), 70 * ONE_FXRP); // slashed portion never returns to maker
        (,, bool active) = bondLedger.lockedBonds(keccak256("m"));
        assertFalse(active);
    }

    function test_SlashBond_RevertsBondNotActive_DoubleSlash() public {
        _fundBond(maker, 100 * ONE_FXRP);
        vm.startPrank(escrow);
        bondLedger.lockBond(keccak256("m"), maker, 30 * ONE_FXRP);
        bondLedger.slashBond(keccak256("m"), taker);
        vm.expectRevert(abi.encodeWithSelector(BondLedger.BondNotActive.selector, keccak256("m")));
        bondLedger.slashBond(keccak256("m"), taker);
        vm.stopPrank();
    }

    function test_SlashBond_RevertsNotEscrow() public {
        vm.expectRevert(BondLedger.NotEscrow.selector);
        bondLedger.slashBond(keccak256("m"), taker);
    }

    /// @notice Concurrent matches per maker: N locks against the same free bond conserve
    /// correctly, and the (N+1)-th lock that would overextend reverts cleanly (design.md §3.9).
    function test_ConcurrentMatches_PerMaker_ReserveIndependently() public {
        _fundBond(maker, 100 * ONE_FXRP);
        vm.startPrank(escrow);
        bondLedger.lockBond(keccak256("m1"), maker, 40 * ONE_FXRP);
        bondLedger.lockBond(keccak256("m2"), maker, 40 * ONE_FXRP);
        assertEq(bondLedger.freeBond(maker), 20 * ONE_FXRP);

        vm.expectRevert(
            abi.encodeWithSelector(BondLedger.InsufficientFreeBond.selector, 21 * ONE_FXRP, 20 * ONE_FXRP)
        );
        bondLedger.lockBond(keccak256("m3"), maker, 21 * ONE_FXRP);
        vm.stopPrank();

        // releasing one frees exactly its own reservation, the other stays locked
        vm.prank(escrow);
        bondLedger.releaseBond(keccak256("m1"));
        assertEq(bondLedger.freeBond(maker), 60 * ONE_FXRP);
        (,, bool m2Active) = bondLedger.lockedBonds(keccak256("m2"));
        assertTrue(m2Active);
    }
}
