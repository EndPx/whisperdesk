// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {WhisperDeskInstructionSender} from "../src/WhisperDeskInstructionSender.sol";
import {MockTeeExtensionRegistry} from "../src/mocks/MockTeeExtensionRegistry.sol";
import {MockTeeMachineRegistry} from "../src/mocks/MockTeeMachineRegistry.sol";
import {ITeeExtensionRegistry} from "../src/interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "../src/interfaces/ITeeMachineRegistry.sol";

/// @notice Covers WhisperDeskInstructionSender.submitRfq/triggerMatch against mocked
/// TeeExtensionRegistry/TeeMachineRegistry: the msg.sender-binding security property (design.md
/// §3.10/§5.3), the RFQ_MATCH raw-bytes32 payload, msg.value forwarding, and event fields.
contract WhisperDeskInstructionSenderTest is Test {
    uint256 internal constant EXTENSION_ID = 0x10001;

    WhisperDeskInstructionSender internal sender;
    MockTeeExtensionRegistry internal registry;
    MockTeeMachineRegistry internal teeMachines;

    address internal taker = makeAddr("taker");
    address internal otherCaller = makeAddr("otherCaller");
    address internal relayer = makeAddr("relayer");

    function setUp() public {
        registry = new MockTeeExtensionRegistry();
        teeMachines = new MockTeeMachineRegistry();
        sender = new WhisperDeskInstructionSender(registry, teeMachines);

        registry.registerExtension(EXTENSION_ID, address(sender));
        sender.setExtensionId();
    }

    // ---------------------------------------------------------------------------------------
    // constructor
    // ---------------------------------------------------------------------------------------

    function test_Constructor_RevertsZeroExtensionRegistry() public {
        vm.expectRevert(bytes("TeeExtensionRegistry cannot be zero address"));
        new WhisperDeskInstructionSender(ITeeExtensionRegistry(address(0)), teeMachines);
    }

    function test_Constructor_RevertsZeroMachineRegistry() public {
        vm.expectRevert(bytes("TeeMachineRegistry cannot be zero address"));
        new WhisperDeskInstructionSender(registry, ITeeMachineRegistry(address(0)));
    }

    function test_SubmitRfq_RevertsExtensionIdNotSet() public {
        WhisperDeskInstructionSender fresh = new WhisperDeskInstructionSender(registry, teeMachines);
        vm.expectRevert(bytes("Extension ID is not set."));
        fresh.submitRfq(bytes("ciphertext"));
    }

    // ---------------------------------------------------------------------------------------
    // submitRfq — the msg.sender-binding property is the whole point
    // ---------------------------------------------------------------------------------------

    function test_SubmitRfq_EncodesMessageAsSenderAndCiphertext() public {
        bytes memory ciphertext = bytes("sealed-rfq-blob");

        vm.prank(taker);
        sender.submitRfq(ciphertext);

        bytes memory message = registry.lastMessage();
        (address decodedSender, bytes memory decodedCiphertext) = abi.decode(message, (address, bytes));

        assertEq(decodedSender, taker, "decoded sender must equal the actual caller");
        assertEq(decodedCiphertext, ciphertext, "ciphertext must round-trip unmodified");
    }

    function test_SubmitRfq_DifferentCallerYieldsDifferentEncodedSender() public {
        bytes memory ciphertext = bytes("sealed-rfq-blob");

        vm.prank(taker);
        sender.submitRfq(ciphertext);
        (address senderA,) = abi.decode(registry.lastMessage(), (address, bytes));

        vm.prank(otherCaller);
        sender.submitRfq(ciphertext);
        (address senderB,) = abi.decode(registry.lastMessage(), (address, bytes));

        assertEq(senderA, taker);
        assertEq(senderB, otherCaller);
        assertTrue(senderA != senderB, "a spoofed caller cannot reproduce another caller's binding");
    }

    function test_SubmitRfq_SetsOpTypeAndOpCommand() public {
        vm.prank(taker);
        sender.submitRfq(bytes("x"));

        assertEq(registry.lastOpType(), bytes32("WD_RFQ"));
        assertEq(registry.lastOpCommand(), bytes32("RFQ_SUBMIT"));
    }

    function test_SubmitRfq_ForwardsMsgValue() public {
        vm.deal(taker, 1 ether);
        vm.prank(taker);
        sender.submitRfq{value: 0.25 ether}(bytes("x"));

        assertEq(registry.lastValue(), 0.25 ether);
    }

    function test_SubmitRfq_SetsClaimBackAddressToCaller() public {
        vm.prank(taker);
        sender.submitRfq(bytes("x"));

        assertEq(registry.lastClaimBackAddress(), taker);
    }

    function test_SubmitRfq_UsesEmptyCosignersAndZeroThreshold() public {
        vm.prank(taker);
        sender.submitRfq(bytes("x"));

        assertEq(registry.lastCosigners().length, 0);
        assertEq(registry.lastCosignersThreshold(), 0);
    }

    function test_SubmitRfq_RequestsOneTeeIdForThisExtension() public {
        address[] memory customTeeIds = new address[](1);
        customTeeIds[0] = makeAddr("teeMachine");
        teeMachines.setTeeIds(customTeeIds);

        vm.prank(taker);
        sender.submitRfq(bytes("x"));

        address[] memory got = registry.lastTeeIds();
        assertEq(got.length, 1);
        assertEq(got[0], customTeeIds[0]);
    }

    function test_SubmitRfq_ReturnsInstructionIdAndEmitsEvent() public {
        vm.expectEmit(false, true, false, false, address(sender));
        emit WhisperDeskInstructionSender.SealedRfqSubmitted(bytes32(0), taker);

        vm.prank(taker);
        bytes32 instructionId = sender.submitRfq(bytes("x"));

        assertTrue(instructionId != bytes32(0));
    }

    // ---------------------------------------------------------------------------------------
    // triggerMatch — permissionless, raw bytes32 rfqId payload
    // ---------------------------------------------------------------------------------------

    function test_TriggerMatch_PayloadDecodesToRfqId() public {
        bytes32 rfqId = keccak256("some-rfq-instruction-id");

        vm.prank(relayer);
        sender.triggerMatch(rfqId);

        bytes memory message = registry.lastMessage();
        // abi.encode of a single static bytes32 is byte-identical to the raw 32 bytes — this is
        // exactly what fcewire/handler.go's decodeRfqID relies on (its `len(data) == 32` fast path).
        assertEq(message.length, 32);
        assertEq(bytes32(message), rfqId);

        bytes32 decoded = abi.decode(message, (bytes32));
        assertEq(decoded, rfqId);
    }

    function test_TriggerMatch_IsPermissionless() public {
        bytes32 rfqId = keccak256("rfq-1");

        // Any caller, not just the original taker, can trigger matching — no auth check reverts.
        vm.prank(otherCaller);
        bytes32 instructionId = sender.triggerMatch(rfqId);
        assertTrue(instructionId != bytes32(0));
    }

    function test_TriggerMatch_SetsOpTypeAndOpCommand() public {
        vm.prank(relayer);
        sender.triggerMatch(keccak256("rfq-1"));

        assertEq(registry.lastOpType(), bytes32("WD_RFQ"));
        assertEq(registry.lastOpCommand(), bytes32("RFQ_MATCH"));
    }

    function test_TriggerMatch_ForwardsMsgValue() public {
        vm.deal(relayer, 1 ether);
        vm.prank(relayer);
        sender.triggerMatch{value: 0.1 ether}(keccak256("rfq-1"));

        assertEq(registry.lastValue(), 0.1 ether);
    }

    function test_TriggerMatch_ReturnsInstructionIdAndEmitsEvent() public {
        bytes32 rfqId = keccak256("rfq-1");

        vm.expectEmit(false, true, true, false, address(sender));
        emit WhisperDeskInstructionSender.MatchTriggered(bytes32(0), rfqId, relayer);

        vm.prank(relayer);
        bytes32 instructionId = sender.triggerMatch(rfqId);

        assertTrue(instructionId != bytes32(0));
    }

    function test_TriggerMatch_RevertsExtensionIdNotSet() public {
        WhisperDeskInstructionSender fresh = new WhisperDeskInstructionSender(registry, teeMachines);
        vm.expectRevert(bytes("Extension ID is not set."));
        fresh.triggerMatch(keccak256("rfq-1"));
    }
}
