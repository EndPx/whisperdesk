// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {IBondLedger} from "./interfaces/IBondLedger.sol";
import {ReentrancyGuardTransient} from "./utils/ReentrancyGuardTransient.sol";

/// @title BondLedger
/// @notice Maker bond in FXRP (design.md §3.9). Holds only maker bond FXRP — the TEE never holds
/// funds. Deploy order: BondLedger -> DvPEscrow -> `setEscrow` (one-shot).
contract BondLedger is IBondLedger, ReentrancyGuardTransient {
    IERC20 public immutable FXRP;
    address public owner;
    address public escrow; // one-shot setEscrow

    struct LockedBond {
        address maker;
        uint128 amount;
        bool active;
    }

    /// @notice Free (unlocked) bond balance per maker. Read by the engine as "availableBond".
    mapping(address maker => uint256) public freeBond;
    mapping(bytes32 matchId => LockedBond) public lockedBonds;

    event BondDeposited(address indexed maker, uint256 amount);
    event BondWithdrawn(address indexed maker, uint256 amount);
    event BondLocked(bytes32 indexed matchId, address indexed maker, uint256 amount);
    event BondReleased(bytes32 indexed matchId, address indexed maker, uint256 amount);
    event BondSlashed(bytes32 indexed matchId, address indexed maker, address indexed to, uint256 amount);

    error NotEscrow();
    error NotOwner();
    error EscrowAlreadySet();
    error InsufficientFreeBond(uint256 need, uint256 have);
    error BondNotActive(bytes32 matchId);
    error ZeroAddress();
    error TransferFailed();
    error AmountOverflow();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert NotEscrow();
        _;
    }

    constructor(IERC20 fxrp) {
        if (address(fxrp) == address(0)) revert ZeroAddress();
        FXRP = fxrp;
        owner = msg.sender;
    }

    /// @notice Deposits `amount` FXRP into the caller's free bond balance.
    function depositBond(uint256 amount) external nonReentrant {
        freeBond[msg.sender] += amount;
        _safeTransferFrom(msg.sender, address(this), amount);
        emit BondDeposited(msg.sender, amount);
    }

    /// @notice Withdraws `amount` from the caller's free (unlocked) bond balance only.
    function withdrawBond(uint256 amount) external nonReentrant {
        uint256 have = freeBond[msg.sender];
        if (amount > have) revert InsufficientFreeBond(amount, have);
        unchecked {
            freeBond[msg.sender] = have - amount;
        }
        _safeTransfer(msg.sender, amount);
        emit BondWithdrawn(msg.sender, amount);
    }

    /// @notice Reserves `amount` of `maker`'s free bond for `matchId`. Reverts atomically
    /// (nothing charged) if the maker's free bond is insufficient — closes concurrent-match
    /// overextension: an (N+1)-th lock across concurrently open matches reverts cleanly.
    function lockBond(bytes32 matchId, address maker, uint256 amount) external onlyEscrow {
        uint256 have = freeBond[maker];
        if (amount > have) revert InsufficientFreeBond(amount, have);
        if (amount > type(uint128).max) revert AmountOverflow();
        unchecked {
            freeBond[maker] = have - amount;
        }
        lockedBonds[matchId] = LockedBond({maker: maker, amount: uint128(amount), active: true});
        emit BondLocked(matchId, maker, amount);
    }

    /// @notice Returns a locked bond back to the maker's free balance (settlement success path).
    function releaseBond(bytes32 matchId) external onlyEscrow {
        LockedBond storage lb = lockedBonds[matchId];
        if (!lb.active) revert BondNotActive(matchId);
        lb.active = false;
        freeBond[lb.maker] += lb.amount;
        emit BondReleased(matchId, lb.maker, lb.amount);
    }

    /// @notice Transfers a locked bond directly to `to` (the honest taker) on default — 100% of
    /// the 1% bond, no oracle involvement. Funds are pre-escrowed so maker insolvency is impossible.
    function slashBond(bytes32 matchId, address to) external onlyEscrow {
        LockedBond storage lb = lockedBonds[matchId];
        if (!lb.active) revert BondNotActive(matchId);
        lb.active = false;
        uint256 amount = lb.amount;
        address maker = lb.maker;
        _safeTransfer(to, amount);
        emit BondSlashed(matchId, maker, to, amount);
    }

    /// @notice One-shot binding of the DvPEscrow instance authorized to call the onlyEscrow
    /// functions above.
    function setEscrow(address e) external onlyOwner {
        if (escrow != address(0)) revert EscrowAlreadySet();
        if (e == address(0)) revert ZeroAddress();
        escrow = e;
    }

    function _safeTransfer(address to, uint256 amount) private {
        if (!FXRP.transfer(to, amount)) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        if (!FXRP.transferFrom(from, to, amount)) revert TransferFailed();
    }
}
