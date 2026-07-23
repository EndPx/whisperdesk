// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Script, console} from "forge-std/Script.sol";
import {DvPEscrow} from "../src/DvPEscrow.sol";
import {BondLedger} from "../src/BondLedger.sol";
import {MockFXRP} from "../src/mocks/MockFXRP.sol";
import {MockFtsoV2} from "../src/mocks/MockFtsoV2.sol";
import {MockFdcVerification} from "../src/mocks/MockFdcVerification.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {IBondLedger} from "../src/interfaces/IBondLedger.sol";
import {IFtsoV2} from "../src/interfaces/IFtsoV2.sol";
import {IFdcVerification} from "../src/interfaces/IFdcVerification.sol";

/// @notice Step 1 deployment to Coston2 — mock-backed (real FXRP/FTSOv2/FDC wiring is Step 5).
/// Deploy order (per BondLedger natspec): BondLedger -> DvPEscrow -> setEscrow.
/// teeSigner is a placeholder (DEV_ADDRESS); the real enclave signer is set at Step 3 via setTeeSigner.
contract Deploy is Script {
    // v1.1 policy windows (design.md §3.2)
    uint32 constant SETTLEMENT_WINDOW = 1800; // 30 min
    uint32 constant ATTESTATION_BUDGET = 360; // 6 min
    uint256 constant MIN_BLOCK_FXRP = 5_000e6; // canonical/mainnet minimum block size

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address dev = vm.addr(pk);

        vm.startBroadcast(pk);

        MockFXRP fxrp = new MockFXRP();
        MockFtsoV2 ftso = new MockFtsoV2();
        MockFdcVerification fdc = new MockFdcVerification();

        // Sensible defaults so the deployed system is immediately callable:
        ftso.setFeed(0.5e18, uint64(block.timestamp)); // XRP/USD ~ $0.50, fresh
        ftso.setFee(0); // Coston2 FTSOv2 fees are currently 0
        fdc.setResult(true);

        BondLedger bond = new BondLedger(IERC20(address(fxrp)));

        DvPEscrow escrow = new DvPEscrow(
            IERC20(address(fxrp)),
            IBondLedger(address(bond)),
            dev, // teeSigner placeholder (Step 3 replaces via setTeeSigner)
            IFtsoV2(address(ftso)),
            IFdcVerification(address(fdc)),
            bytes32("testXRP"),
            dev, // feeTreasury
            SETTLEMENT_WINDOW,
            ATTESTATION_BUDGET,
            MIN_BLOCK_FXRP
        );

        bond.setEscrow(address(escrow));

        vm.stopBroadcast();

        console.log("MockFXRP           ", address(fxrp));
        console.log("MockFtsoV2         ", address(ftso));
        console.log("MockFdcVerification", address(fdc));
        console.log("BondLedger         ", address(bond));
        console.log("DvPEscrow          ", address(escrow));
        console.log("teeSigner (placehldr)", dev);
    }
}
