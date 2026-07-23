// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {IBondLedger} from "./interfaces/IBondLedger.sol";
import {IFtsoV2} from "./interfaces/IFtsoV2.sol";
import {IFdcVerification} from "./interfaces/IFdcVerification.sol";
import {IXRPPayment} from "./interfaces/IXRPPayment.sol";
import {MatchInstructionLib} from "./libraries/MatchInstructionLib.sol";
import {ReentrancyGuardTransient} from "./utils/ReentrancyGuardTransient.sol";

/// @title DvPEscrow
/// @notice Cross-chain delivery-vs-payment escrow for WhisperDesk (design.md §3.3-§3.8). Holds only
/// taker FXRP; `BondLedger` holds only maker bond FXRP; the TEE never holds funds. Releases FXRP to
/// a maker only against an FDC `XRPPayment` proof bound to this exact escrow instance; refunds the
/// taker (+ slashes the maker's bond to the taker) if no valid proof lands before the deadline.
///
/// Step 1 note (design.md §12 Step 1 / task sub-task (e)): `ftsoV2` and `fdcVerification` are
/// injected via the constructor (mock addresses in tests). TODO(Step 5): resolve both — plus FXRP —
/// via `FlareContractRegistry` (0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019) in the deploy script and
/// wire `syncFromRegistry()` to actually re-read them; never hardcode a `FdcVerification` address
/// (flare-docs/fdc.md and flare-docs/fdc-request-fee.md disagree on it).
contract DvPEscrow is ReentrancyGuardTransient {
    // ---------------------------------------------------------------------
    // Policy constants & window parameters (design.md §3.2)
    // ---------------------------------------------------------------------

    uint16 public constant BAND_BIPS = 100; // +/-1.0% vs FTSOv2 XRP/USD mid (inclusive)
    uint16 public constant BOND_BIPS = 100; // maker bond = 1% of notional
    uint32 public constant MAX_ORACLE_AGE = 60; // FTSOv2 staleness bound, seconds
    uint16 public constant TAKER_FEE_BIPS = 0; // v1: zero; 5 bps slot wired (one-constant change)

    // Windows are immutable constructor params (design.md §3.2) — enables a short-window
    // test/staging instance without redeploying the canonical instance's policy.
    uint32 public immutable SETTLEMENT_WINDOW; // canonical deploy: 1800 s
    uint32 public immutable ATTESTATION_BUDGET; // canonical deploy: 360 s
    uint32 public immutable PAYMENT_WINDOW; // = SETTLEMENT_WINDOW - ATTESTATION_BUDGET

    /// @notice Minimum FXRP notional a single match may lock, priced at the FTSOv2 mid inside
    /// lock() (design.md §3.2). Step 5: promoted from a hardcoded `constant` to a constructor-set
    /// `immutable` so a testnet/demo deploy can use a small block size — at the canonical 5,000
    /// FXRP mainnet value, priced at the live XRP/USD mid, a single block requires ~5,000 XRP of
    /// counter-payment, which is far beyond what small testnet-funded XRPL accounts can move.
    /// Canonical/mainnet deploys MUST pass 5_000e6 here; smaller values (e.g. 1e6 = 1 FXRP) are for
    /// testnet/demo integration deploys ONLY (see script/DeployIntegration.s.sol).
    uint256 public immutable MIN_BLOCK_FXRP;

    /// @notice Grace period (seconds) added on top of `refundAfter` before `refund()` becomes
    /// callable (design.md §14 "Refund/release race, narrowed not eliminated"). An honest maker's
    /// XRPL payment can be broadcast right up to `paymentDeadline` (inside `PAYMENT_WINDOW`) and
    /// still need up to `ATTESTATION_BUDGET` seconds for the FDC proof to land and for `release()`
    /// to be called; without a grace window a dishonest taker could call `refund()` the instant
    /// `refundAfter` is crossed and win the race against a fully honest, on-time relayer. Widening
    /// the required margin between `refundAfter` and the earliest possible `refund()` call narrows
    /// (does not eliminate — see design.md §14 item 1) that race.
    uint32 public immutable REFUND_GRACE = 120;

    // ---------------------------------------------------------------------
    // Immutables / config (design.md §3.3)
    // ---------------------------------------------------------------------

    IERC20 public immutable FXRP;
    IBondLedger public immutable BOND_LEDGER;
    bytes32 public immutable EXPECTED_SOURCE_ID; // bytes32("testXRP") right-padded on Coston2

    bytes32 public constant EXPECTED_ATTESTATION_TYPE = bytes32("XRPPayment");
    bytes21 public constant XRP_USD_FEED_ID = 0x015852502f55534400000000000000000000000000;
    bytes32 public constant WD_MATCH_TAG = MatchInstructionLib.WD_MATCH_TAG;

    // secp256k1 order / 2 — low-S canonicality bound (matches node signature canonicality).
    uint256 private constant SECP256K1N_HALF =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    address public owner;
    address public teeSigner; // settable — TEE key regenerates on every boot
    IFtsoV2 public ftsoV2; // "synced" from ContractRegistry (Step 5)
    IFdcVerification public fdcVerification; // "synced" from ContractRegistry (Step 5)
    address public feeTreasury;
    bool public lockPaused; // gates lock() ONLY — release/refund/withdraw never pausable

    // ---------------------------------------------------------------------
    // Taker deposits — armed-balance model with an explicit committed-exposure counter
    // (design.md §3.3, mandatory sub-task (a)). `committed` is independent of `armedUntil`: it is
    // incremented only in lock() and decremented only in release() or refund() — never by the
    // passage of time — so funds backing an open match can never be withdrawn regardless of how
    // far the arming clock has run out.
    // ---------------------------------------------------------------------

    struct TakerBalance {
        uint128 armed;
        uint128 committed;
        uint64 armedUntil;
    }

    mapping(address => TakerBalance) public balances;

    enum MatchState {
        None,
        Locked,
        Released,
        Refunded
    }

    struct Match {
        address taker;
        uint32 destinationTag;
        uint40 lockedAt;
        MatchState state;
        address maker;
        uint40 paymentDeadline;
        uint40 refundAfter;
        uint128 amountFxrp;
        uint128 xrpDrops;
        uint128 bondAmount;
        bytes32 takerXrplAddressHash;
    }

    mapping(bytes32 matchId => Match) public matches;
    uint32 public nextDestinationTag = 1; // fresh per match, assigned at lock — replay anchor

    /// @notice Consumed-FDC-transaction-id mapping (mandatory sub-task (b)): once an XRPL
    /// transactionId has funded a `release()`, it can never fund another — independent of, and in
    /// addition to, the `proofOwner` binding and the one-shot `Locked -> Released` state machine.
    mapping(bytes32 txId => bool) public usedTxId;

    // ---------------------------------------------------------------------
    // Events (design.md §3.4)
    // ---------------------------------------------------------------------

    event Deposited(address indexed taker, uint256 amount, uint64 armedUntil);
    event Withdrawn(address indexed taker, uint256 amount);
    event MatchLocked(
        bytes32 indexed matchId,
        address indexed taker,
        address indexed maker,
        uint256 amountFxrp,
        uint256 xrpDrops,
        uint32 destinationTag,
        string takerXrplAddress,
        uint64 paymentDeadline,
        uint64 refundAfter,
        uint256 priceUsd18,
        uint256 oracleMid18
    );
    event MatchReleased(bytes32 indexed matchId, address indexed maker, uint256 amountFxrp, bytes32 xrplTxId);
    event MatchRefunded(bytes32 indexed matchId, address indexed taker, uint256 amountFxrp, uint256 bondSlashed);
    event TeeSignerUpdated(address indexed oldSigner, address indexed newSigner);

    // ---------------------------------------------------------------------
    // Errors (design.md §3.4, canonical list)
    // ---------------------------------------------------------------------

    error ResultNotSuccess(uint8 status);
    error BadSignatureLength(uint256 len);
    error MalleableSignature();
    error InvalidTeeSignature(address recovered);
    error WrongEscrow(address expected);
    error MatchExists(bytes32 matchId);
    error InstructionExpired(uint64 expiresAt);
    error BelowMinBlock(uint256 amount);
    error SelfMatch();
    error EmptyXrplAddress();
    error FeeTooLow(uint256 need, uint256 got);
    error OracleZero();
    error StaleOracle(uint64 ts);
    error PriceOutOfBand(uint256 price, uint256 mid);
    error InsufficientArmedBalance(uint256 need, uint256 have);
    error DepositNotArmed();
    error WithdrawLocked(uint64 armedUntil);
    error ExceedsUncommitted(uint256 requested, uint256 available);
    error NotLocked(bytes32 matchId);
    error ProofInvalid();
    error WrongSource();
    error PaymentFailedStatus(uint8 status);
    error WrongDestination();
    error WrongDestinationTag();
    error AmountTooLow(int256 got, uint256 need);
    error PaymentBeforeLock();
    error PaymentOutsideWindow();
    error RefundTooEarly(uint64 refundAfter);
    error LockIsPaused();
    error NotOwner();
    error ZeroAddress();
    error WrongProofOwner(); // release() proof-owner binding (§3.7)

    // implementation-level errors not enumerated in design.md's canonical list, kept distinct from
    // it so the mandatory error set above stays exactly as specified.
    error InvalidWindowConfig();
    error AmountOverflow();
    error TransferFailed();
    error NativeTransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param fxrp taker-side settlement token (FXRP, 6 decimals on Coston2)
    /// @param bondLedger the BondLedger instance holding maker bonds
    /// @param teeSigner_ initial TEE identity address; reverts ZeroAddress() on address(0)
    /// @param ftsoV2_ FtsoV2 price-feed reader (mock in Step 1, registry-resolved in Step 5)
    /// @param fdcVerification_ FDC XRPPayment verifier (mock in Step 1, registry-resolved in Step 5)
    /// @param expectedSourceId bytes32("testXRP") right-padded, pinned per-deploy (never hardcoded)
    /// @param feeTreasury_ address any future protocol fee accrues to (unused while TAKER_FEE_BIPS == 0)
    /// @param settlementWindow_ seconds from lock() to refund()-eligibility (canonical: 1800)
    /// @param attestationBudget_ seconds reserved at the tail of the settlement window for FDC
    /// proof round-trip; PAYMENT_WINDOW = settlementWindow_ - attestationBudget_ (canonical: 360)
    /// @param minBlockFxrp_ minimum FXRP notional per match, raw 6-dec (canonical/mainnet: 5_000e6;
    /// testnet/demo deploys should pass a much smaller value — see MIN_BLOCK_FXRP natspec above)
    constructor(
        IERC20 fxrp,
        IBondLedger bondLedger,
        address teeSigner_,
        IFtsoV2 ftsoV2_,
        IFdcVerification fdcVerification_,
        bytes32 expectedSourceId,
        address feeTreasury_,
        uint32 settlementWindow_,
        uint32 attestationBudget_,
        uint256 minBlockFxrp_
    ) {
        if (teeSigner_ == address(0)) revert ZeroAddress();
        if (address(fxrp) == address(0)) revert ZeroAddress();
        if (address(bondLedger) == address(0)) revert ZeroAddress();
        if (address(ftsoV2_) == address(0)) revert ZeroAddress();
        if (address(fdcVerification_) == address(0)) revert ZeroAddress();
        if (attestationBudget_ >= settlementWindow_) revert InvalidWindowConfig();

        FXRP = fxrp;
        BOND_LEDGER = bondLedger;
        teeSigner = teeSigner_;
        ftsoV2 = ftsoV2_;
        fdcVerification = fdcVerification_;
        EXPECTED_SOURCE_ID = expectedSourceId;
        feeTreasury = feeTreasury_;
        owner = msg.sender;

        SETTLEMENT_WINDOW = settlementWindow_;
        ATTESTATION_BUDGET = attestationBudget_;
        PAYMENT_WINDOW = settlementWindow_ - attestationBudget_;
        MIN_BLOCK_FXRP = minBlockFxrp_;
    }

    // =========================================================================================
    // Taker funds
    // =========================================================================================

    /// @notice Deposits `amount` FXRP and extends the caller's `armedUntil` monotonically.
    function deposit(uint256 amount, uint64 armedUntil) external nonReentrant {
        TakerBalance storage bal = balances[msg.sender];
        uint256 newArmed = uint256(bal.armed) + amount;
        if (newArmed > type(uint128).max) revert AmountOverflow();
        bal.armed = uint128(newArmed);
        if (armedUntil > bal.armedUntil) {
            bal.armedUntil = armedUntil;
        }
        if (!FXRP.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Deposited(msg.sender, amount, bal.armedUntil);
    }

    /// @notice Withdraws `amount` of the caller's uncommitted, unarmed FXRP.
    /// @dev Requires BOTH, independently (mandatory sub-task (a)):
    ///   - block.timestamp > armedUntil                 (else WithdrawLocked)
    ///   - amount <= armed - committed                  (else ExceedsUncommitted)
    /// The time gate alone is not sufficient — funds backing any open Locked match are excluded
    /// from what withdraw() can ever move, no matter how long armedUntil has run out.
    function withdraw(uint256 amount) external nonReentrant {
        TakerBalance storage bal = balances[msg.sender];
        if (block.timestamp <= bal.armedUntil) revert WithdrawLocked(bal.armedUntil);
        uint256 available = uint256(bal.armed) - uint256(bal.committed);
        if (amount > available) revert ExceedsUncommitted(amount, available);
        bal.armed = uint128(uint256(bal.armed) - amount);
        if (!FXRP.transfer(msg.sender, amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // =========================================================================================
    // Settlement lifecycle — ALL permissionless (authority = signatures/proofs, never the caller)
    // =========================================================================================

    /// @notice Verifies a TEE-signed `MatchInstruction`, re-checks the +/-1% FTSOv2 band live,
    /// derives `xrpDrops` onchain, reserves taker FXRP + maker bond, and opens the match.
    /// @dev payable: forwards the FTSOv2 fee; refunds any msg.value surplus over the fee to
    /// msg.sender, performed LAST after all state writes (design.md §3.6 step 8).
    function lock(bytes calldata instructionData, bytes calldata teeSignature)
        external
        payable
        nonReentrant
        returns (bytes32 matchId)
    {
        if (lockPaused) revert LockIsPaused();

        MatchInstructionLib.MatchInstruction memory mi = MatchInstructionLib.decode(instructionData);
        if (mi.escrow != address(this)) revert WrongEscrow(address(this));

        // --- WD_MATCH_V1 signature verification (design.md §3.5) ---------------------------
        if (teeSignature.length != 65) revert BadSignatureLength(teeSignature.length);
        (bytes32 r, bytes32 s, uint8 v) = _splitSignature(teeSignature);
        if (uint256(s) > SECP256K1N_HALF) revert MalleableSignature();

        bytes32 dHash = MatchInstructionLib.dataHash(instructionData);
        bytes32 digest = MatchInstructionLib.ethSignedDigest(dHash, block.chainid);

        address recovered = ecrecover(digest, v, r, s);
        // Zero-address-recovered reject BEFORE comparing to teeSigner (mandatory sub-task (c)):
        // a malformed/adversarial 65-byte signature can cause ecrecover to return address(0)
        // rather than reverting; if teeSigner were ever left at address(0) this would forge an
        // arbitrary match with zero cryptographic authentication.
        if (recovered == address(0)) revert InvalidTeeSignature(recovered);
        if (recovered != teeSigner) revert InvalidTeeSignature(recovered);

        // --- structural checks ---------------------------------------------------------------
        if (matches[mi.matchId].state != MatchState.None) revert MatchExists(mi.matchId);
        if (block.timestamp > mi.instructionExpiresAt) revert InstructionExpired(mi.instructionExpiresAt);
        if (mi.taker == mi.maker) revert SelfMatch();
        if (mi.amountFxrp < MIN_BLOCK_FXRP) revert BelowMinBlock(mi.amountFxrp);
        if (bytes(mi.takerXrplAddress).length == 0) revert EmptyXrplAddress();

        // --- FTSOv2 +/-1% band re-check (wei variant — decimals fixed at 18) -----------------
        uint256 fee = ftsoV2.calculateFeeById(XRP_USD_FEED_ID);
        if (msg.value < fee) revert FeeTooLow(fee, msg.value);
        (uint256 mid18, uint64 ts) = ftsoV2.getFeedByIdInWei{value: fee}(XRP_USD_FEED_ID);
        if (mid18 == 0) revert OracleZero();
        if (ts > block.timestamp || block.timestamp - ts > MAX_ORACLE_AGE) revert StaleOracle(ts);
        if (
            mi.priceUsd18 * 10_000 < mid18 * (10_000 - BAND_BIPS)
                || mi.priceUsd18 * 10_000 > mid18 * (10_000 + BAND_BIPS)
        ) {
            revert PriceOutOfBand(mi.priceUsd18, mid18);
        }

        // --- drops derivation — the oracle is load-bearing, the TEE never signs a drops figure
        uint256 dropsWide = (mi.amountFxrp * mi.priceUsd18) / mid18;
        if (dropsWide > type(uint128).max) revert AmountOverflow();
        uint128 xrpDrops = uint128(dropsWide);

        // --- reserve taker funds: armed-balance check AND committed-exposure increment --------
        TakerBalance storage bal = balances[mi.taker];
        uint256 takerFee = (mi.amountFxrp * TAKER_FEE_BIPS) / 10_000;
        uint256 need = mi.amountFxrp + takerFee;
        if (bal.armedUntil < block.timestamp) revert InsufficientArmedBalance(need, 0);
        uint256 available = uint256(bal.armed) - uint256(bal.committed);
        if (available < need) revert InsufficientArmedBalance(need, available);
        uint256 newCommitted = uint256(bal.committed) + mi.amountFxrp;
        if (newCommitted > type(uint128).max) revert AmountOverflow();
        bal.committed = uint128(newCommitted);

        // --- reserve maker bond -----------------------------------------------------------------
        uint256 bondAmountWide = (mi.amountFxrp * BOND_BIPS) / 10_000;
        if (bondAmountWide > type(uint128).max) revert AmountOverflow();
        uint128 bondAmount = uint128(bondAmountWide);
        BOND_LEDGER.lockBond(mi.matchId, mi.maker, bondAmount);

        // --- write match & emit ------------------------------------------------------------------
        matchId = mi.matchId;
        uint32 destinationTag = nextDestinationTag++;
        uint40 lockedAt = uint40(block.timestamp);
        uint40 paymentDeadline = uint40(block.timestamp + PAYMENT_WINDOW);
        uint40 refundAfter = uint40(block.timestamp + SETTLEMENT_WINDOW);

        matches[matchId] = Match({
            taker: mi.taker,
            destinationTag: destinationTag,
            lockedAt: lockedAt,
            state: MatchState.Locked,
            maker: mi.maker,
            paymentDeadline: paymentDeadline,
            refundAfter: refundAfter,
            amountFxrp: uint128(mi.amountFxrp),
            xrpDrops: xrpDrops,
            bondAmount: bondAmount,
            takerXrplAddressHash: keccak256(bytes(mi.takerXrplAddress))
        });

        emit MatchLocked(
            matchId,
            mi.taker,
            mi.maker,
            mi.amountFxrp,
            xrpDrops,
            destinationTag,
            mi.takerXrplAddress,
            paymentDeadline,
            refundAfter,
            mi.priceUsd18,
            mid18
        );

        // --- surplus msg.value refund, performed LAST (design.md §3.6 step 8) -------------------
        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert NativeTransferFailed();
        }
    }

    /// @notice Releases FXRP to the maker against a verified FDC `XRPPayment` proof.
    function release(bytes32 matchId, IXRPPayment.Proof calldata proof) external nonReentrant {
        Match storage m = matches[matchId];
        if (m.state != MatchState.Locked) revert NotLocked(matchId);

        // Mandatory proof-owner binding, checked BEFORE any other proof content (mandatory
        // sub-task (b) / design.md §3.7): closes a cross-instance/cross-match proof-reuse path.
        if (proof.data.requestBody.proofOwner != address(this)) revert WrongProofOwner();

        bytes32 txId = proof.data.requestBody.transactionId;
        if (usedTxId[txId]) revert ProofInvalid();

        if (!fdcVerification.verifyXRPPayment(proof)) revert ProofInvalid();
        if (
            proof.data.attestationType != EXPECTED_ATTESTATION_TYPE
                || proof.data.sourceId != EXPECTED_SOURCE_ID
        ) {
            revert WrongSource();
        }

        IXRPPayment.ResponseBody memory r = proof.data.responseBody;
        // MUST come first: receivingAddressHash is ZEROED when status != 0 (status 2 covers
        // tecDST_TAG_NEEDED / tecNO_DST).
        if (r.status != 0) revert PaymentFailedStatus(r.status);
        if (r.receivingAddressHash != m.takerXrplAddressHash) revert WrongDestination();
        if (!r.hasDestinationTag || r.destinationTag != uint256(m.destinationTag)) revert WrongDestinationTag();
        if (r.receivedAmount <= 0 || uint256(r.receivedAmount) < m.xrpDrops) {
            revert AmountTooLow(r.receivedAmount, m.xrpDrops);
        }
        if (r.blockTimestamp < m.lockedAt) revert PaymentBeforeLock();
        if (r.blockTimestamp > m.paymentDeadline) revert PaymentOutsideWindow();

        m.state = MatchState.Released;
        usedTxId[txId] = true;
        // NOTE (implementation fix beyond design.md's literal §3.7 snippet): `armed` is
        // decremented here alongside `committed`. The design.md snippet only decrements
        // `committed`, but `amountFxrp` physically leaves the contract to the maker on this line
        // — leaving `armed` unchanged would let `available = armed - committed` silently grow
        // back to the pre-lock level with no new deposit, i.e. phantom capacity backed by no real
        // token balance (a solvency gap violating the design's own §10 invariant "escrow balance
        // = Σ open"). Decrementing both keeps `armed` an accurate live measure of this taker's
        // FXRP actually held by the contract.
        TakerBalance storage bal = balances[m.taker];
        bal.committed -= m.amountFxrp;
        bal.armed -= m.amountFxrp;
        BOND_LEDGER.releaseBond(matchId);
        if (!FXRP.transfer(m.maker, m.amountFxrp)) revert TransferFailed();
        emit MatchReleased(matchId, m.maker, m.amountFxrp, txId);
    }

    /// @notice After `refundAfter + REFUND_GRACE`, returns principal to the taker and slashes 100%
    /// of the maker bond to the taker. Permissionless — "auto-refund" means anyone (including the
    /// taker) may call this once the deadline (plus grace) has passed.
    /// @dev The `REFUND_GRACE` margin (design.md §14) exists so an honest maker whose XRPL payment
    /// lands right at the edge of `PAYMENT_WINDOW` still has time for the FDC proof to arrive and
    /// `release()` to be called before `refund()` unlocks — narrowing, not eliminating, the
    /// refund/release race.
    function refund(bytes32 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        if (m.state != MatchState.Locked) revert NotLocked(matchId);
        if (block.timestamp <= m.refundAfter + REFUND_GRACE) revert RefundTooEarly(m.refundAfter);

        m.state = MatchState.Refunded;
        // See the matching NOTE in release(): armed is decremented alongside committed for the
        // same solvency reason — the principal below is paid straight to the taker's own wallet,
        // so it must also leave this taker's escrow-side `armed` accounting.
        TakerBalance storage bal = balances[m.taker];
        bal.committed -= m.amountFxrp;
        bal.armed -= m.amountFxrp;
        BOND_LEDGER.slashBond(matchId, m.taker);
        if (!FXRP.transfer(m.taker, m.amountFxrp)) revert TransferFailed();
        emit MatchRefunded(matchId, m.taker, m.amountFxrp, m.bondAmount);
    }

    // =========================================================================================
    // Admin / config
    // =========================================================================================

    /// @notice Rotates the TEE signer (required on every TEE restart). Reverts ZeroAddress() on
    /// address(0) — mandatory sub-task (c).
    function setTeeSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        emit TeeSignerUpdated(teeSigner, newSigner);
        teeSigner = newSigner;
    }

    /// @notice Sets the fee treasury. Reverts ZeroAddress() for consistency with setTeeSigner
    /// (audit note, 22 Jul). NOTE(fee): feeTreasury + TAKER_FEE_BIPS are inert in v1
    /// (TAKER_FEE_BIPS == 0). If TAKER_FEE_BIPS is ever raised, lock()/release()/refund() accounting
    /// must also reserve, transfer, and decrement the fee — see design.md §14 / Step 5.
    function setFeeTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        feeTreasury = t;
    }

    /// @notice Gates lock() only — release/refund/withdraw are never pausable.
    function setLockPaused(bool p) external onlyOwner {
        lockPaused = p;
    }

    /// @notice Permissionless re-sync of FtsoV2 + FdcVerification.
    /// @dev Step 1 STUB: addresses are constructor-injected (mock addresses in tests); this is a
    /// deliberate no-op. TODO(Step 5): re-read both from `FlareContractRegistry`
    /// (0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019) and update `ftsoV2`/`fdcVerification` here.
    function syncFromRegistry() external {
        // intentionally empty in Step 1 — see TODO above.
    }

    // =========================================================================================
    // Internal helpers
    // =========================================================================================

    function _splitSignature(bytes calldata sig) private pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
    }
}
