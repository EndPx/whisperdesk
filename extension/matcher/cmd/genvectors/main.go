// Command genvectors emits the WhisperDesk MatchInstruction golden vectors — the single source of
// truth for cross-language (Go <-> Solidity) byte parity of ABI encoding, dataHash,
// ethSignedDigest, and TEE signature recovery (docs/design.md §3.5/§6.3, Step 4 DoD).
//
// Output: contracts/test/vectors/matchinstruction.json — read by both
// extension/matcher/vectors_test.go (Go side) and contracts/test/GoldenVectors.t.sol (Solidity
// side). Run with:
//
//	go run ./cmd/genvectors
package main

import (
	"crypto/ecdsa"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"path/filepath"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	"wd-matcher"
)

// vector is the JSON shape of a single golden vector. All integer fields are hex strings
// ("0x...") — Foundry's `vm.parseJsonUint` requires this for values that may exceed float64/JSON
// number precision, and it is unambiguous in Go too (big.Int / strconv with base 0).
type vector struct {
	Name                 string `json:"name"`
	ChainID              string `json:"chainId"`
	TeeSignerPrivateKey  string `json:"teeSignerPrivateKey"`
	MatchID              string `json:"matchId"`
	Escrow               string `json:"escrow"`
	Taker                string `json:"taker"`
	Maker                string `json:"maker"`
	AmountFxrp           string `json:"amountFxrp"`
	PriceUsd18           string `json:"priceUsd18"`
	TakerXrplAddress     string `json:"takerXrplAddress"`
	InstructionExpiresAt string `json:"instructionExpiresAt"`

	AbiEncoded      string `json:"abiEncoded"`
	DataHash        string `json:"dataHash"`
	EthSignedDigest string `json:"ethSignedDigest"`
	Signature       string `json:"signature"`
	ExpectedSigner  string `json:"expectedSigner"`
}

type vectorFile struct {
	Description string   `json:"description"`
	WDMatchTag  string   `json:"wdMatchTag"`
	Count       int      `json:"count"` // len(Vectors) — lets Solidity loop 0..count-1 without an array-length cheatcode
	Vectors     []vector `json:"vectors"`
}

// Deterministic test private keys, derived as keccak256(label) — fixed and reproducible
// byte-for-byte across regenerations (not random), without hand-typing 32-byte hex literals that
// are easy to get subtly wrong (off-by-one-byte, transposed digits).
func mustKeyFromLabel(label string) *ecdsa.PrivateKey {
	seed := crypto.Keccak256([]byte(label))
	pk, err := crypto.ToECDSA(seed)
	if err != nil {
		panic(err)
	}
	return pk
}

func hexUint(v uint64) string {
	return fmt.Sprintf("0x%x", v)
}

func hexBig(v *big.Int) string {
	return fmt.Sprintf("0x%x", v)
}

func main() {
	keyA := mustKeyFromLabel("whisperdesk-vector-tee-key-a")
	keyB := mustKeyFromLabel("whisperdesk-vector-tee-key-b")

	type spec struct {
		name    string
		chainID uint64
		key     *ecdsa.PrivateKey
		mi      matcher.MatchInstruction
	}

	specs := []spec{
		{
			name:    "happy-path-min-block",
			chainID: 114,
			key:     keyA,
			mi: matcher.MatchInstruction{
				MatchID:              common.HexToHash("0x1111111111111111111111111111111111111111111111111111111111111111"),
				Escrow:               common.HexToAddress("0x000000000000000000000000000000000000e1"),
				Taker:                common.HexToAddress("0x00000000000000000000000000000000000ea1"),
				Maker:                common.HexToAddress("0x00000000000000000000000000000000000ea2"),
				AmountFxrp:           big.NewInt(5_000_000_000), // exact MIN_BLOCK_FXRP boundary
				PriceUsd18:           new(big.Int).SetUint64(1_000_000_000_000_000_000),
				TakerXrplAddress:     "rLLsk7Ac3eDPRRPFPeeC1nCPKMWnQ38rTL",
				InstructionExpiresAt: 1_800_000_000,
			},
		},
		{
			name:    "large-block-and-price",
			chainID: 114,
			key:     keyA,
			mi: matcher.MatchInstruction{
				MatchID:              crypto.Keccak256Hash([]byte("whisperdesk-vector-2")),
				Escrow:               common.HexToAddress("0xabc1230000000000000000000000000000dead"),
				Taker:                common.HexToAddress("0x1234567890123456789012345678901234567890"),
				Maker:                common.HexToAddress("0x9876543210987654321098765432109876543210"),
				AmountFxrp:           new(big.Int).SetUint64(123_456_789_000),           // 123,456.789 FXRP
				PriceUsd18:           new(big.Int).SetUint64(3_070_000_000_000_000_000), // 3.07 USD
				TakerXrplAddress:     "rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn",
				InstructionExpiresAt: 4_102_444_800, // year 2100 — large-but-realistic uint64 value
			},
		},
		{
			name:    "different-signer-key",
			chainID: 114,
			key:     keyB,
			mi: matcher.MatchInstruction{
				MatchID:              crypto.Keccak256Hash([]byte("whisperdesk-vector-3")),
				Escrow:               common.HexToAddress("0x0000000000000000000000000000000000001e"),
				Taker:                common.HexToAddress("0x0000000000000000000000000000000000002e"),
				Maker:                common.HexToAddress("0x0000000000000000000000000000000000003e"),
				AmountFxrp:           new(big.Int).SetUint64(5_000_000_001),           // one raw unit above the boundary
				PriceUsd18:           new(big.Int).SetUint64(990_000_000_000_000_000), // -1% band edge (0.99 USD)
				TakerXrplAddress:     "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH",
				InstructionExpiresAt: 1,
			},
		},
		{
			name:    "zero-amount-and-expiry-edge",
			chainID: 114,
			key:     keyA,
			mi: matcher.MatchInstruction{
				MatchID:              common.Hash{}, // zero matchId — pure ABI-encoding edge case
				Escrow:               common.HexToAddress("0x000000000000000000000000000000000000e1"),
				Taker:                common.HexToAddress("0x00000000000000000000000000000000000aaa"),
				Maker:                common.HexToAddress("0x00000000000000000000000000000000000bbb"),
				AmountFxrp:           big.NewInt(0),
				PriceUsd18:           big.NewInt(0),
				TakerXrplAddress:     "",
				InstructionExpiresAt: 0,
			},
		},
		{
			name:    "max-uint64-expiry",
			chainID: 114,
			key:     keyA,
			mi: matcher.MatchInstruction{
				MatchID:              crypto.Keccak256Hash([]byte("whisperdesk-vector-5")),
				Escrow:               common.HexToAddress("0x000000000000000000000000000000000000e1"),
				Taker:                common.HexToAddress("0x00000000000000000000000000000000000ccc"),
				Maker:                common.HexToAddress("0x00000000000000000000000000000000000ddd"),
				AmountFxrp:           new(big.Int).SetUint64(9_999_999_999_999),
				PriceUsd18:           new(big.Int).SetUint64(1_010_000_000_000_000_000), // +1% band edge (1.01 USD)
				TakerXrplAddress:     "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
				InstructionExpiresAt: ^uint64(0),
			},
		},
	}

	out := vectorFile{
		Description: "WhisperDesk MatchInstruction golden vectors — single source of truth for Go<->Solidity " +
			"ABI-encoding/dataHash/ethSignedDigest/signature-recovery parity (docs/design.md §3.5/§6.3). " +
			"Generated by extension/matcher/cmd/genvectors — do not hand-edit; regenerate instead.",
		WDMatchTag: "0x" + common.Bytes2Hex(func() []byte { t := matcher.WDMatchTag(); return t[:] }()),
	}

	for _, s := range specs {
		signed, err := matcher.Sign(s.mi, s.chainID, s.key)
		if err != nil {
			panic(fmt.Sprintf("vector %q: sign: %v", s.name, err))
		}

		v := vector{
			Name:                 s.name,
			ChainID:              hexUint(s.chainID),
			TeeSignerPrivateKey:  fmt.Sprintf("0x%064x", s.key.D),
			MatchID:              s.mi.MatchID.Hex(),
			Escrow:               s.mi.Escrow.Hex(),
			Taker:                s.mi.Taker.Hex(),
			Maker:                s.mi.Maker.Hex(),
			AmountFxrp:           hexBig(s.mi.AmountFxrp),
			PriceUsd18:           hexBig(s.mi.PriceUsd18),
			TakerXrplAddress:     s.mi.TakerXrplAddress,
			InstructionExpiresAt: hexUint(s.mi.InstructionExpiresAt),
			AbiEncoded:           "0x" + common.Bytes2Hex(signed.AbiEncoded),
			DataHash:             signed.DataHash.Hex(),
			EthSignedDigest:      signed.EthSignedDig.Hex(),
			Signature:            "0x" + common.Bytes2Hex(signed.Signature),
			ExpectedSigner:       signed.Signer.Hex(),
		}
		out.Vectors = append(out.Vectors, v)
	}
	out.Count = len(out.Vectors)

	repoRoot, err := findRepoRoot()
	if err != nil {
		panic(err)
	}
	outPath := filepath.Join(repoRoot, "contracts", "test", "vectors", "matchinstruction.json")
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		panic(err)
	}

	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		panic(err)
	}
	b = append(b, '\n')
	if err := os.WriteFile(outPath, b, 0o644); err != nil {
		panic(err)
	}
	fmt.Printf("wrote %d vectors to %s\n", len(out.Vectors), outPath)
}

// findRepoRoot walks up from the current working directory looking for go.work or the
// contracts/foundry.toml marker, so `go run ./cmd/genvectors` works regardless of cwd depth.
func findRepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "contracts", "foundry.toml")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("genvectors: could not locate repo root (contracts/foundry.toml not found)")
		}
		dir = parent
	}
}
