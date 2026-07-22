// Package smoketest is a standalone, Docker-free smoke test proving that the
// exact Go signing primitives the FCE stack will use inside the TEE
// (go-flare-common's signing.Payload + tee-node's utils.Sign, i.e.
// EIP-191 personal-sign over keccak256(abi.encode(prefix, chainId, dataHash)))
// produce a signature that recovers, via go-ethereum's ecrecover-compatible
// crypto.SigToPub, to the expected signer address — the same scheme
// WhisperDesk's MatchInstructionLib.ethSignedDigest expects on-chain
// (contracts/src/libraries/MatchInstructionLib.sol), just with the
// WD_MATCH_V1 domain tag instead of the node's own TEE_ACTION_RESULT tag.
//
// No Docker, no registration, no chain calls — pure crypto, run with:
//
//	go test ./... -run TestSigningSchemeMatchesMatchInstructionLib -v
package smoketest

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	csigning "github.com/flare-foundation/go-flare-common/pkg/signing"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"
)

// wdMatchTag mirrors MatchInstructionLib.WD_MATCH_TAG = bytes32("WD_MATCH_V1").
// (go-flare-common's csigning.Prefix constants are all built the same way —
// left-pad the ASCII string into a 32-byte array — so this is the Go-side
// equivalent of Solidity's `bytes32("WD_MATCH_V1")`.)
func wdMatchTag() [32]byte {
	var b [32]byte
	copy(b[:], []byte("WD_MATCH_V1"))
	return b
}

// TestSigningSchemeMatchesMatchInstructionLib proves ecrecover-compatibility
// between the TEE-side signing primitive and MatchInstructionLib.ethSignedDigest.
//
// Solidity side (contracts/src/libraries/MatchInstructionLib.sol):
//
//	payloadHash = keccak256(abi.encode(WD_MATCH_TAG, chainId, dataHash))
//	digest      = keccak256("\x19Ethereum Signed Message:\n32" || payloadHash)
//	signer      = ecrecover(digest, v, r, s)
//
// Go side under test (go-flare-common/pkg/signing.Payload.Hash() +
// tee-node/pkg/utils.Sign, the exact functions internal/router/utils.go's
// SignResult() calls for the transport-level TEE_ACTION_RESULT signature —
// Step 4's handler will call the equivalent for the WD_MATCH_V1
// application-level signature via the sign port):
//
//	payloadHash, _ = signing.NewPayload(prefix, chainId, dataHash).Hash()
//	sig            = utils.Sign(payloadHash[:], privKey)
//	              -> crypto.Sign(accounts.TextHash(payloadHash[:]), privKey)
//
// accounts.TextHash(data) = keccak256("\x19Ethereum Signed Message:\n" +
// len(data) + data), which for a 32-byte input is byte-identical to
// Solidity's keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payloadHash)).
//
// abi.encode(bytes32, uint256, bytes32) has no dynamic types, so Solidity's
// abi.encode and go-flare-common's abicoder.Encode (used inside
// signing.Payload.Hash()) both produce the plain 96-byte concatenation of
// the three 32-byte words — no ABI head/tail offsets involved. So the two
// payloadHash computations are byte-for-byte identical by construction; this
// test checks the composition end-to-end rather than re-deriving that fact.
func TestSigningSchemeMatchesMatchInstructionLib(t *testing.T) {
	// 1. A "TEE identity key" — in production this is generated at TEE boot
	// and never leaves the enclave. Here it's just a throwaway test key.
	privKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generating key: %v", err)
	}
	expectedSigner := crypto.PubkeyToAddress(privKey.PublicKey)

	// 2. A sample dataHash — stands in for
	// MatchInstructionLib.dataHash(abi.encode(MatchInstruction)) i.e.
	// keccak256 of the ABI-encoded MatchInstruction struct. The exact bytes
	// don't matter for a crypto-scheme smoke test — only that it's a
	// deterministic bytes32.
	dataHash := crypto.Keccak256Hash([]byte("whisperdesk-sample-match-instruction"))

	// Coston2 chain id (matches DvPEscrow's block.chainid at signing time
	// and docker-compose.coston2.yaml's CHAIN_ID=114).
	const chainID uint64 = 114

	// 3. TEE-side: build the Payload exactly as go-flare-common does, with
	// WhisperDesk's own WD_MATCH_V1 tag instead of TEEActionResult, and sign
	// it with the exact primitive tee-node's node.Sign()/utils.Sign() uses.
	payload := csigning.NewPayload(wdMatchTag(), chainID, dataHash)
	payloadHash, err := payload.Hash()
	if err != nil {
		t.Fatalf("hashing payload: %v", err)
	}

	sig, err := teeutils.Sign(payloadHash[:], privKey)
	if err != nil {
		t.Fatalf("signing: %v", err)
	}
	if len(sig) != 65 {
		t.Fatalf("expected 65-byte [R||S||V] signature, got %d bytes", len(sig))
	}

	// 4. Verifier side: reconstruct the digest exactly as
	// MatchInstructionLib.ethSignedDigest(dataHash, chainId) does in
	// Solidity, and recover with go-ethereum's crypto.SigToPub — the same
	// secp256k1/keccak256 primitives Solidity's `ecrecover` builtin is
	// designed to be compatible with (given the standard v=27/28 shift,
	// which crypto.SigToPub/crypto.Ecrecover handle for the v=0/1 the
	// signature already carries).
	digest := solidityEthSignedDigest(dataHash, chainID)

	recoveredPub, err := crypto.SigToPub(digest, sig)
	if err != nil {
		t.Fatalf("recovering pubkey: %v", err)
	}
	recoveredSigner := crypto.PubkeyToAddress(*recoveredPub)

	if recoveredSigner != expectedSigner {
		t.Fatalf("ecrecover mismatch: signed by %s, recovered %s", expectedSigner.Hex(), recoveredSigner.Hex())
	}

	// 5. Independently reproduce accounts.TextHash to double-check it is
	// byte-identical to Solidity's EIP-191 personal-sign construction (this
	// is the load-bearing assumption of step 4's comment above).
	manualDigest := accounts.TextHash(payloadHash[:])
	if common.BytesToHash(manualDigest) != common.BytesToHash(digest) {
		t.Fatalf("accounts.TextHash diverges from the hand-rolled Solidity-style digest")
	}

	t.Logf("PASS: TEE signer %s == on-chain ecrecover(MatchInstructionLib.ethSignedDigest(...)) result", expectedSigner.Hex())
}

// solidityEthSignedDigest is a byte-for-byte Go re-implementation of
// MatchInstructionLib.ethSignedDigest(bytes32 dataHash_, uint256 chainId):
//
//	bytes32 payloadHash = keccak256(abi.encode(WD_MATCH_TAG, chainId, dataHash_));
//	return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payloadHash));
//
// Deliberately independent of go-flare-common's abicoder (uses go-ethereum's
// own left-pad + concat, mirroring abi.encode of three static 32-byte words)
// so this acts as a cross-check on csigning.Payload.Hash(), not a tautology.
func solidityEthSignedDigest(dataHash common.Hash, chainID uint64) []byte {
	tag := wdMatchTag()
	chainIDWord := common.LeftPadBytes(new(big.Int).SetUint64(chainID).Bytes(), 32)

	encoded := make([]byte, 0, 96)
	encoded = append(encoded, tag[:]...)
	encoded = append(encoded, chainIDWord...)
	encoded = append(encoded, dataHash[:]...)

	payloadHash := crypto.Keccak256(encoded)

	prefix := []byte("\x19Ethereum Signed Message:\n32")
	return crypto.Keccak256(append(prefix, payloadHash...))
}
