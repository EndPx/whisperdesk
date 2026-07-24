package fcewire

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"

	instruction "github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"

	"wd-matcher"
)

// Result is the subset of teetypes.ActionResult a WD_RFQ handler produces. The caller (the
// scaffold's internal/extension/extension.go glue, mirroring the existing buildResult() pattern for
// GREETING) fills in ID/SubmissionTag/Version from the enclosing teetypes.Action — those fields
// belong to the transport envelope, not to this package's business logic.
type Result struct {
	OPType    common.Hash
	OPCommand common.Hash
	Status    uint8
	Data      []byte
	Log       string
}

// Handler is the WD_RFQ opType handler: routes RFQ_SUBMIT / QUOTE_SUBMIT / RFQ_MATCH to the sealed
// matcher.SealedBook, per the fixed ingress binding in docs/design.md §4.2.
type Handler struct {
	cfg   Config
	book  *matcher.SealedBook
	sign  *SignClient
	chain Snapshotter
}

// NewHandler wires a Handler. book is typically matcher.NewSealedBook(randomEpoch); sign is a
// *SignClient (or any *SignClient-shaped fake in tests); chain is a Snapshotter (*ChainCache in
// production).
func NewHandler(cfg Config, book *matcher.SealedBook, sign *SignClient, chain Snapshotter) *Handler {
	return &Handler{cfg: cfg, book: book, sign: sign, chain: chain}
}

var (
	envelopeArgs = abi.Arguments{{Type: addressTy}, {Type: mustBytesType()}}
	rfqIDArgs    = abi.Arguments{{Type: mustBytes32Type()}}
)

func mustBytesType() abi.Type {
	t, err := abi.NewType("bytes", "", nil)
	if err != nil {
		panic(err)
	}
	return t
}

func mustBytes32Type() abi.Type {
	t, err := abi.NewType("bytes32", "", nil)
	if err != nil {
		panic(err)
	}
	return t
}

// HandleInstruction processes an onchain-instruction-ingress WD_RFQ action (RFQ_SUBMIT or
// RFQ_MATCH — the two commands bound to this ingress per docs/design.md §4.2's table). Any other
// OPCommand landing here (e.g. a hypothetical QUOTE_SUBMIT-over-instruction) is WD_ERR_PATH.
func (h *Handler) HandleInstruction(df *instruction.DataFixed) Result {
	switch {
	case df.OPCommand == opHash(OPCommandRfqSubmit):
		return h.handleRfqSubmit(df)
	case df.OPCommand == opHash(OPCommandRfqMatch):
		return h.handleMatchFromInstruction(df)
	default:
		return errResult(df.OPType, df.OPCommand, ErrPath)
	}
}

// HandleDirect processes a POST /direct-ingress WD_RFQ action: QUOTE_SUBMIT (canonical), RFQ_MATCH
// (gas-free demo keeper fallback, gated by cfg.AllowDirectMatch), and — gated by cfg.AllowDirectRfq,
// disabled by default — RFQ_SUBMIT (demo-only ingress; see PROTOCOL.md "Demo ingress
// (WD_ALLOW_DIRECT_RFQ)"). Any other OPCommand, or RFQ_SUBMIT/RFQ_MATCH while their gate is off, is
// WD_ERR_PATH.
func (h *Handler) HandleDirect(di *teetypes.DirectInstruction) Result {
	switch {
	case di.OPCommand == opHash(OPCommandQuoteSubmit):
		return h.handleQuoteSubmit(di)
	case di.OPCommand == opHash(OPCommandRfqMatch):
		if !h.cfg.AllowDirectMatch {
			return errResult(di.OPType, di.OPCommand, ErrPath)
		}
		return h.handleMatchFromDirect(di)
	case di.OPCommand == opHash(OPCommandRfqSubmit):
		if !h.cfg.AllowDirectRfq {
			return errResult(di.OPType, di.OPCommand, ErrPath)
		}
		return h.handleRfqSubmitFromDirect(di)
	default:
		return errResult(di.OPType, di.OPCommand, ErrPath)
	}
}

// --- RFQ_SUBMIT (onchain instruction only) ------------------------------------------------------

func (h *Handler) handleRfqSubmit(df *instruction.DataFixed) Result {
	sender, ciphertext, err := decodeRfqEnvelope(df.OriginalMessage)
	if err != nil {
		return errResult(df.OPType, df.OPCommand, ErrDecode)
	}

	plaintext, err := h.sign.Decrypt(ciphertext)
	if err != nil {
		return errResult(df.OPType, df.OPCommand, ErrDecrypt)
	}

	depadded, err := depad(plaintext, h.cfg.PadSize)
	if err != nil {
		return errResult(df.OPType, df.OPCommand, ErrPad)
	}

	var rfq RfqPlaintext
	dec := json.NewDecoder(bytes.NewReader(depadded))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&rfq); err != nil {
		return errResult(df.OPType, df.OPCommand, ErrDecode)
	}

	if rfq.V != 1 {
		return errResult(df.OPType, df.OPCommand, ErrDecode)
	}
	if rfq.Side != "SELL_FXRP" {
		return errResult(df.OPType, df.OPCommand, ErrSide)
	}
	if !common.IsHexAddress(rfq.Taker) {
		return errResult(df.OPType, df.OPCommand, ErrDecode)
	}
	// plaintext.taker MUST equal the chain-authenticated envelope sender (docs/design.md §5.3) —
	// the inner field only prevents blob-swap confusion; the enclave takes party identity ONLY
	// from the envelope, never from decrypted plaintext.
	if common.HexToAddress(rfq.Taker) != sender {
		return errResult(df.OPType, df.OPCommand, ErrAuth)
	}
	if rfq.XrplAddress == "" {
		return errResult(df.OPType, df.OPCommand, ErrDecode)
	}

	amount, ok := new(big.Int).SetString(rfq.FxrpAmountRaw, 10)
	if !ok || amount.Sign() < 0 || !amount.IsUint64() {
		return errResult(df.OPType, df.OPCommand, ErrDecode)
	}
	limit, ok := new(big.Int).SetString(rfq.LimitPriceUsdE18, 10)
	if !ok {
		return errResult(df.OPType, df.OPCommand, ErrDecode)
	}

	cfgM := matcher.Config{MinBlockFxrpRaw: h.cfg.MinBlockFxrpRaw, BandBips: h.cfg.BandBips, QuoteTTLSec: h.cfg.QuoteTTLSec}
	rfqID := df.InstructionID // rfqId == instructionId of the RFQ_SUBMIT instruction (docs/design.md §4.3)

	added, err := h.book.AddRFQ(cfgM, rfqID, sender, amount.Uint64(), limit, rfq.XrplAddress, time.Now(),
		h.cfg.RfqWindowSec, h.cfg.RfqTTLSec)
	if err != nil {
		return errResult(df.OPType, df.OPCommand, mapAddRFQErr(err))
	}

	h.chain.TrackTaker(sender)

	ack := RfqAck{RfqID: rfqID.Hex(), WindowEndsAt: uint64(added.WindowEndsAt.Unix())}
	data, _ := json.Marshal(ack)
	return okResult(df.OPType, df.OPCommand, data)
}

// decodeRfqEnvelope decodes message = abi.encode(address msg.sender, bytes ciphertext) — written by
// WhisperDeskInstructionSender.submitRfq (docs/design.md §3.10/§5.3): SENDER BINDING IS LOAD-BEARING
// SECURITY, since DataFixed itself carries no onchain sender.
func decodeRfqEnvelope(data []byte) (common.Address, []byte, error) {
	vals, err := envelopeArgs.Unpack(data)
	if err != nil || len(vals) != 2 {
		return common.Address{}, nil, fmt.Errorf("fcewire: decode RFQ envelope: %w", err)
	}
	sender, ok1 := vals[0].(common.Address)
	ciphertext, ok2 := vals[1].([]byte)
	if !ok1 || !ok2 {
		return common.Address{}, nil, fmt.Errorf("fcewire: decode RFQ envelope: unexpected types")
	}
	return sender, ciphertext, nil
}

// handleRfqSubmitFromDirect is the demo-only /direct RFQ_SUBMIT ingress (cfg.AllowDirectRfq —
// PROTOCOL.md "Demo ingress (WD_ALLOW_DIRECT_RFQ)"). It reuses handleRfqSubmit's decrypt+decode+
// AddRFQ logic verbatim — no duplicated logic — by wrapping di.Message in a synthetic
// instruction.DataFixed carrying only the four fields handleRfqSubmit actually reads
// (OPType/OPCommand/OriginalMessage/InstructionID); every other DataFixed field stays zero-valued
// and unused on this path.
//
// There is no onchain instruction here, so two things the canonical ingress gets for free don't
// apply the same way: (1) InstructionID — normally the mined instruction's id — is instead derived
// deterministically from the envelope bytes, so rfqId is only knowable from the returned RfqAck,
// never chosen upfront by the caller; (2) the envelope's "sender" (di.Message is still
// abi.encode(address sender, bytes ciphertext), decoded by the same decodeRfqEnvelope) is whatever
// address the caller put in that ABI encoding — self-attested, not an onchain-authenticated
// msg.sender. handleRfqSubmit's existing rfq.Taker == sender check still runs, but on this ingress
// it only proves the plaintext and envelope agree with each other, not that either is real. This is
// the accepted trade-off of this demo path — see PROTOCOL.md.
func (h *Handler) handleRfqSubmitFromDirect(di *teetypes.DirectInstruction) Result {
	df := &instruction.DataFixed{
		InstructionID:   crypto.Keccak256Hash(di.Message),
		OPType:          di.OPType,
		OPCommand:       di.OPCommand,
		OriginalMessage: di.Message,
	}
	return h.handleRfqSubmit(df)
}

// --- QUOTE_SUBMIT (POST /direct only) -----------------------------------------------------------

func (h *Handler) handleQuoteSubmit(di *teetypes.DirectInstruction) Result {
	plaintext, err := h.sign.Decrypt(di.Message)
	if err != nil {
		return errResult(di.OPType, di.OPCommand, ErrDecrypt)
	}

	depadded, err := depad(plaintext, h.cfg.PadSize)
	if err != nil {
		return errResult(di.OPType, di.OPCommand, ErrPad)
	}

	var q QuotePlaintext
	dec := json.NewDecoder(bytes.NewReader(depadded))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&q); err != nil {
		return errResult(di.OPType, di.OPCommand, ErrDecode)
	}
	if q.V != 1 {
		return errResult(di.OPType, di.OPCommand, ErrDecode)
	}
	if len(q.RfqID) != 66 || !common.IsHexAddress(q.Maker) { // 66 == len("0x" + 64 hex chars)
		return errResult(di.OPType, di.OPCommand, ErrDecode)
	}

	rfqID := common.HexToHash(q.RfqID)
	maker := common.HexToAddress(q.Maker)

	price, ok1 := new(big.Int).SetString(q.PriceUsdE18, 10)
	maxSize, ok2 := new(big.Int).SetString(q.MaxFxrpRaw, 10)
	nonce, ok3 := new(big.Int).SetString(q.Nonce, 10)
	if !ok1 || !ok2 || !ok3 || price.Sign() <= 0 || maxSize.Sign() < 0 || !maxSize.IsUint64() || nonce.Sign() < 0 || !nonce.IsUint64() {
		return errResult(di.OPType, di.OPCommand, ErrDecode)
	}

	sig, err := decodeHex(q.Sig)
	if err != nil || len(sig) != 65 {
		return errResult(di.OPType, di.OPCommand, ErrDecode)
	}

	// Maker quote authentication: EIP-712 signature over the Quote struct (docs/design.md §6.2).
	// matcher.UpsertQuote deliberately does not perform this itself (book.go: "Caller ... is
	// responsible for the EIP-712 signature + bond checks") — this is that caller.
	if err := VerifyQuoteSignature(h.cfg.ChainID, h.cfg.EscrowAddr, rfqID, maker, price, maxSize, nonce, sig); err != nil {
		return errResult(di.OPType, di.OPCommand, ErrAuth)
	}

	replaced, err := h.book.UpsertQuote(rfqID, maker, price, maxSize.Uint64(), nonce.Uint64(), time.Now())
	if err != nil {
		return errResult(di.OPType, di.OPCommand, mapUpsertErr(err))
	}

	h.chain.TrackMaker(maker)

	ack := QuoteAck{RfqID: rfqID.Hex(), Accepted: true, Replaced: replaced}
	data, _ := json.Marshal(ack)
	return okResult(di.OPType, di.OPCommand, data)
}

// --- RFQ_MATCH (onchain instruction canonical; /direct fallback iff AllowDirectMatch) -----------

func (h *Handler) handleMatchFromInstruction(df *instruction.DataFixed) Result {
	rfqID, err := decodeRfqID(df.OriginalMessage)
	if err != nil {
		return errResult(df.OPType, df.OPCommand, ErrDecode)
	}
	return h.handleMatch(df.OPType, df.OPCommand, rfqID)
}

func (h *Handler) handleMatchFromDirect(di *teetypes.DirectInstruction) Result {
	// The /direct fallback carries the same payload shape as the canonical onchain instruction: a
	// raw (unencrypted) bytes32 rfqId. RFQ_MATCH triggers carry no secret data — the rfqId is
	// already public (emitted onchain by SealedRfqSubmitted) — so no ECIES/EIP-712 step applies
	// here; see PROTOCOL.md "RFQ_MATCH /direct fallback payload".
	rfqID, err := decodeRfqID(di.Message)
	if err != nil {
		return errResult(di.OPType, di.OPCommand, ErrDecode)
	}
	return h.handleMatch(di.OPType, di.OPCommand, rfqID)
}

func decodeRfqID(data []byte) (common.Hash, error) {
	if len(data) == 32 {
		return common.BytesToHash(data), nil
	}
	vals, err := rfqIDArgs.Unpack(data)
	if err != nil || len(vals) != 1 {
		return common.Hash{}, fmt.Errorf("fcewire: decode rfqId: %w", err)
	}
	b, ok := vals[0].([32]byte)
	if !ok {
		return common.Hash{}, fmt.Errorf("fcewire: decode rfqId: unexpected type")
	}
	return common.BytesToHash(b[:]), nil
}

func (h *Handler) handleMatch(opType, opCommand common.Hash, rfqID common.Hash) Result {
	taker, makers, err := h.book.Participants(rfqID)
	if err != nil {
		return errResult(opType, opCommand, mapMatchErr(err))
	}

	now := time.Now()
	snap := h.chain.Snapshot(taker, makers, now)

	cfgM := matcher.Config{MinBlockFxrpRaw: h.cfg.MinBlockFxrpRaw, BandBips: h.cfg.BandBips, QuoteTTLSec: h.cfg.QuoteTTLSec}
	outcome, err := matcher.MatchWithSigner(h.book, cfgM, h.cfg.EscrowAddr, h.cfg.ChainID, h.sign.Sign, rfqID, snap, now)
	if err != nil {
		return errResult(opType, opCommand, mapMatchErr(err))
	}

	data, err := json.Marshal(outcome)
	if err != nil {
		return errResult(opType, opCommand, ErrSign)
	}
	return okResult(opType, opCommand, data)
}

// --- helpers -------------------------------------------------------------------------------------

// depad strips the docs/design.md §5.3 fixed-size trailing-space padding, rejecting any plaintext
// whose length isn't exactly size (WD_ERR_PAD) — calldata/ciphertext length must never leak
// order-size magnitude, so the engine enforces the fixed size rather than trusting the client.
func depad(b []byte, size int) ([]byte, error) {
	if len(b) != size {
		return nil, fmt.Errorf("fcewire: plaintext length %d != required pad size %d", len(b), size)
	}
	return bytes.TrimRight(b, " "), nil
}

// decodeHex accepts both "0x"-prefixed and bare hex strings (client libraries differ on whether
// they prefix a signature hex string).
func decodeHex(s string) ([]byte, error) {
	if !strings.HasPrefix(s, "0x") && !strings.HasPrefix(s, "0X") {
		s = "0x" + s
	}
	return hexutil.Decode(s)
}

func opHash(s string) common.Hash {
	// Byte-identical right-pad-32B scheme to teeutils.ToHash — duplicated here (rather than
	// depending on tee-node/pkg/utils for a one-liner) so fcewire's routing constants are defined
	// purely in terms of the go-ethereum common package. See PROTOCOL.md for the verification that
	// this matches teeutils.ToHash exactly.
	var b [32]byte
	copy(b[:], []byte(s))
	return b
}

func errResult(opType, opCommand common.Hash, code string) Result {
	return Result{OPType: opType, OPCommand: opCommand, Status: 0, Data: nil, Log: code}
}

func okResult(opType, opCommand common.Hash, data []byte) Result {
	return Result{OPType: opType, OPCommand: opCommand, Status: 1, Data: data, Log: "ok"}
}

func mapAddRFQErr(err error) string {
	switch {
	case errors.Is(err, matcher.ErrBelowMinBlock):
		return ErrMinSize
	default:
		return ErrDecode
	}
}

func mapUpsertErr(err error) string {
	switch {
	case errors.Is(err, matcher.ErrRfqUnknown):
		return ErrRfqUnknown
	case strings.Contains(err.Error(), "WD_ERR_STALE_NONCE"):
		return ErrStaleNonce
	default:
		return ErrDecode
	}
}

func mapMatchErr(err error) string {
	switch {
	case errors.Is(err, matcher.ErrRfqUnknown):
		return ErrRfqUnknown
	case errors.Is(err, matcher.ErrWindowOpen):
		return ErrWindowOpen
	case errors.Is(err, matcher.ErrPriceStale):
		return ErrPriceStale
	default:
		return ErrSign
	}
}
