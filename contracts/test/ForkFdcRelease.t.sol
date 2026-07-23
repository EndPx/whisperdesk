// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {WhisperDeskTestBase} from "./helpers/WhisperDeskTestBase.sol";
import {DvPEscrow} from "../src/DvPEscrow.sol";
import {BondLedger} from "../src/BondLedger.sol";
import {MockFXRP} from "../src/mocks/MockFXRP.sol";
import {MockFtsoV2} from "../src/mocks/MockFtsoV2.sol";
import {MockFdcVerification} from "../src/mocks/MockFdcVerification.sol";
import {IFdcVerification} from "../src/interfaces/IFdcVerification.sol";
import {IXRPPayment} from "../src/interfaces/IXRPPayment.sol";
import {MatchInstructionLib} from "../src/libraries/MatchInstructionLib.sol";

/// @notice Minimal local mirror of `FlareContractRegistry.getContractAddressByName` (design.md
/// §Step5/`network-tooling.md` §2) — the ONE address that is the same across every Flare network
/// and is safe to hardcode; everything else (FtsoV2, FdcVerification, ...) must be resolved through
/// it at runtime rather than hardcoded, because `.claude/context/flare-docs/fdc.md` §5 and
/// `fdc-request-fee.md` disagree on the literal `FdcVerification` address.
interface IFlareContractRegistry {
    function getContractAddressByName(string calldata _name) external view returns (address);
}

/// @title ForkFdcRelease
/// @notice Step 5 headline integration proof: DvPEscrow wired to the REAL Coston2 `FdcVerification`
/// (resolved via `FlareContractRegistry`, never hardcoded — network-tooling.md §2/§4 gotcha).
///
/// HONESTY BOUNDARY (read before trusting a green checkmark here):
/// The only real, previously-captured FDC proof available (`scripts/fdc-spike/fixtures/proof.json`,
/// captured live in Step 2 and confirmed there to make `FdcVerification.verifyXRPPayment` return
/// `true` onchain) has `requestBody.proofOwner == 0x470De46985939a7e09821a6e6a3ED1f415d50ED6` — the
/// Step-2 spike verifier contract's address, not any escrow this test can deploy. `release()`
/// mandatorily binds `proofOwner == address(this)` (design.md §3.7) BEFORE it ever calls
/// `fdcVerification.verifyXRPPayment`, so no escrow deployed inside this test (or any test) can ever
/// pass that fixture proof all the way through `release()` to a real fund transfer — that would
/// require a FRESH proof minted with `proofOwner` set to this test's escrow address, which is a
/// live, funded, multi-minute FDC round-trip outside what a `forge test` fork can do.
///
/// This file therefore proves the two halves SEPARATELY, both for real, and does not fake either:
///   1. `test_Live_RealFdcVerification_AcceptsCapturedFixtureProof` — calls the REAL Coston2
///      `FdcVerification.verifyXRPPayment` directly with the exact captured proof bytes and asserts
///      `true`. This is the live-infra half: the real verifier accepts a real, previously-attested
///      XRPL payment proof, right now, over the fork.
///   2. `test_Release_RevertsWrongProofOwner_ForFixtureProofBoundToDifferentEscrow` — deploys a
///      fresh DvPEscrow pointed at that same real verifier, opens a real Locked match, and calls
///      `release()` with the captured proof. It reverts `WrongProofOwner()` — proven for real, not
///      asserted by assumption — which is exactly the boundary above stated as onchain behavior.
///   3. `test_ReleaseFieldChecks_Succeed_WhenProofOwnerMatchesEscrow_MOCKVERIFIER` — proves
///      `release()`'s onchain field-decode/validation logic (status/tag/amount/addr-hash/window)
///      independently succeeds once `proofOwner` is correctly bound, using a `MockFdcVerification`
///      (verify=true) standing in for a proof that would need to be freshly minted for this exact
///      escrow address. This half is explicitly NOT proven against live infra — see the boundary
///      note on the test itself.
contract ForkFdcReleaseTest is WhisperDeskTestBase {
    address internal constant REGISTRY = 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019;

    address internal realFdcVerification;

    // -----------------------------------------------------------------------------------------
    // Fixture, hardcoded from scripts/fdc-spike/fixtures/proof.json (captured Step 2, confirmed
    // onchain-true against the REAL Coston2 FdcVerification at capture time). fs_permissions in
    // foundry.toml only grants read access to ./test/vectors, not scripts/fdc-spike/fixtures, so
    // the fixture is hardcoded here rather than vm.readFile'd — values transcribed verbatim,
    // byte-length-checked against the JSON (32/32/32/20/32/32/32 bytes respectively).
    // -----------------------------------------------------------------------------------------
    bytes32 internal constant FIXTURE_SOURCE_ID = bytes32("testXRP");
    bytes32 internal constant FIXTURE_TX_ID = 0x8b973ef7b688411836cd47ca7b86fbc50e47dd771b1e4ceb518609c002707274;
    address internal constant FIXTURE_PROOF_OWNER = 0x470De46985939a7e09821a6e6a3ED1f415d50ED6;
    bytes32 internal constant FIXTURE_SOURCE_ADDR_HASH =
        0x36d1074c3d27f1a9bd433863e46bfdfbf00879c1042bca8861979130265ec9ce;
    bytes32 internal constant FIXTURE_RECEIVING_ADDR_HASH =
        0xc3fdf597533b67ba54cb8a67a72d011d6a981bbc0fac0b8ed6fac011f8e2ddae;

    function setUp() public override {
        // Pin the fork BEFORE any local deployment so every subsequent call (including the
        // registry lookup) runs against real, live Coston2 state.
        vm.createSelectFork("coston2");

        teeSigner = vm.addr(teeSignerPk);

        address resolved = IFlareContractRegistry(REGISTRY).getContractAddressByName("FdcVerification");
        require(resolved != address(0), "registry: FdcVerification not resolved");
        realFdcVerification = resolved;

        vm.startPrank(owner);
        fxrp = new MockFXRP();
        bondLedger = new BondLedger(fxrp);
        ftso = new MockFtsoV2(); // band check is exercised in ForkFtsoBand.t.sol, not here
        // fdc's declared type is MockFdcVerification, but we point it at the REAL deployed
        // contract's address (same `verifyXRPPayment(IXRPPayment.Proof)` selector) so this fixture
        // base's helpers keep working while every fdc.* call in this file actually hits Coston2.
        fdc = MockFdcVerification(realFdcVerification);

        escrow = new DvPEscrow(
            fxrp,
            bondLedger,
            teeSigner,
            ftso,
            IFdcVerification(realFdcVerification),
            SOURCE_ID,
            feeTreasury,
            SETTLEMENT_WINDOW,
            ATTESTATION_BUDGET,
            MIN_BLOCK
        );
        bondLedger.setEscrow(address(escrow));
        vm.stopPrank();

        ftso.setFeed(ONE_USD18, uint64(block.timestamp));
        ftso.setFee(0);
    }

    function _fixtureProof() internal pure returns (IXRPPayment.Proof memory proof) {
        proof.merkleProof = new bytes32[](3);
        proof.merkleProof[0] = 0x665af88e2788c5e4fb5e325ce91c7df0b71f4f79f8ee30c8799be557055d0f8d;
        proof.merkleProof[1] = 0xaf9e6ee8ec3a7a56e32414d7376f35572fc18676629fe80691df800c63ced9de;
        proof.merkleProof[2] = 0x59574ebc53995c0492578cb540f2cf9988aa980a4e1d110439d99acd93cd6019;

        proof.data.attestationType = bytes32("XRPPayment");
        proof.data.sourceId = FIXTURE_SOURCE_ID;
        proof.data.votingRound = 1403531;
        proof.data.lowestUsedTimestamp = 1784747780;
        proof.data.requestBody.transactionId = FIXTURE_TX_ID;
        proof.data.requestBody.proofOwner = FIXTURE_PROOF_OWNER;

        proof.data.responseBody.blockNumber = 19282921;
        proof.data.responseBody.blockTimestamp = 1784747780;
        proof.data.responseBody.sourceAddress = "r4ndQ2Ro7DANzbcMnoidaCUhEa7gcLzxgm";
        proof.data.responseBody.sourceAddressHash = FIXTURE_SOURCE_ADDR_HASH;
        proof.data.responseBody.receivingAddressHash = FIXTURE_RECEIVING_ADDR_HASH;
        proof.data.responseBody.intendedReceivingAddressHash = FIXTURE_RECEIVING_ADDR_HASH;
        proof.data.responseBody.spentAmount = 1000012;
        proof.data.responseBody.intendedSpentAmount = 1000012;
        proof.data.responseBody.receivedAmount = 1000000;
        proof.data.responseBody.intendedReceivedAmount = 1000000;
        proof.data.responseBody.hasMemoData = false;
        proof.data.responseBody.firstMemoData = "";
        proof.data.responseBody.hasDestinationTag = true;
        proof.data.responseBody.destinationTag = 12345;
        proof.data.responseBody.status = 0;
    }

    /// @notice LIVE half: the real Coston2 `FdcVerification` accepts the captured proof bytes,
    /// right now, over the fork — no mock, no assumption.
    function test_Live_RealFdcVerification_AcceptsCapturedFixtureProof() public {
        IXRPPayment.Proof memory proof = _fixtureProof();
        bool ok = IFdcVerification(realFdcVerification).verifyXRPPayment(proof);
        assertTrue(ok, "real Coston2 FdcVerification rejected the captured fixture proof");

        // Sanity: the struct's own decoded fields match what design.md/DvPEscrow expect to see on
        // the success path, so a failure here can only be the proofOwner-binding boundary, not a
        // field-shape mismatch.
        assertEq(proof.data.attestationType, bytes32("XRPPayment"));
        assertEq(proof.data.sourceId, bytes32("testXRP"));
        assertEq(proof.data.responseBody.status, 0);
        assertEq(proof.data.responseBody.destinationTag, 12345);
        assertEq(proof.data.responseBody.receivedAmount, int256(1_000_000));
    }

    /// @notice Boundary half, proven for real: `release()` on a FRESH escrow (wired to the real
    /// verifier) rejects the captured proof at the `proofOwner` gate, before ever reaching
    /// `fdcVerification.verifyXRPPayment`. This is the exact, honest reason the fixture cannot
    /// fund a real release() end-to-end without a freshly-minted proof for this escrow's address.
    function test_Release_RevertsWrongProofOwner_ForFixtureProofBoundToDifferentEscrow() public {
        bytes32 matchId = keccak256("fork-fdc-release-wrong-owner");
        _lockDefaultMatch(matchId);

        IXRPPayment.Proof memory proof = _fixtureProof();
        assertTrue(proof.data.requestBody.proofOwner != address(escrow), "fixture unexpectedly owned by this escrow");

        vm.expectRevert(DvPEscrow.WrongProofOwner.selector);
        escrow.release(matchId, proof);
    }

    /// @notice NOT proven against live infra (see contract-level boundary note): with a
    /// `MockFdcVerification` standing in for "a proof freshly minted with proofOwner = this
    /// escrow", release()'s own onchain field-decode/validation logic (status, destination-tag,
    /// received-amount, address hash, payment window) is exercised end-to-end and succeeds,
    /// transferring FXRP to the maker. Combined with the two tests above, this closes the loop:
    /// (1) proves the real verifier accepts a real proof, (2) proves release() correctly rejects a
    /// real proof bound to someone else's escrow, (3) proves release()'s field logic is correct
    /// once ownership binds — the only missing link for a fully-live E2E is minting (1)'s proof
    /// with (3)'s ownership, which needs a live, funded, multi-minute FDC request/attest round
    /// trip outside a `forge test` fork's scope.
    function test_ReleaseFieldChecks_Succeed_WhenProofOwnerMatchesEscrow_MOCKVERIFIER() public {
        // Independent escrow + bondLedger pair (BondLedger.setEscrow is one-shot) using a
        // MockFdcVerification, deliberately NOT the real verifier resolved in setUp() — this test
        // is isolating release()'s field logic, not re-proving live verifier acceptance.
        vm.startPrank(owner);
        BondLedger localBondLedger = new BondLedger(fxrp);
        MockFdcVerification mockFdc = new MockFdcVerification();
        DvPEscrow localEscrow = new DvPEscrow(
            fxrp,
            localBondLedger,
            teeSigner,
            ftso,
            mockFdc,
            SOURCE_ID,
            feeTreasury,
            SETTLEMENT_WINDOW,
            ATTESTATION_BUDGET,
            MIN_BLOCK
        );
        localBondLedger.setEscrow(address(localEscrow));
        vm.stopPrank();

        bytes32 matchId = keccak256("fork-fdc-release-field-checks");
        fxrp.mint(taker, MIN_BLOCK);
        vm.startPrank(taker);
        fxrp.approve(address(localEscrow), MIN_BLOCK);
        localEscrow.deposit(MIN_BLOCK, uint64(block.timestamp + 3600));
        vm.stopPrank();

        fxrp.mint(maker, MIN_BLOCK / 100 + 1);
        vm.startPrank(maker);
        fxrp.approve(address(localBondLedger), MIN_BLOCK / 100 + 1);
        localBondLedger.depositBond(MIN_BLOCK / 100 + 1);
        vm.stopPrank();

        MatchInstructionLib.MatchInstruction memory mi = MatchInstructionLib.MatchInstruction({
            matchId: matchId,
            escrow: address(localEscrow),
            taker: taker,
            maker: maker,
            amountFxrp: MIN_BLOCK,
            priceUsd18: ONE_USD18,
            takerXrplAddress: TAKER_XRPL_ADDR,
            instructionExpiresAt: uint64(block.timestamp + 300)
        });
        bytes memory instructionData = abi.encode(mi);
        bytes32 dataHash = keccak256(instructionData);
        bytes32 digest = MatchInstructionLib.ethSignedDigest(dataHash, block.chainid);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(teeSignerPk, digest);
        if (uint256(s) > SECP256K1N_HALF) {
            s = bytes32(SECP256K1N - uint256(s));
            v = v == 27 ? 28 : 27;
        }
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(relayer);
        localEscrow.lock(instructionData, sig);

        (,uint32 destinationTag, uint40 lockedAt,,,,,, uint128 xrpDrops,, bytes32 addrHash) = _readEscrowMatch(localEscrow, matchId);

        IXRPPayment.Proof memory proof;
        proof.merkleProof = new bytes32[](0);
        proof.data.attestationType = ATTESTATION_TYPE;
        proof.data.sourceId = SOURCE_ID;
        proof.data.votingRound = 1;
        proof.data.lowestUsedTimestamp = lockedAt;
        proof.data.requestBody.transactionId = keccak256("field-check-txid");
        proof.data.requestBody.proofOwner = address(localEscrow); // the binding a real fresh proof would carry
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

        uint256 makerBalBefore = fxrp.balanceOf(maker);
        localEscrow.release(matchId, proof);

        assertEq(fxrp.balanceOf(maker), makerBalBefore + MIN_BLOCK, "maker did not receive FXRP on release()");
        (,,, DvPEscrow.MatchState state,,,,,,,) = _readEscrowMatch(localEscrow, matchId);
        assertEq(uint8(state), uint8(DvPEscrow.MatchState.Released), "match not marked Released");
    }

    function _readEscrowMatch(DvPEscrow e, bytes32 matchId)
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
        ) = e.matches(matchId);
    }
}
