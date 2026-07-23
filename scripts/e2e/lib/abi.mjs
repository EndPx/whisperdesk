// abi.mjs — minimal ethers.js ABI fragments for the Step 5 E2E runners. Kept hand-written and
// small (rather than importing forge's full `out/DvPEscrow.sol/DvPEscrow.json` artifact) so these
// scripts have no build-step dependency on `forge build` having just run; the fragments below are
// the exact subset happy-path.mjs / default-path.mjs call, transcribed from
// contracts/src/DvPEscrow.sol (Step 5).

export const DVP_ESCROW_ABI = [
  "function owner() view returns (address)",
  "function teeSigner() view returns (address)",
  "function ftsoV2() view returns (address)",
  "function fdcVerification() view returns (address)",
  "function FXRP() view returns (address)",
  "function BOND_LEDGER() view returns (address)",
  "function MIN_BLOCK_FXRP() view returns (uint256)",
  "function BOND_BIPS() view returns (uint16)",
  "function SETTLEMENT_WINDOW() view returns (uint32)",
  "function PAYMENT_WINDOW() view returns (uint32)",
  "function REFUND_GRACE() view returns (uint32)",
  "function balances(address) view returns (uint128 armed, uint128 committed, uint64 armedUntil)",
  "function matches(bytes32) view returns (address taker, uint32 destinationTag, uint40 lockedAt, uint8 state, address maker, uint40 paymentDeadline, uint40 refundAfter, uint128 amountFxrp, uint128 xrpDrops, uint128 bondAmount, bytes32 takerXrplAddressHash)",
  "function deposit(uint256 amount, uint64 armedUntil)",
  "function lock(bytes instructionData, bytes teeSignature) payable returns (bytes32 matchId)",
  "function release(bytes32 matchId, (bytes32[] merkleProof,(bytes32 attestationType,bytes32 sourceId,uint64 votingRound,uint64 lowestUsedTimestamp,(bytes32 transactionId,address proofOwner) requestBody,(uint64 blockNumber,uint64 blockTimestamp,string sourceAddress,bytes32 sourceAddressHash,bytes32 receivingAddressHash,bytes32 intendedReceivingAddressHash,int256 spentAmount,int256 intendedSpentAmount,int256 receivedAmount,int256 intendedReceivedAmount,bool hasMemoData,bytes firstMemoData,bool hasDestinationTag,uint256 destinationTag,uint8 status) responseBody) data) proof)",
  "function refund(bytes32 matchId)",
  "event MatchLocked(bytes32 indexed matchId, address indexed taker, address indexed maker, uint256 amountFxrp, uint256 xrpDrops, uint32 destinationTag, string takerXrplAddress, uint64 paymentDeadline, uint64 refundAfter, uint256 priceUsd18, uint256 oracleMid18)",
  "event MatchReleased(bytes32 indexed matchId, address indexed maker, uint256 amountFxrp, bytes32 xrplTxId)",
  "event MatchRefunded(bytes32 indexed matchId, address indexed taker, uint256 amountFxrp, uint256 bondSlashed)",
];

export const MOCK_FXRP_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

export const BOND_LEDGER_ABI = [
  "function depositBond(uint256 amount)",
  "function freeBond(address) view returns (uint256)",
];

export const FTSOV2_ABI = [
  "function getFeedByIdInWei(bytes21) payable returns (uint256, uint64)",
  "function calculateFeeById(bytes21) view returns (uint256)",
];

// XRP/USD feed ID (bytes21), pinned identically to DvPEscrow.sol's XRP_USD_FEED_ID constant and
// .claude/context/flare-docs/ftsov2-feed-id-xrp-usd.md.
export const XRP_USD_FEED_ID = "0x015852502f55534400000000000000000000000000";
