package wire

import (
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

// rightPad32 re-derives Solidity's bytes32("...") scheme from first principles (ASCII bytes,
// right-padded with zeros to 32B) — deliberately independent of teeutils.ToHash so the test below
// is not a tautology (it would pass even if ToHash silently changed behavior, if we just called
// ToHash again to build the expected value).
func rightPad32(s string) common.Hash {
	var b [32]byte
	copy(b[:], []byte(s))
	return b
}

func TestOpTypeAndOpCommandHashes(t *testing.T) {
	cases := []struct {
		name string
		got  common.Hash
		s    string
	}{
		{"opType WD_RFQ", OpTypeHash(), OpType},
		{"opCommand RFQ_SUBMIT", OpCommandHash(OpCommandRFQSubmit), OpCommandRFQSubmit},
		{"opCommand QUOTE_SUBMIT", OpCommandHash(OpCommandQuoteSubmit), OpCommandQuoteSubmit},
		{"opCommand RFQ_MATCH", OpCommandHash(OpCommandRFQMatch), OpCommandRFQMatch},
	}
	for _, c := range cases {
		want := rightPad32(c.s)
		if c.got != want {
			t.Fatalf("%s: got %s, want %s (right-pad-32 of %q)", c.name, c.got.Hex(), want.Hex(), c.s)
		}
		if !strings.HasPrefix(c.got.Hex(), "0x") {
			t.Fatalf("%s: hash %s missing 0x prefix", c.name, c.got.Hex())
		}
	}
}

func TestPadRoundTrip(t *testing.T) {
	in := []byte(`{"v":1,"taker":"0xabc"}`)
	padded, err := Pad(in)
	if err != nil {
		t.Fatalf("Pad: %v", err)
	}
	if len(padded) != PadSize {
		t.Fatalf("Pad: got length %d, want %d", len(padded), PadSize)
	}
	if got := Unpad(padded); string(got) != string(in) {
		t.Fatalf("Unpad(Pad(in)) = %q, want %q", got, in)
	}
}

func TestPadRejectsOversize(t *testing.T) {
	oversized := make([]byte, PadSize+1)
	if _, err := Pad(oversized); err == nil {
		t.Fatalf("Pad: expected an error for a %d-byte plaintext (WD_PAD_SIZE=%d), got nil", len(oversized), PadSize)
	}
}

// TestMatchTriggerMessageIsRaw32Bytes locks in the confirmed (not assumed) RFQ_MATCH /direct wire
// shape from extension/fcewire/handler.go's decodeRfqID: the message is the bare 32-byte rfqId,
// nothing else — no JSON envelope, no WD_PAD_SIZE padding, no "0x" text prefix (that's applied one
// layer up, by hexutil.Bytes' own JSON marshaling of the DirectInstruction.Message field).
func TestMatchTriggerMessageIsRaw32Bytes(t *testing.T) {
	rfqID := rightPad32("some-rfq-id-does-not-need-to-look-like-anything-in-particular")
	msg := MatchTriggerMessage(rfqID)
	if len(msg) != 32 {
		t.Fatalf("MatchTriggerMessage: got %d bytes, want exactly 32", len(msg))
	}
	if got := common.BytesToHash(msg); got != rfqID {
		t.Fatalf("MatchTriggerMessage: got %x, want %x", got, rfqID)
	}
}

func TestPadExactSizeIsNoop(t *testing.T) {
	exact := make([]byte, PadSize)
	for i := range exact {
		exact[i] = 'x'
	}
	padded, err := Pad(exact)
	if err != nil {
		t.Fatalf("Pad: %v", err)
	}
	if string(padded) != string(exact) {
		t.Fatalf("Pad: exact-size input should pass through unchanged")
	}
}
