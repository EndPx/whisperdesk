package matcher

import (
	"encoding/json"
	"math/big"
	"os"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// vectorsPath is relative to this package's directory (extension/matcher), which is `go test`'s
// working directory by default — mirrors contracts/test/GoldenVectors.t.sol reading the exact
// same file, so both languages assert against one single source of truth (Step 4 DoD).
const vectorsPath = "../../contracts/test/vectors/matchinstruction.json"

type vectorFile struct {
	Description string   `json:"description"`
	WDMatchTag  string   `json:"wdMatchTag"`
	Vectors     []vector `json:"vectors"`
}

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

func mustHexUint64(t *testing.T, s string) uint64 {
	t.Helper()
	s = strings.TrimPrefix(s, "0x")
	if s == "" {
		s = "0"
	}
	v, ok := new(big.Int).SetString(s, 16)
	if !ok {
		t.Fatalf("bad hex uint64 %q", s)
	}
	return v.Uint64()
}

func mustHexBig(t *testing.T, s string) *big.Int {
	t.Helper()
	s = strings.TrimPrefix(s, "0x")
	if s == "" {
		s = "0"
	}
	v, ok := new(big.Int).SetString(s, 16)
	if !ok {
		t.Fatalf("bad hex big.Int %q", s)
	}
	return v
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	b, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatalf("reading %s: %v (run `go run ./cmd/genvectors` first)", vectorsPath, err)
	}
	var vf vectorFile
	if err := json.Unmarshal(b, &vf); err != nil {
		t.Fatalf("unmarshaling %s: %v", vectorsPath, err)
	}
	if len(vf.Vectors) == 0 {
		t.Fatalf("%s has zero vectors", vectorsPath)
	}
	return vf
}

// TestWDMatchTag pins WDMatchTag() against the vectors file's recorded value — a change to the
// domain tag is exactly the kind of drift the whole vectors mechanism exists to catch early.
func TestWDMatchTag(t *testing.T) {
	vf := loadVectors(t)
	tag := WDMatchTag()
	got := "0x" + common.Bytes2Hex(tag[:])
	if !strings.EqualFold(got, vf.WDMatchTag) {
		t.Fatalf("WDMatchTag() = %s, vectors file says %s", got, vf.WDMatchTag)
	}
}

// TestGoldenVectors_MatchInstruction asserts the Go encoder/hasher/signer reproduce every
// recorded field byte-for-byte, AND that a freshly-computed Sign() over the vector's own
// MatchInstruction+key reproduces the exact same bytes — i.e. this is not just "the vectors file
// is internally consistent" but "today's Go code still produces exactly what was committed."
func TestGoldenVectors_MatchInstruction(t *testing.T) {
	vf := loadVectors(t)

	for _, v := range vf.Vectors {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			chainID := mustHexUint64(t, v.ChainID)

			keyBytes := common.FromHex(v.TeeSignerPrivateKey)
			privKey, err := crypto.ToECDSA(keyBytes)
			if err != nil {
				t.Fatalf("parsing teeSignerPrivateKey: %v", err)
			}

			mi := MatchInstruction{
				MatchID:              common.HexToHash(v.MatchID),
				Escrow:               common.HexToAddress(v.Escrow),
				Taker:                common.HexToAddress(v.Taker),
				Maker:                common.HexToAddress(v.Maker),
				AmountFxrp:           mustHexBig(t, v.AmountFxrp),
				PriceUsd18:           mustHexBig(t, v.PriceUsd18),
				TakerXrplAddress:     v.TakerXrplAddress,
				InstructionExpiresAt: mustHexUint64(t, v.InstructionExpiresAt),
			}

			signed, err := Sign(mi, chainID, privKey)
			if err != nil {
				t.Fatalf("Sign: %v", err)
			}

			wantAbiEncoded := common.FromHex(v.AbiEncoded)
			if common.Bytes2Hex(signed.AbiEncoded) != common.Bytes2Hex(wantAbiEncoded) {
				t.Fatalf("abiEncoded mismatch:\n got  0x%x\n want %s", signed.AbiEncoded, v.AbiEncoded)
			}

			if !strings.EqualFold(signed.DataHash.Hex(), v.DataHash) {
				t.Fatalf("dataHash mismatch: got %s want %s", signed.DataHash.Hex(), v.DataHash)
			}
			// DataHash must also equal the standalone DataHash() helper over the encoded bytes —
			// cross-checks the two call sites stay in sync.
			if standalone := DataHash(signed.AbiEncoded); standalone != signed.DataHash {
				t.Fatalf("DataHash(AbiEncoded) = %s, Sign()'s DataHash = %s", standalone.Hex(), signed.DataHash.Hex())
			}

			if !strings.EqualFold(signed.EthSignedDig.Hex(), v.EthSignedDigest) {
				t.Fatalf("ethSignedDigest mismatch: got %s want %s", signed.EthSignedDig.Hex(), v.EthSignedDigest)
			}
			// Cross-check against the independent hand-rolled EthSignedDigest() implementation too.
			if standalone := EthSignedDigest(signed.DataHash, chainID); standalone != signed.EthSignedDig {
				t.Fatalf("EthSignedDigest(dataHash,chainId) = %s, Sign()'s digest = %s", standalone.Hex(), signed.EthSignedDig.Hex())
			}

			wantSig := common.FromHex(v.Signature)
			if common.Bytes2Hex(signed.Signature) != common.Bytes2Hex(wantSig) {
				t.Fatalf("signature mismatch:\n got  0x%x\n want %s", signed.Signature, v.Signature)
			}
			if len(signed.Signature) != 65 {
				t.Fatalf("signature length = %d, want 65", len(signed.Signature))
			}
			vByte := signed.Signature[64]
			if vByte != 27 && vByte != 28 {
				t.Fatalf("signature V = %d, want 27 or 28", vByte)
			}

			wantSigner := common.HexToAddress(v.ExpectedSigner)
			if signed.Signer != wantSigner {
				t.Fatalf("recovered signer = %s, want %s", signed.Signer.Hex(), wantSigner.Hex())
			}
			if privAddr := crypto.PubkeyToAddress(privKey.PublicKey); privAddr != wantSigner {
				t.Fatalf("teeSignerPrivateKey's address = %s, vector's expectedSigner = %s (vector is internally inconsistent)",
					privAddr.Hex(), wantSigner.Hex())
			}

			// Independent Recover() path (the one downstream consumers would call given only a
			// digest+signature, without going through Sign() again) must agree too.
			recovered, err := Recover(signed.EthSignedDig, signed.Signature)
			if err != nil {
				t.Fatalf("Recover: %v", err)
			}
			if recovered != wantSigner {
				t.Fatalf("Recover() = %s, want %s", recovered.Hex(), wantSigner.Hex())
			}
		})
	}
}

// TestGoldenVectors_RejectsTamperedSignature is a negative control: flipping one byte of a
// vector's signature must NOT recover the expected signer — guards against a vacuously-true
// comparison bug in the harness above.
func TestGoldenVectors_RejectsTamperedSignature(t *testing.T) {
	vf := loadVectors(t)
	v := vf.Vectors[0]

	sig := common.FromHex(v.Signature)
	tampered := append([]byte(nil), sig...)
	tampered[0] ^= 0xFF // flip a byte of R

	digest := common.HexToHash(v.EthSignedDigest)
	recovered, err := Recover(digest, tampered)
	wantSigner := common.HexToAddress(v.ExpectedSigner)
	if err == nil && recovered == wantSigner {
		t.Fatalf("tampered signature still recovered the expected signer — negative control is broken")
	}
}
