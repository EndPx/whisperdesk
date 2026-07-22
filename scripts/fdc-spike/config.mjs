// Shared config/constants for the Step 2 FDC spike harness.
// Addresses below were resolved LIVE from Coston2's FlareContractRegistry
// (0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019, fixed on every Flare network) on 2026-07-23 via
// `cast call ... getContractAddressByName(string)`. Per flare-docs/fdc.md + fdc-request-fee.md,
// these MUST NOT be hardcoded in production — re-resolve at runtime. They are pinned here only
// because this is a throwaway spike harness, not the production relayer.
export const REGISTRY_ADDRESS = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

export const FDC_HUB_ADDRESS = "0x48aC463d7975828989331F4De43341627b9c5f1D";
export const FDC_REQUEST_FEE_CONFIGURATIONS_ADDRESS = "0x191a1282Ac700edE65c5B0AaF313BAcC3eA7fC7e";
// NOTE: flare-docs/fdc.md lists 0x075bf301fF07C4920e5261f93a0609640F53487D for FdcVerification —
// that value is STALE. fdc-request-fee.md's live-verified value (0x9065...) matches what the
// registry actually returns today; the docs explicitly flag this disagreement and say "the
// registry is the only truth". Confirmed again live in this session — see notes.md.
export const FDC_VERIFICATION_ADDRESS = "0x906507E0B64bcD494Db73bd0459d1C667e14B933";
export const FLARE_SYSTEMS_MANAGER_ADDRESS = "0xA90Db6D10F856799b10ef2A77EBCbF460aC71e52";

export const COSTON2_CHAIN_ID = 114;
export const COSTON2_RPC_DEFAULT = "https://coston2-api.flare.network/ext/C/rpc";

export const VOTING_EPOCH_DURATION_SECONDS = 90;

// Verifier server (testnet) — path is lowercase "xrp" regardless of attestation type/source.
export const FDC_VERIFIER_BASE_URL = "https://fdc-verifiers-testnet.flare.network";
export const FDC_VERIFIER_PREPARE_PATH = "/verifier/xrp/XRPPayment/prepareRequest";
// Public testnet API key, documented at dev.flare.network/fdc/guides/fdc-by-hand (Swagger
// "Authorize" default). NOT a secret — safe to keep in source. If Flare ever requires a
// per-account key, that would need to move to .env as VERIFIER_API_KEY_TESTNET.
export const FDC_VERIFIER_API_KEY = "00000000-0000-0000-0000-000000000000";

// DA Layer (Coston2) — serves the Merkle proof once consensus is reached for a voting round.
export const DA_LAYER_BASE_URL = "https://ctn2-data-availability.flare.network";
export const DA_LAYER_PROOF_PATH = "/api/v1/fdc/proof-by-request-round";
export const DA_LAYER_API_KEY = "00000000-0000-0000-0000-000000000000";

export const ABI = {
  registry: [
    "function getContractAddressByName(string _name) view returns (address)",
  ],
  fdcHub: [
    "function requestAttestation(bytes calldata _data) external payable",
    "event AttestationRequest(bytes data, uint256 fee)",
  ],
  feeConfig: [
    "function getRequestFee(bytes calldata _data) view returns (uint256)",
  ],
  fdcVerification: [
    "function fdcProtocolId() view returns (uint8)",
  ],
  flareSystemsManager: [
    "function getCurrentVotingEpochId() view returns (uint256)",
    "function firstVotingRoundStartTs() view returns (uint256)",
  ],
  fdcXrpVerifier: [
    "function fdcVerification() view returns (address)",
    "function verify((bytes32[] merkleProof,(bytes32 attestationType,bytes32 sourceId,uint64 votingRound,uint64 lowestUsedTimestamp,(bytes32 transactionId,address proofOwner) requestBody,(uint64 blockNumber,uint64 blockTimestamp,string sourceAddress,bytes32 sourceAddressHash,bytes32 receivingAddressHash,bytes32 intendedReceivingAddressHash,int256 spentAmount,int256 intendedSpentAmount,int256 receivedAmount,int256 intendedReceivedAmount,bool hasMemoData,bytes firstMemoData,bool hasDestinationTag,uint256 destinationTag,uint8 status) responseBody) data) proof) view returns (bool ok, string sourceAddress, bytes32 receivingAddressHash, int256 receivedAmount, bool hasDestinationTag, uint256 destinationTag, uint8 status, uint64 blockTimestamp)",
  ],
};

export const PAYMENT_DROPS = "1000000"; // 1 XRP
export const DESTINATION_TAG = 12345;

// Deployed via scripts/fdc-spike/deploy-verifier.sh (forge create), Coston2, Step 2 spike.
// Constructor arg was FDC_VERIFICATION_ADDRESS above (registry-resolved at deploy time).
export const FDC_XRP_VERIFIER_ADDRESS = "0x470De46985939a7e09821a6e6a3ED1f415d50ED6";

export const OUT_DIR = new URL("./out/", import.meta.url);
