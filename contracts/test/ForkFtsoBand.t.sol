// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {WhisperDeskTestBase} from "./helpers/WhisperDeskTestBase.sol";
import {DvPEscrow} from "../src/DvPEscrow.sol";
import {BondLedger} from "../src/BondLedger.sol";
import {MockFXRP} from "../src/mocks/MockFXRP.sol";
import {MockFtsoV2} from "../src/mocks/MockFtsoV2.sol";
import {MockFdcVerification} from "../src/mocks/MockFdcVerification.sol";
import {MatchInstructionLib} from "../src/libraries/MatchInstructionLib.sol";

/// @notice Minimal local mirror of `FlareContractRegistry.getContractAddressByName`
/// (network-tooling.md §2) — see the identical interface/rationale comment in ForkFdcRelease.t.sol.
interface IFlareContractRegistry {
    function getContractAddressByName(string calldata _name) external view returns (address);
}

/// @title ForkFtsoBand
/// @notice Step 5 integration proof: DvPEscrow's `lock()` +/-1% FTSOv2 XRP/USD band check
/// (design.md §3.6, `BAND_BIPS = 100`) evaluated against the REAL, live Coston2 `FtsoV2` contract
/// (resolved via `FlareContractRegistry`, never hardcoded — flare-docs/ftsov2.md §9 gotcha #1 notes
/// conflicting addresses across guide pages, so the registry is the only trustworthy source).
/// A price exactly at the live mid passes; a price outside the ±1% band reverts
/// `PriceOutOfBand` — both against the real feed value read over the fork, not `MockFtsoV2`.
contract ForkFtsoBandTest is WhisperDeskTestBase {
    address internal constant REGISTRY = 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019;
    bytes21 internal constant XRP_USD_FEED_ID = 0x015852502f55534400000000000000000000000000;

    address internal realFtsoV2;

    function setUp() public override {
        // Pin the fork BEFORE any local deployment / registry lookup so the feed read below is
        // real, live Coston2 state, and stays constant for the duration of this test (the fork
        // snapshot is frozen; local test transactions do not advance the real chain's feed).
        vm.createSelectFork("coston2");

        teeSigner = vm.addr(teeSignerPk);

        address resolved = IFlareContractRegistry(REGISTRY).getContractAddressByName("FtsoV2");
        require(resolved != address(0), "registry: FtsoV2 not resolved");
        realFtsoV2 = resolved;

        vm.startPrank(owner);
        fxrp = new MockFXRP();
        bondLedger = new BondLedger(fxrp);
        // ftso's declared type is MockFtsoV2, but it is pointed at the REAL deployed FtsoV2's
        // address (identical `calculateFeeById`/`getFeedByIdInWei` selectors per IFtsoV2) so every
        // ftso.* call in this file actually reads live Coston2 — this file deliberately never
        // calls the Mock-only `setFeed`/`setFee` setters on it.
        ftso = MockFtsoV2(realFtsoV2);
        fdc = new MockFdcVerification(); // release() / FDC path is not exercised in this file

        escrow = new DvPEscrow(
            fxrp,
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
        bondLedger.setEscrow(address(escrow));
        vm.stopPrank();
    }

    function _liveMid() internal returns (uint256 mid18, uint64 ts, uint256 fee) {
        fee = ftso.calculateFeeById(XRP_USD_FEED_ID);
        (mid18, ts) = ftso.getFeedByIdInWei{value: fee}(XRP_USD_FEED_ID);
    }

    function _lockAt(bytes32 matchId, uint256 priceUsd18, uint256 fee) internal {
        fxrp.mint(taker, MIN_BLOCK);
        vm.startPrank(taker);
        fxrp.approve(address(escrow), MIN_BLOCK);
        escrow.deposit(MIN_BLOCK, uint64(block.timestamp + 3600));
        vm.stopPrank();

        fxrp.mint(maker, MIN_BLOCK / 100 + 1);
        vm.startPrank(maker);
        fxrp.approve(address(bondLedger), MIN_BLOCK / 100 + 1);
        bondLedger.depositBond(MIN_BLOCK / 100 + 1);
        vm.stopPrank();

        MatchInstructionLib.MatchInstruction memory mi = MatchInstructionLib.MatchInstruction({
            matchId: matchId,
            escrow: address(escrow),
            taker: taker,
            maker: maker,
            amountFxrp: MIN_BLOCK,
            priceUsd18: priceUsd18,
            takerXrplAddress: TAKER_XRPL_ADDR,
            instructionExpiresAt: uint64(block.timestamp + 300)
        });
        (bytes memory data, bytes memory sig) = _signMatch(mi);

        vm.prank(relayer);
        escrow.lock{value: fee}(data, sig);
    }

    /// @notice Live half, success path: the FTSOv2 feed is fresh enough to pass `MAX_ORACLE_AGE`
    /// and the current live mid is a real, nonzero XRP/USD price straight off Coston2.
    function test_Live_XrpUsdFeed_IsFreshAndNonzero() public {
        (uint256 mid18, uint64 ts,) = _liveMid();
        assertGt(mid18, 0, "live XRP/USD mid18 is zero");
        assertLe(block.timestamp - ts, 60, "live feed is staler than MAX_ORACLE_AGE at fork time");
    }

    /// @notice A `MatchInstruction.priceUsd18` exactly at the live mid is, trivially, inside the
    /// +/-1% band — `lock()` must succeed against the REAL feed value.
    function test_Live_PriceAtMid_PassesBand_Locks() public {
        (uint256 mid18,, uint256 fee) = _liveMid();
        bytes32 matchId = keccak256("fork-ftso-band-inside");

        _lockAt(matchId, mid18, fee);

        (,,, DvPEscrow.MatchState state,,,,,,,) = escrow.matches(matchId);
        assertEq(uint8(state), uint8(DvPEscrow.MatchState.Locked), "lock() did not open the match");
    }

    /// @notice A price 2% above the live mid is outside the +/-1% (`BAND_BIPS = 100`) band —
    /// `lock()` must revert `PriceOutOfBand`, evaluated against the REAL live mid, not a mock.
    function test_Live_PriceTwoPercentAboveMid_RevertsPriceOutOfBand() public {
        (uint256 mid18,, uint256 fee) = _liveMid();
        uint256 offBandPrice = (mid18 * 10_200) / 10_000; // +2.00%, outside +/-1.00%
        bytes32 matchId = keccak256("fork-ftso-band-outside-above");

        fxrp.mint(taker, MIN_BLOCK);
        vm.startPrank(taker);
        fxrp.approve(address(escrow), MIN_BLOCK);
        escrow.deposit(MIN_BLOCK, uint64(block.timestamp + 3600));
        vm.stopPrank();

        fxrp.mint(maker, MIN_BLOCK / 100 + 1);
        vm.startPrank(maker);
        fxrp.approve(address(bondLedger), MIN_BLOCK / 100 + 1);
        bondLedger.depositBond(MIN_BLOCK / 100 + 1);
        vm.stopPrank();

        MatchInstructionLib.MatchInstruction memory mi = MatchInstructionLib.MatchInstruction({
            matchId: matchId,
            escrow: address(escrow),
            taker: taker,
            maker: maker,
            amountFxrp: MIN_BLOCK,
            priceUsd18: offBandPrice,
            takerXrplAddress: TAKER_XRPL_ADDR,
            instructionExpiresAt: uint64(block.timestamp + 300)
        });
        (bytes memory data, bytes memory sig) = _signMatch(mi);

        // Exact expected revert selector+args, derived from the SAME live mid read above, so this
        // is not a vacuous expectRevert() catching an unrelated failure.
        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.PriceOutOfBand.selector, offBandPrice, mid18));
        vm.prank(relayer);
        escrow.lock{value: fee}(data, sig);
    }

    /// @notice A price 2% below the live mid is likewise outside the band in the other direction.
    function test_Live_PriceTwoPercentBelowMid_RevertsPriceOutOfBand() public {
        (uint256 mid18,, uint256 fee) = _liveMid();
        uint256 offBandPrice = (mid18 * 9_800) / 10_000; // -2.00%
        bytes32 matchId = keccak256("fork-ftso-band-outside-below");

        fxrp.mint(taker, MIN_BLOCK);
        vm.startPrank(taker);
        fxrp.approve(address(escrow), MIN_BLOCK);
        escrow.deposit(MIN_BLOCK, uint64(block.timestamp + 3600));
        vm.stopPrank();

        fxrp.mint(maker, MIN_BLOCK / 100 + 1);
        vm.startPrank(maker);
        fxrp.approve(address(bondLedger), MIN_BLOCK / 100 + 1);
        bondLedger.depositBond(MIN_BLOCK / 100 + 1);
        vm.stopPrank();

        MatchInstructionLib.MatchInstruction memory mi = MatchInstructionLib.MatchInstruction({
            matchId: matchId,
            escrow: address(escrow),
            taker: taker,
            maker: maker,
            amountFxrp: MIN_BLOCK,
            priceUsd18: offBandPrice,
            takerXrplAddress: TAKER_XRPL_ADDR,
            instructionExpiresAt: uint64(block.timestamp + 300)
        });
        (bytes memory data, bytes memory sig) = _signMatch(mi);

        vm.expectRevert(abi.encodeWithSelector(DvPEscrow.PriceOutOfBand.selector, offBandPrice, mid18));
        vm.prank(relayer);
        escrow.lock{value: fee}(data, sig);
    }
}
