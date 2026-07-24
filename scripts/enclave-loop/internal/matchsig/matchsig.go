// Package matchsig ports the client-side half of extension/matcher/instruction.go's signing
// scheme (WD_MATCH_V1 / MatchInstructionLib) — just enough to independently recompute
// dataHash -> ethSignedDigest -> ecrecover from a MatchResponse's abiEncoded+teeSignature and
// check it against the enclave address /info reports, WITHOUT re-deriving trust from the
// enclave's own claimed outcome. Deliberately go-flare-common-free (mirrors instruction.go's own
// EthSignedDigest, which is documented there as an independent cross-check on the
// csigning.Payload path, not a re-use of it) — this package only needs go-ethereum's crypto/common.
package matchsig

import (
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// WDMatchTag mirrors MatchInstructionLib.WD_MATCH_TAG = bytes32("WD_MATCH_V1") and
// extension/matcher/instruction.go's WDMatchTag() — the ASCII string right-padded into 32 bytes.
func WDMatchTag() [32]byte {
	var b [32]byte
	copy(b[:], []byte("WD_MATCH_V1"))
	return b
}

// DataHash reproduces MatchInstructionLib.dataHash(abi.encode(mi)) = keccak256(instructionData).
// abiEncoded is the raw "abiEncoded" hex field of a MatchResponse, hex-decoded by the caller.
func DataHash(abiEncoded []byte) common.Hash {
	return crypto.Keccak256Hash(abiEncoded)
}

// EthSignedDigest reproduces MatchInstructionLib.ethSignedDigest(dataHash, chainId) exactly —
// byte-for-byte port of extension/matcher/instruction.go's EthSignedDigest:
//
//	payloadHash = keccak256(abi.encode(WD_MATCH_TAG, chainId, dataHash))
//	digest      = keccak256("\x19Ethereum Signed Message:\n32" || payloadHash)
func EthSignedDigest(dataHash common.Hash, chainID uint64) common.Hash {
	tag := WDMatchTag()
	chainIDWord := common.LeftPadBytes(new(big.Int).SetUint64(chainID).Bytes(), 32)

	encoded := make([]byte, 0, 96)
	encoded = append(encoded, tag[:]...)
	encoded = append(encoded, chainIDWord...)
	encoded = append(encoded, dataHash[:]...)

	payloadHash := crypto.Keccak256(encoded)

	prefix := []byte("\x19Ethereum Signed Message:\n32")
	return common.BytesToHash(crypto.Keccak256(append(prefix, payloadHash...)))
}

// normalizeForRecover converts a 65-byte [R||S||V] signature with V in {27,28} (the on-chain /
// lock() wire format, and what MatchResponse.teeSignature carries) back to the {0,1} form
// crypto.SigToPub/crypto.Ecrecover expect.
func normalizeForRecover(sig []byte) ([]byte, error) {
	if len(sig) != 65 {
		return nil, fmt.Errorf("matchsig: expected 65-byte [R||S||V] signature, got %d bytes", len(sig))
	}
	out := append([]byte(nil), sig...)
	if out[64] >= 27 {
		out[64] -= 27
	}
	return out, nil
}

// Recover recovers the signer address from a 65-byte [R||S||V] (V in {27,28}) signature over
// digest — the same recovery DvPEscrow.lock() performs via `ecrecover`, ported from
// extension/matcher/instruction.go's Recover().
func Recover(digest common.Hash, sig []byte) (common.Address, error) {
	normalized, err := normalizeForRecover(sig)
	if err != nil {
		return common.Address{}, err
	}
	pub, err := crypto.SigToPub(digest[:], normalized)
	if err != nil {
		return common.Address{}, fmt.Errorf("matchsig: Recover: %w", err)
	}
	return crypto.PubkeyToAddress(*pub), nil
}

// VerifyMatch is the one call wd-client's `loop` subcommand makes: recompute the full
// dataHash -> ethSignedDigest -> ecrecover chain from a MatchResponse's abiEncoded+teeSignature and
// assert the recovered signer equals expectedSigner (the /info-derived enclave address). Returns
// the recovered address regardless, so callers can log a mismatch with both addresses.
func VerifyMatch(abiEncoded, teeSignature []byte, chainID uint64, expectedSigner common.Address) (common.Address, error) {
	dHash := DataHash(abiEncoded)
	digest := EthSignedDigest(dHash, chainID)
	recovered, err := Recover(digest, teeSignature)
	if err != nil {
		return common.Address{}, err
	}
	if recovered != expectedSigner {
		return recovered, fmt.Errorf(
			"matchsig: VerifyMatch: ecrecover mismatch: recovered %s, expected (enclave) %s",
			recovered.Hex(), expectedSigner.Hex(),
		)
	}
	return recovered, nil
}
