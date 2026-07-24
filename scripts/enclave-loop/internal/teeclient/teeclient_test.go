package teeclient

import (
	"bytes"
	"testing"

	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"

	"github.com/ethereum/go-ethereum/crypto"
)

// TestEncryptDecryptRoundTrip proves the exact wire format wd-client's `encrypt` subcommand
// produces (Encrypt, which is a thin wrapper over tee-node/pkg/utils.Encrypt — go-ethereum
// crypto/ecies, ECIES_AES128_SHA256) round-trips through tee-node/pkg/utils.Decrypt (the same
// primitive the real enclave's POST /decrypt handler calls, per tee-node's
// internal/extension/server/server.go decryptWithTeeHandler -> node.Decrypt -> utils.Decrypt) —
// against a locally-generated key, with no network dependency. This is the "golden-vector
// round-trip" acceptance gate design.md §5.3 requires, applied to the Go client side.
func TestEncryptDecryptRoundTrip(t *testing.T) {
	privKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generating key: %v", err)
	}

	info := &Info{}
	info.TeeInfo.PublicKey = teetypes.PubKeyToStruct(&privKey.PublicKey)

	plaintext := bytes.Repeat([]byte{'a'}, 512) // WD_PAD_SIZE-shaped payload, but Encrypt itself
	// doesn't care about padding — that's wire.Pad's job, exercised separately in the wire package.
	// Use a realistic small JSON body too, to make sure short plaintexts round-trip as well.
	plaintextSmall := []byte(`{"v":1,"taker":"0x00000000000000000000000000000000000ea1"}`)

	for _, pt := range [][]byte{plaintext, plaintextSmall} {
		ciphertext, err := Encrypt(pt, info)
		if err != nil {
			t.Fatalf("Encrypt: %v", err)
		}
		if len(ciphertext) <= len(pt) {
			t.Fatalf("Encrypt: ciphertext (%d bytes) should be longer than plaintext (%d bytes) — missing ECIES overhead?",
				len(ciphertext), len(pt))
		}

		decrypted, err := teeutils.Decrypt(ciphertext, privKey)
		if err != nil {
			t.Fatalf("Decrypt: %v", err)
		}
		if !bytes.Equal(decrypted, pt) {
			t.Fatalf("round-trip mismatch: got %q, want %q", decrypted, pt)
		}
	}
}

// TestEncryptFailsForWrongKey proves ciphertext sealed to one key does not decrypt under another
// — a basic sanity check that Encrypt is actually binding to the supplied pubkey, not silently
// ignoring it.
func TestEncryptFailsForWrongKey(t *testing.T) {
	rightKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generating key: %v", err)
	}
	wrongKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generating key: %v", err)
	}

	info := &Info{}
	info.TeeInfo.PublicKey = teetypes.PubKeyToStruct(&rightKey.PublicKey)

	ciphertext, err := Encrypt([]byte("hello enclave"), info)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}

	if _, err := teeutils.Decrypt(ciphertext, wrongKey); err == nil {
		t.Fatalf("Decrypt: expected an error decrypting under the wrong key, got nil")
	}
}
