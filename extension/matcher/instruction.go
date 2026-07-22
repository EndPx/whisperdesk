// Package matcher implements WhisperDesk's TEE-side sealed RFQ book and deterministic matching
// engine (docs/design.md §4), plus the MatchInstruction builder/signer that produces the exact
// wire format DvPEscrow.lock() consumes (docs/design.md §3.5, contracts/src/libraries/
// MatchInstructionLib.sol). The ABI encoding, dataHash, and ethSignedDigest here MUST stay
// byte-identical to the Solidity library — see extension/matcher/testdata and
// contracts/test/vectors/matchinstruction.json for the cross-language parity vectors, and
// extension/smoketest/smoke_test.go for the proven signing-scheme compatibility this package
// reuses verbatim (go-flare-common's signing.Payload + tee-node's utils.Sign).
package matcher

import (
	"crypto/ecdsa"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	csigning "github.com/flare-foundation/go-flare-common/pkg/signing"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"
)

// WDMatchTag mirrors MatchInstructionLib.WD_MATCH_TAG = bytes32("WD_MATCH_V1") — the ASCII string
// left-padded into a 32-byte array (byte-identical to Solidity's `bytes32("WD_MATCH_V1")`).
func WDMatchTag() [32]byte {
	var b [32]byte
	copy(b[:], []byte("WD_MATCH_V1"))
	return b
}

// MatchInstruction is the Go mirror of MatchInstructionLib.MatchInstruction (design.md §3.5).
// Field order is CANONICAL — ABI tuple: (bytes32,address,address,address,uint256,uint256,string,uint64).
// Do not reorder, add, or remove fields without updating the Solidity library and the TS client
// in lockstep.
type MatchInstruction struct {
	MatchID              common.Hash    // == rfqId == instructionId of the RFQ_SUBMIT instruction
	Escrow               common.Address // target DvPEscrow — cross-instance replay guard
	Taker                common.Address // == SealedEnvelope.sender of the RFQ (chain-authenticated)
	Maker                common.Address // EIP-712-verified, bonded quote signer
	AmountFxrp           *big.Int       // raw 6-dec, >= MIN_BLOCK_FXRP
	PriceUsd18           *big.Int       // matched USD per XRP (== per FXRP at par), 18-dec
	TakerXrplAddress     string         // plaintext r-address for the XRPL leg
	InstructionExpiresAt uint64         // enclave matchTime + 300s; lock() reverts after this
}

// matchInstructionTuple is the reflection target go-ethereum's abi package packs into the single
// top-level "tuple" argument below. Field ORDER here is irrelevant to encoding (the abi tags are
// matched by name against the tuple's component list, not struct field order) but is kept
// identical to MatchInstruction/MatchInstructionLib.MatchInstruction for readability.
type matchInstructionTuple struct {
	MatchID              [32]byte       `abi:"matchId"`
	Escrow               common.Address `abi:"escrow"`
	Taker                common.Address `abi:"taker"`
	Maker                common.Address `abi:"maker"`
	AmountFxrp           *big.Int       `abi:"amountFxrp"`
	PriceUsd18           *big.Int       `abi:"priceUsd18"`
	TakerXrplAddress     string         `abi:"takerXrplAddress"`
	InstructionExpiresAt uint64         `abi:"instructionExpiresAt"`
}

var matchInstructionArgs abi.Arguments

func init() {
	// CRITICAL: Solidity's `abi.encode(mi)` for a single MatchInstruction struct argument is NOT
	// the same bytes as `abi.encode(mi.matchId, mi.escrow, ..., mi.instructionExpiresAt)` (8
	// separate top-level arguments). Because MatchInstruction contains a dynamic field
	// (takerXrplAddress: string), the struct itself is a dynamic type, so as the SOLE top-level
	// argument it gets its own head slot containing an offset (always 0x20) pointing at the tail,
	// which is then the tuple's own 8-field head+tail encoding. Packing the 8 fields as flat
	// top-level Arguments (no wrapping tuple type) — the first version of this file did — omits
	// that leading offset word and produces bytes 32 bytes short of what
	// MatchInstructionLib.dataHash(abi.encode(mi)) actually hashes onchain. Verified against real
	// solc 0.8.25 via contracts/test/GoldenVectors.t.sol. Modeling MatchInstruction as a single
	// "tuple"-typed Argument (matching what a Solidity function with one MatchInstruction
	// parameter receives) reproduces the exact byte-for-byte layout.
	tupleTy, err := abi.NewType("tuple", "MatchInstructionLib.MatchInstruction", []abi.ArgumentMarshaling{
		{Name: "matchId", Type: "bytes32"},
		{Name: "escrow", Type: "address"},
		{Name: "taker", Type: "address"},
		{Name: "maker", Type: "address"},
		{Name: "amountFxrp", Type: "uint256"},
		{Name: "priceUsd18", Type: "uint256"},
		{Name: "takerXrplAddress", Type: "string"},
		{Name: "instructionExpiresAt", Type: "uint64"},
	})
	if err != nil {
		panic(err)
	}
	matchInstructionArgs = abi.Arguments{{Type: tupleTy}}
}

// ABIEncode reproduces Solidity's `abi.encode(mi)` for a MatchInstruction struct literal
// byte-for-byte, INCLUDING the leading 32-byte offset word Solidity emits for a single dynamic
// top-level argument (see the init() comment above). This is the exact byte string
// MatchInstructionLib.dataHash hashes and that DvPEscrow.lock() expects as `instructionData`.
func (mi MatchInstruction) ABIEncode() ([]byte, error) {
	if mi.AmountFxrp == nil || mi.PriceUsd18 == nil {
		return nil, fmt.Errorf("matcher: MatchInstruction.ABIEncode: AmountFxrp/PriceUsd18 must not be nil")
	}
	return matchInstructionArgs.Pack(matchInstructionTuple{
		MatchID:              mi.MatchID,
		Escrow:               mi.Escrow,
		Taker:                mi.Taker,
		Maker:                mi.Maker,
		AmountFxrp:           mi.AmountFxrp,
		PriceUsd18:           mi.PriceUsd18,
		TakerXrplAddress:     mi.TakerXrplAddress,
		InstructionExpiresAt: mi.InstructionExpiresAt,
	})
}

// DataHash reproduces MatchInstructionLib.dataHash(abi.encode(mi)) = keccak256(instructionData).
func DataHash(abiEncoded []byte) common.Hash {
	return crypto.Keccak256Hash(abiEncoded)
}

// EthSignedDigest reproduces MatchInstructionLib.ethSignedDigest(dataHash, chainId) exactly:
//
//	payloadHash = keccak256(abi.encode(WD_MATCH_TAG, chainId, dataHash))
//	digest      = keccak256("\x19Ethereum Signed Message:\n32" || payloadHash)
//
// Deliberately independent of go-flare-common's Payload/abicoder path (uses go-ethereum's own
// left-pad + concat, mirroring abi.encode of three static 32-byte words) so this acts as a
// cross-check on the Sign() path below, not a tautology — mirrors
// extension/smoketest/smoke_test.go's solidityEthSignedDigest helper.
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

// SignedMatch is the full output of signing a MatchInstruction: everything needed to call
// DvPEscrow.lock(abiEncoded, teeSignature) plus the intermediate hashes for tests/vectors.
type SignedMatch struct {
	Instruction  MatchInstruction
	AbiEncoded   []byte
	DataHash     common.Hash
	EthSignedDig common.Hash
	Signature    []byte // 65 B [R||S||V], V in {27,28} — ready for lock()
	Signer       common.Address
}

// Sign builds the WD_MATCH_V1 signature for mi using the EXACT proven scheme from
// extension/smoketest/smoke_test.go: go-flare-common's signing.Payload (ABI-encodes
// (prefix,chainId,dataHash) and keccak256s it) then tee-node's utils.Sign (EIP-191 personal-sign
// over that hash via go-ethereum's crypto.Sign). This is the same construction the real TEE sign
// port (`POST /sign`) performs — reused directly here rather than requiring the running sign port,
// per Step 4's scope (the sign-port wiring is Step 5). utils.Sign returns V in {0,1}; Sign
// normalizes +27 before returning, matching the engine's documented behavior (design.md §5.1) and
// what DvPEscrow.lock()'s `v in {27,28}` check requires.
func Sign(mi MatchInstruction, chainID uint64, privKey *ecdsa.PrivateKey) (*SignedMatch, error) {
	abiEncoded, err := mi.ABIEncode()
	if err != nil {
		return nil, fmt.Errorf("matcher: Sign: ABIEncode: %w", err)
	}
	dataHash := DataHash(abiEncoded)

	payload := csigning.NewPayload(WDMatchTag(), chainID, dataHash)
	payloadHash, err := payload.Hash()
	if err != nil {
		return nil, fmt.Errorf("matcher: Sign: payload hash: %w", err)
	}

	sig, err := teeutils.Sign(payloadHash[:], privKey)
	if err != nil {
		return nil, fmt.Errorf("matcher: Sign: sign: %w", err)
	}
	if len(sig) != 65 {
		return nil, fmt.Errorf("matcher: Sign: expected 65-byte signature, got %d", len(sig))
	}
	// Normalize V: sign port / utils.Sign return V in {0,1}; onchain ecrecover requires {27,28}.
	sig = append([]byte(nil), sig...) // defensive copy — do not mutate callee's buffer
	if sig[64] < 27 {
		sig[64] += 27
	}

	digest := EthSignedDigest(dataHash, chainID)

	recoveredPub, err := crypto.SigToPub(digest[:], normalizeForRecover(sig))
	if err != nil {
		return nil, fmt.Errorf("matcher: Sign: recover pubkey: %w", err)
	}
	signer := crypto.PubkeyToAddress(*recoveredPub)

	return &SignedMatch{
		Instruction:  mi,
		AbiEncoded:   abiEncoded,
		DataHash:     dataHash,
		EthSignedDig: digest,
		Signature:    sig,
		Signer:       signer,
	}, nil
}

// normalizeForRecover converts a 65-byte [R||S||V] signature with V in {27,28} (the on-chain /
// lock() wire format) back to the {0,1} form crypto.SigToPub/crypto.Ecrecover expect.
func normalizeForRecover(sig []byte) []byte {
	out := append([]byte(nil), sig...)
	if out[64] >= 27 {
		out[64] -= 27
	}
	return out
}

// Recover recovers the signer address from a 65-byte [R||S||V] (V in {27,28}) signature over
// digest — the same recovery DvPEscrow.lock() performs via `ecrecover`. Exposed for tests/vectors.
func Recover(digest common.Hash, sig []byte) (common.Address, error) {
	if len(sig) != 65 {
		return common.Address{}, fmt.Errorf("matcher: Recover: expected 65-byte signature, got %d", len(sig))
	}
	pub, err := crypto.SigToPub(digest[:], normalizeForRecover(sig))
	if err != nil {
		return common.Address{}, err
	}
	return crypto.PubkeyToAddress(*pub), nil
}
