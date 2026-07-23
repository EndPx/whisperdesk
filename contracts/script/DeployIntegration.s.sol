// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Script, console} from "forge-std/Script.sol";
import {DvPEscrow} from "../src/DvPEscrow.sol";
import {BondLedger} from "../src/BondLedger.sol";
import {MockFXRP} from "../src/mocks/MockFXRP.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {IBondLedger} from "../src/interfaces/IBondLedger.sol";
import {IFtsoV2} from "../src/interfaces/IFtsoV2.sol";
import {IFdcVerification} from "../src/interfaces/IFdcVerification.sol";

/// @notice Minimal local mirror of `FlareContractRegistry.getContractAddressByName`
/// (network-tooling.md §2) — identical interface/rationale to the one already proven live in
/// test/ForkFdcRelease.t.sol and test/ForkFtsoBand.t.sol. The registry address is the ONE address
/// that is the same across every Flare network and is safe to hardcode; everything it resolves
/// (FtsoV2, FdcVerification, ...) must NEVER be hardcoded (flare-docs/fdc.md + fdc-request-fee.md
/// disagree on the literal FdcVerification address — the registry is the only truth).
interface IFlareContractRegistry {
    function getContractAddressByName(string calldata _name) external view returns (address);
}

/// @title DeployIntegration
/// @notice Step 5 integration deploy (docs/design.md §12 Step 5): a fresh BondLedger + DvPEscrow
/// wired to the REAL Coston2 `FtsoV2` and `FdcVerification` (both resolved live via
/// `FlareContractRegistry`, 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019 — never hardcoded), backed
/// by a mintable `MockFXRP` (real FXRP is FAsset-minted, out of scope for a fast integration demo).
///
/// Two settings deliberately diverge from a canonical/mainnet deploy (`script/Deploy.s.sol` uses
/// the canonical values):
///   - `MIN_BLOCK_FXRP` is 1 FXRP (1e6, 6-dec raw) instead of the canonical 5,000 FXRP. Priced at
///     the live FTSOv2 XRP/USD mid, a 5,000-FXRP block requires ~5,000 XRP of counter-payment —
///     far beyond what a faucet-funded XRPL testnet account can move. At 1 FXRP, `xrpDrops` comes
///     out to roughly 1,000,000 drops (~1 XRP) at typical XRP/USD levels, matching the exact amount
///     `scripts/fdc-spike/config.mjs`'s `PAYMENT_DROPS` already proved end-to-end in Step 2.
///   - `SETTLEMENT_WINDOW`/`ATTESTATION_BUDGET` are short (minutes, not the canonical 30 min) so
///     `scripts/e2e/`'s default-path (refund) demo doesn't require a long wait. This is safe
///     because `release()` itself has no time gate — it stays callable any time the match is still
///     `Locked` (see `DvPEscrow.sol` `test_Release_StillCallable_AfterRefundAfterElapsed_...`) — so
///     shortening these windows does not risk failing the happy-path demo even if the live FDC
///     round-trip runs long; it only shortens how long an UNPAID match stays refundable-pending.
///
/// `teeSigner` is set to the SAME key that broadcasts this script (`PRIVATE_KEY`) — a key we fully
/// control end-to-end. Step 5's E2E does not depend on a live TEE enclave: `scripts/e2e/` signs
/// every `MatchInstruction` locally with this exact key (WD_MATCH_V1 scheme, design.md §3.5).
///
/// Run:
///   forge script script/DeployIntegration.s.sol --rpc-url coston2 --broadcast --slow
/// Env:
///   PRIVATE_KEY   deployer / teeSigner / relayer / FTSOv2-fee-payer (funded with C2FLR)
contract DeployIntegration is Script {
    address internal constant REGISTRY = 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019;

    // Short windows for a live demo — see the contract-level natspec above for why this is safe.
    // design.md §3.2 canonical values (script/Deploy.s.sol) are 1800 s / 360 s; these are
    // testnet/demo ONLY, mirroring the MIN_BLOCK_FXRP divergence above.
    uint32 public constant SETTLEMENT_WINDOW = 300; // 5 min: lock() -> refund()-eligible
    uint32 public constant ATTESTATION_BUDGET = 120; // 2 min reserved for the FDC round-trip
    uint32 public constant PAYMENT_WINDOW = SETTLEMENT_WINDOW - ATTESTATION_BUDGET; // 3 min to pay

    // 1 FXRP (6-dec raw). At the live FTSOv2 XRP/USD mid this derives an xrpDrops figure any
    // faucet-funded XRPL testnet account can pay (see contract-level natspec).
    uint256 public constant MIN_BLOCK_FXRP = 1e6;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address dev = vm.addr(pk);

        // Registry lookups are plain `view` reads (STATICCALL) — resolved BEFORE startBroadcast so
        // they never get recorded/sent as transactions, mirroring the fork tests' ordering.
        address ftsoV2 = IFlareContractRegistry(REGISTRY).getContractAddressByName("FtsoV2");
        address fdcVerification = IFlareContractRegistry(REGISTRY).getContractAddressByName("FdcVerification");
        require(ftsoV2 != address(0), "registry: FtsoV2 not resolved");
        require(fdcVerification != address(0), "registry: FdcVerification not resolved");

        vm.startBroadcast(pk);

        MockFXRP fxrp = new MockFXRP();
        BondLedger bond = new BondLedger(IERC20(address(fxrp)));

        DvPEscrow escrow = new DvPEscrow(
            IERC20(address(fxrp)),
            IBondLedger(address(bond)),
            dev, // teeSigner — deployer-controlled key; scripts/e2e/ signs with this same PRIVATE_KEY
            IFtsoV2(ftsoV2),
            IFdcVerification(fdcVerification),
            bytes32("testXRP"),
            dev, // feeTreasury
            SETTLEMENT_WINDOW,
            ATTESTATION_BUDGET,
            MIN_BLOCK_FXRP
        );

        bond.setEscrow(address(escrow));

        vm.stopBroadcast();

        console.log("=== DeployIntegration (Step 5) ===");
        console.log("Network              Coston2 (chainId 114)");
        console.log("Deployer/teeSigner  ", dev);
        console.log("MockFXRP            ", address(fxrp));
        console.log("BondLedger          ", address(bond));
        console.log("DvPEscrow           ", address(escrow));
        console.log("Real FtsoV2         ", ftsoV2);
        console.log("Real FdcVerification", fdcVerification);
        console.log("MIN_BLOCK_FXRP      ", MIN_BLOCK_FXRP);
        console.log("SETTLEMENT_WINDOW   ", uint256(SETTLEMENT_WINDOW));
        console.log("ATTESTATION_BUDGET  ", uint256(ATTESTATION_BUDGET));
        console.log("PAYMENT_WINDOW      ", uint256(PAYMENT_WINDOW));
        console.log("REFUND_GRACE        ", uint256(escrow.REFUND_GRACE()));
        console.log("");
        console.log("Next: scripts/e2e/ - set ESCROW_ADDRESS to the DvPEscrow address above, then:");
        console.log("  node happy-path.mjs    (pays the real XRPL leg, releases FXRP to the maker)");
        console.log("  node default-path.mjs  (no payment; waits out refundAfter+REFUND_GRACE, refunds the taker)");
    }
}
