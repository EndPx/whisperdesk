// config.ts — ported from scripts/fdc-spike/config.mjs + scripts/e2e/config.mjs (the proven e2e
// harness this demo console is porting). Addresses below were resolved LIVE from Coston2's
// FlareContractRegistry (0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019, fixed on every Flare network)
// — see scripts/fdc-spike/config.mjs's header comment for full provenance. Per
// .claude/context/flare-docs/fdc.md + fdc-request-fee.md these MUST NOT be hardcoded in a
// production relayer; kept pinned here only because this demo console mirrors the already-proven
// e2e spike harness, not a production relayer.
export const REGISTRY_ADDRESS = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

export const FDC_HUB_ADDRESS = "0x48aC463d7975828989331F4De43341627b9c5f1D";
export const FDC_REQUEST_FEE_CONFIGURATIONS_ADDRESS = "0x191a1282Ac700edE65c5B0AaF313BAcC3eA7fC7e";
// NOTE (carried over from scripts/fdc-spike/config.mjs): flare-docs/fdc.md lists a different,
// STALE FdcVerification address. This live-verified value matches what the registry actually
// returns — the registry is the only truth.
export const FDC_VERIFICATION_ADDRESS = "0x906507E0B64bcD494Db73bd0459d1C667e14B933";
export const FLARE_SYSTEMS_MANAGER_ADDRESS = "0xA90Db6D10F856799b10ef2A77EBCbF460aC71e52";

export const COSTON2_CHAIN_ID = 114;

export const VOTING_EPOCH_DURATION_SECONDS = 90;

// Verifier server (testnet) — path is lowercase "xrp" regardless of attestation type/source.
export const FDC_VERIFIER_BASE_URL = "https://fdc-verifiers-testnet.flare.network";
export const FDC_VERIFIER_PREPARE_PATH = "/verifier/xrp/XRPPayment/prepareRequest";
// Public testnet API key, documented at dev.flare.network/fdc/guides/fdc-by-hand (Swagger
// "Authorize" default). NOT a secret — safe to keep in source.
export const FDC_VERIFIER_API_KEY = "00000000-0000-0000-0000-000000000000";

// DA Layer (Coston2) — serves the Merkle proof once consensus is reached for a voting round.
export const DA_LAYER_BASE_URL = "https://ctn2-data-availability.flare.network";
export const DA_LAYER_PROOF_PATH = "/api/v1/fdc/proof-by-request-round";
export const DA_LAYER_API_KEY = "00000000-0000-0000-0000-000000000000";

export const XRPL_TESTNET_WSS = "wss://s.altnet.rippletest.net:51233";

export const FDC_HUB_ABI = [
  "function requestAttestation(bytes calldata _data) external payable",
  "event AttestationRequest(bytes data, uint256 fee)",
];

export const FEE_CONFIG_ABI = ["function getRequestFee(bytes calldata _data) view returns (uint256)"];

export const FLARE_SYSTEMS_MANAGER_ABI = [
  "function getCurrentVotingEpochId() view returns (uint256)",
  "function firstVotingRoundStartTs() view returns (uint256)",
];
