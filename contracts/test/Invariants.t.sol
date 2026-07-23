// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {DvPEscrow} from "../src/DvPEscrow.sol";
import {BondLedger} from "../src/BondLedger.sol";
import {MockFXRP} from "../src/mocks/MockFXRP.sol";
import {MockFtsoV2} from "../src/mocks/MockFtsoV2.sol";
import {MockFdcVerification} from "../src/mocks/MockFdcVerification.sol";
import {IXRPPayment} from "../src/interfaces/IXRPPayment.sol";
import {MatchInstructionLib} from "../src/libraries/MatchInstructionLib.sol";

/// @notice Bounded-random handler driving deposit/withdraw/lock/release/refund across a fixed
/// small set of takers/makers, used by the invariant tests below (design.md §10: "I1 no release
/// without a true verifier result ... and matching proofOwner"; "I2' committed[taker] <=
/// armed[taker] always, and committed exactly equals the sum of amountFxrp over that taker's open
/// Locked matches").
contract Handler is Test {
    DvPEscrow public escrow;
    BondLedger public bondLedger;
    MockFXRP public fxrp;
    MockFtsoV2 public ftso;
    uint256 public teeSignerPk;

    address[] public takers;
    address[] public makers;
    bytes32[] public openMatchIds;
    mapping(bytes32 => bool) public isOpen;

    uint256 public constant MIN_BLOCK = 5_000e6;
    uint256 internal nonce;

    uint256 internal constant SECP256K1N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant SECP256K1N_HALF = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A;

    // ghost accounting, cross-checked against contract state in the invariant assertions
    mapping(address => uint256) public ghostCommittedSum; // sum of amountFxrp over that taker's open matches

    constructor(
        DvPEscrow _escrow,
        BondLedger _bondLedger,
        MockFXRP _fxrp,
        MockFtsoV2 _ftso,
        uint256 _teeSignerPk,
        address[] memory _takers,
        address[] memory _makers
    ) {
        escrow = _escrow;
        bondLedger = _bondLedger;
        fxrp = _fxrp;
        ftso = _ftso;
        teeSignerPk = _teeSignerPk;
        takers = _takers;
        makers = _makers;
    }

    function deposit(uint256 takerSeed, uint256 amountSeed, uint32 armedExtra) public {
        address t = takers[takerSeed % takers.length];
        uint256 amount = bound(amountSeed, 0, 50_000e6);
        if (amount == 0) return;
        fxrp.mint(t, amount);
        vm.startPrank(t);
        fxrp.approve(address(escrow), amount);
        escrow.deposit(amount, uint64(block.timestamp + 1 + (armedExtra % 5000)));
        vm.stopPrank();
    }

    function withdraw(uint256 takerSeed, uint256 amountSeed) public {
        address t = takers[takerSeed % takers.length];
        (uint128 armed, uint128 committed,) = escrow.balances(t);
        if (armed <= committed) return;
        uint256 available = uint256(armed) - uint256(committed);
        uint256 amount = bound(amountSeed, 0, available);
        if (amount == 0) return;
        vm.prank(t);
        // may revert WithdrawLocked if still armed — that's fine, the handler just no-ops on revert
        try escrow.withdraw(amount) {} catch {}
    }

    function lockMatch(uint256 takerSeed, uint256 makerSeed) public {
        address t = takers[takerSeed % takers.length];
        address m = makers[makerSeed % makers.length];
        if (t == m) return;

        (uint128 armed, uint128 committed,) = escrow.balances(t);
        uint256 available = uint256(armed) - uint256(committed);
        if (available < MIN_BLOCK) return;

        uint256 bondAmount = MIN_BLOCK / 100;
        if (bondLedger.freeBond(m) < bondAmount) {
            fxrp.mint(m, bondAmount);
            vm.startPrank(m);
            fxrp.approve(address(bondLedger), bondAmount);
            bondLedger.depositBond(bondAmount);
            vm.stopPrank();
        }

        bytes32 matchId = keccak256(abi.encode("match", nonce++));
        MatchInstructionLib.MatchInstruction memory mi = MatchInstructionLib.MatchInstruction({
            matchId: matchId,
            escrow: address(escrow),
            taker: t,
            maker: m,
            amountFxrp: MIN_BLOCK,
            priceUsd18: 1e18,
            takerXrplAddress: "rInvariantTestAddressXXXXXXXXXXXXX",
            instructionExpiresAt: uint64(block.timestamp + 300)
        });
        bytes memory data = abi.encode(mi);
        bytes32 digest = MatchInstructionLib.ethSignedDigest(keccak256(data), block.chainid);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(teeSignerPk, digest);
        if (uint256(s) > SECP256K1N_HALF) {
            s = bytes32(SECP256K1N - uint256(s));
            v = v == 27 ? 28 : 27;
        }

        try escrow.lock(data, abi.encodePacked(r, s, v)) {
            openMatchIds.push(matchId);
            isOpen[matchId] = true;
            ghostCommittedSum[t] += MIN_BLOCK;
        } catch {}
    }

    function releaseMatch(uint256 idxSeed) public {
        if (openMatchIds.length == 0) return;
        uint256 idx = idxSeed % openMatchIds.length;
        bytes32 matchId = openMatchIds[idx];
        if (!isOpen[matchId]) return;

        (
            address t,
            uint32 destinationTag,
            uint40 lockedAt,
            ,
            ,
            ,
            ,
            uint128 amountFxrp,
            uint128 xrpDrops,
            ,
            bytes32 addrHash
        ) = _readMatch(matchId);

        IXRPPayment.Proof memory proof;
        proof.merkleProof = new bytes32[](0);
        proof.data.attestationType = bytes32("XRPPayment");
        proof.data.sourceId = bytes32("testXRP");
        proof.data.requestBody.transactionId = keccak256(abi.encode("proof", matchId));
        proof.data.requestBody.proofOwner = address(escrow);
        proof.data.responseBody.blockTimestamp = lockedAt + 1;
        proof.data.responseBody.sourceAddress = "rX";
        proof.data.responseBody.receivingAddressHash = addrHash;
        proof.data.responseBody.hasDestinationTag = true;
        proof.data.responseBody.destinationTag = uint256(destinationTag);
        proof.data.responseBody.receivedAmount = int256(uint256(xrpDrops));
        proof.data.responseBody.status = 0;

        try escrow.release(matchId, proof) {
            isOpen[matchId] = false;
            ghostCommittedSum[t] -= amountFxrp;
        } catch {}
    }

    function refundMatch(uint256 idxSeed, uint32 warpSeed) public {
        if (openMatchIds.length == 0) return;
        uint256 idx = idxSeed % openMatchIds.length;
        bytes32 matchId = openMatchIds[idx];
        if (!isOpen[matchId]) return;

        (address t,,,,,, uint40 refundAfter, uint128 amountFxrp,,,) = _readMatch(matchId);
        // REFUND_GRACE (design.md §14): refund() only unlocks strictly after
        // refundAfter + escrow.REFUND_GRACE(), so the warp target must clear that too.
        uint256 earliestRefundable = uint256(refundAfter) + escrow.REFUND_GRACE();
        if (block.timestamp <= earliestRefundable) {
            vm.warp(earliestRefundable + 1 + (warpSeed % 100));
        }
        try escrow.refund(matchId) {
            isOpen[matchId] = false;
            ghostCommittedSum[t] -= amountFxrp;
        } catch {}
    }

    function takersList() external view returns (address[] memory) {
        return takers;
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

}

contract InvariantsTest is StdInvariant, Test {
    DvPEscrow internal escrow;
    BondLedger internal bondLedger;
    MockFXRP internal fxrp;
    MockFtsoV2 internal ftso;
    MockFdcVerification internal fdc;
    Handler internal handler;

    uint256 internal teeSignerPk = 0xA11CE5EED;

    function setUp() public {
        address teeSigner = vm.addr(teeSignerPk);
        address owner = makeAddr("owner");

        vm.startPrank(owner);
        fxrp = new MockFXRP();
        bondLedger = new BondLedger(fxrp);
        ftso = new MockFtsoV2();
        fdc = new MockFdcVerification();
        escrow = new DvPEscrow(
            fxrp, bondLedger, teeSigner, ftso, fdc, bytes32("testXRP"), makeAddr("feeTreasury"), 1800, 360, 5_000e6
        );
        bondLedger.setEscrow(address(escrow));
        vm.stopPrank();

        ftso.setFeed(1e18, uint64(block.timestamp));
        ftso.setFee(0);

        address[] memory takers = new address[](3);
        takers[0] = makeAddr("inv-taker-0");
        takers[1] = makeAddr("inv-taker-1");
        takers[2] = makeAddr("inv-taker-2");
        address[] memory makers = new address[](3);
        makers[0] = makeAddr("inv-maker-0");
        makers[1] = makeAddr("inv-maker-1");
        makers[2] = makeAddr("inv-maker-2");

        handler = new Handler(escrow, bondLedger, fxrp, ftso, teeSignerPk, takers, makers);

        targetContract(address(handler));
    }

    /// @notice I2': committed[taker] <= armed[taker] always (design.md §10).
    function invariant_CommittedNeverExceedsArmed() public view {
        address[] memory takers = handler.takersList();
        for (uint256 i = 0; i < takers.length; i++) {
            (uint128 armed, uint128 committed,) = escrow.balances(takers[i]);
            assertLe(committed, armed, "committed must never exceed armed");
        }
    }

    /// @notice I2' (second half): committed exactly equals the sum of amountFxrp over that
    /// taker's currently open Locked matches (tracked independently via the handler's ghost sum).
    function invariant_CommittedMatchesGhostSum() public view {
        address[] memory takers = handler.takersList();
        for (uint256 i = 0; i < takers.length; i++) {
            (, uint128 committed,) = escrow.balances(takers[i]);
            assertEq(uint256(committed), handler.ghostCommittedSum(takers[i]), "committed must equal ghost sum");
        }
    }

    /// @notice Escrow's own FXRP balance can never be less than the total currently committed
    /// (open Locked notionals) — funds backing an open match are always actually present.
    function invariant_EscrowBalanceCoversCommitted() public view {
        address[] memory takers = handler.takersList();
        uint256 totalCommitted;
        for (uint256 i = 0; i < takers.length; i++) {
            (, uint128 committed,) = escrow.balances(takers[i]);
            totalCommitted += committed;
        }
        assertGe(fxrp.balanceOf(address(escrow)), totalCommitted, "escrow balance must cover all open commitments");
    }

    /// @notice Escrow's FXRP balance can never be less than the sum of `armed` either — armed is
    /// meant to always be backed by real tokens actually sitting in the contract (the solvency fix
    /// applied in release()/refund(), see DvPEscrow.sol comments).
    function invariant_EscrowBalanceCoversArmed() public view {
        address[] memory takers = handler.takersList();
        uint256 totalArmed;
        for (uint256 i = 0; i < takers.length; i++) {
            (uint128 armed,,) = escrow.balances(takers[i]);
            totalArmed += armed;
        }
        assertGe(fxrp.balanceOf(address(escrow)), totalArmed, "escrow balance must cover all armed deposits");
    }
}
