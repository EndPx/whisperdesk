// Package wire implements the client side of the WD_RFQ wire protocol documented in
// extension/fcewire/PROTOCOL.md — opType/opCommand hashing, plaintext padding, and the plaintext
// JSON payload shapes (RFQ / Quote / Match / RfqAck / QuoteAck / MatchResponse). Kept dependency-
// light: only stdlib + go-ethereum/common + tee-node/pkg/utils (for the canonical ToHash).
package wire

import (
	"bytes"
	"fmt"

	"github.com/ethereum/go-ethereum/common"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"
)

// OpType is the single WhisperDesk opType (PROTOCOL.md §1).
const OpType = "WD_RFQ"

// OpCommand string constants (PROTOCOL.md §1/§2).
const (
	OpCommandRFQSubmit   = "RFQ_SUBMIT"
	OpCommandQuoteSubmit = "QUOTE_SUBMIT"
	OpCommandRFQMatch    = "RFQ_MATCH"
)

// PadSize is WD_PAD_SIZE (design.md §4.9/§5.3): every WD_RFQ plaintext is padded with trailing
// ASCII spaces to exactly this many bytes before ECIES sealing. The engine rejects any other
// length with WD_ERR_PAD.
const PadSize = 512

// Hash is a thin re-export of teeutils.ToHash — the single right-pad-32B hashing scheme every
// opType/opCommand string in this protocol uses (PROTOCOL.md §1). Exposed generically so callers
// (e.g. the `submit` subcommand's --op-type/--op-command flags) can hash arbitrary strings, not
// just the named constants below.
func Hash(s string) common.Hash { return teeutils.ToHash(s) }

// OpTypeHash returns Hash(OpType) — PROTOCOL.md §1: always call teeutils.ToHash live, never
// hand-copy the hex literal.
func OpTypeHash() common.Hash { return Hash(OpType) }

// OpCommandHash returns Hash(cmd) for one of the OpCommand* constants above (or any other string —
// kept generic for the same reason as Hash).
func OpCommandHash(cmd string) common.Hash { return Hash(cmd) }

// Pad space-pads plaintext to exactly PadSize bytes (design.md §5.3). Returns an error if
// plaintext is already longer than PadSize — the engine would reject it either way, and silently
// truncating would corrupt the JSON.
func Pad(plaintext []byte) ([]byte, error) {
	if len(plaintext) > PadSize {
		return nil, fmt.Errorf("wire: Pad: plaintext is %d bytes, exceeds WD_PAD_SIZE=%d", len(plaintext), PadSize)
	}
	if len(plaintext) == PadSize {
		return plaintext, nil
	}
	out := make([]byte, PadSize)
	copy(out, plaintext)
	for i := len(plaintext); i < PadSize; i++ {
		out[i] = ' '
	}
	return out, nil
}

// Unpad strips trailing ASCII spaces (the inverse of Pad) — used only for tests/debugging; the
// real engine consumes padded plaintext directly (json.Unmarshal ignores trailing whitespace).
func Unpad(padded []byte) []byte {
	return bytes.TrimRight(padded, " ")
}

// RFQPlaintext is the RFQ_SUBMIT plaintext payload (PROTOCOL.md §5.1 / design.md §6.1).
type RFQPlaintext struct {
	V                int    `json:"v"`
	Taker            string `json:"taker"`
	Side             string `json:"side"`
	FxrpAmountRaw    string `json:"fxrpAmountRaw"`
	LimitPriceUsdE18 string `json:"limitPriceUsdE18"`
	XrplAddress      string `json:"xrplAddress"`
}

// QuotePlaintext is the QUOTE_SUBMIT plaintext payload (PROTOCOL.md §5.2 / design.md §6.2).
type QuotePlaintext struct {
	V           int    `json:"v"`
	RfqID       string `json:"rfqId"`
	Maker       string `json:"maker"`
	PriceUsdE18 string `json:"priceUsdE18"`
	MaxFxrpRaw  string `json:"maxFxrpRaw"`
	Nonce       string `json:"nonce"`
	Sig         string `json:"sig"`
}

// MatchTriggerMessage builds the RFQ_MATCH `/direct` message payload — CONFIRMED against the real
// handler (extension/fcewire/handler.go's decodeRfqID / handleMatchFromDirect), NOT the padded-
// JSON-then-ECIES shape PROTOCOL.md originally assumed before that handler existed: the message is
// the bare 32-byte rfqId, raw (or ABI-encoded bytes32, which is byte-identical for a single static
// bytes32 argument — no head/tail encoding applies). No JSON, no WD_PAD_SIZE padding, no ECIES —
// RFQ_MATCH triggers carry no secret (the rfqId is already public), so the handler skips
// SignClient.Decrypt entirely for this command. See PROTOCOL.md §5.3.
func MatchTriggerMessage(rfqID common.Hash) []byte {
	return rfqID.Bytes()
}

// RfqAck is the RFQ_SUBMIT success response payload (design.md §6.4).
type RfqAck struct {
	RfqID        string `json:"rfqId"`
	WindowEndsAt uint64 `json:"windowEndsAt"`
}

// QuoteAck is the QUOTE_SUBMIT success response payload (design.md §6.4).
type QuoteAck struct {
	RfqID    string `json:"rfqId"`
	Accepted bool   `json:"accepted"`
	Replaced bool   `json:"replaced"`
}

// MatchWire is the decoded-fields view of a matched MatchInstruction (design.md §6.4).
type MatchWire struct {
	MatchID              string `json:"matchId"`
	Escrow               string `json:"escrow"`
	Taker                string `json:"taker"`
	Maker                string `json:"maker"`
	AmountFxrp           string `json:"amountFxrp"`
	PriceUsd18           string `json:"priceUsd18"`
	TakerXrplAddress     string `json:"takerXrplAddress"`
	InstructionExpiresAt uint64 `json:"instructionExpiresAt"`
}

// MatchResponse is the RFQ_MATCH success response payload (design.md §6.4).
type MatchResponse struct {
	Outcome      string         `json:"outcome"` // "MATCHED" | "NO_MATCH"
	Reasons      map[string]int `json:"reasons,omitempty"`
	Match        *MatchWire     `json:"match,omitempty"`
	AbiEncoded   string         `json:"abiEncoded,omitempty"`
	TeeSignature string         `json:"teeSignature,omitempty"`
}
