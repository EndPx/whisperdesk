package fcewire

import (
	"crypto/ecdsa"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	instruction "github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"

	"wd-matcher"
)

// --- fake sign/decrypt HTTP server (mirrors tee-node/internal/extension/server/server.go's real
// POST /sign and POST /decrypt handlers exactly — see PROTOCOL.md "Sign-port digest finding" for
// the derivation this reproduces) ------------------------------------------------------------------

func newFakeSignServerReal(t *testing.T, teeKey *ecdsa.PrivateKey) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()

	mux.HandleFunc("POST /sign", func(w http.ResponseWriter, r *http.Request) {
		var req teetypes.SignRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// Exactly tee-node's signWithTeeHandler: msgHash := keccak256(message); node.Sign(msgHash).
		msgHash := crypto.Keccak256(req.Message)
		sig, err := teeutils.Sign(msgHash, teeKey)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(teetypes.SignResponse{Message: req.Message, Signature: sig})
	})

	mux.HandleFunc("POST /decrypt", func(w http.ResponseWriter, r *http.Request) {
		var req teetypes.DecryptRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		pt, err := teeutils.Decrypt(req.EncryptedMessage, teeKey)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(teetypes.DecryptResponse{DecryptedMessage: pt})
	})

	return httptest.NewServer(mux)
}

// --- fake chain snapshot ---------------------------------------------------------------------------

type fakeSnapshotter struct {
	mid *big.Int
}

func (f *fakeSnapshotter) TrackMaker(common.Address) {}
func (f *fakeSnapshotter) TrackTaker(common.Address) {}
func (f *fakeSnapshotter) Snapshot(_ common.Address, makers []common.Address, _ time.Time) matcher.ChainSnapshot {
	bonds := make(map[common.Address]uint64, len(makers))
	for _, m := range makers {
		bonds[m] = 1_000_000_000_000 // plenty of free bond
	}
	return matcher.ChainSnapshot{
		MidE18:            f.mid,
		MidAge:            0,
		FreeBondRaw:       bonds,
		TakerAvailableRaw: 1_000_000_000_000, // plenty of armed-uncommitted balance
	}
}

// --- helpers ----------------------------------------------------------------------------------------

func padTo(b []byte, size int) []byte {
	if len(b) > size {
		panic("padTo: input longer than pad size")
	}
	out := make([]byte, size)
	copy(out, b)
	for i := len(b); i < size; i++ {
		out[i] = ' '
	}
	return out
}

// TestFullActionPath_RfqSubmit_QuoteSubmit_RfqMatch runs a full RFQ_SUBMIT -> QUOTE_SUBMIT ->
// RFQ_MATCH sequence through the real Handler against a fake sign-port/decrypt-port HTTP server and
// a fake chain snapshot, asserting (a) the sequence yields outcome=MATCHED with non-empty
// abiEncoded+teeSignature, and (b) ecrecover of the produced signature over
// MatchInstructionLib's ethSignedDigest equals the fake sign-key's address — the same
// cross-verification technique extension/smoketest/smoke_test.go uses for the raw signing
// primitive, applied here end-to-end through the actual handler dispatch path.
func TestFullActionPath_RfqSubmit_QuoteSubmit_RfqMatch(t *testing.T) {
	teeKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generating TEE key: %v", err)
	}
	teeSignerAddr := crypto.PubkeyToAddress(teeKey.PublicKey)

	server := newFakeSignServerReal(t, teeKey)
	defer server.Close()

	cfg := Config{
		ChainID:          114,
		EscrowAddr:       common.HexToAddress("0x00000000000000000000000000000000000E1E"),
		BondAddr:         common.HexToAddress("0x00000000000000000000000000000000000B0D"),
		MinBlockFxrpRaw:  1_000_000,
		BandBips:         100,
		QuoteTTLSec:      600,
		RfqWindowSec:     0, // close the auction window immediately so RFQ_MATCH can proceed in-test
		RfqTTLSec:        900,
		AllowDirectMatch: true,
		PadSize:          512,
		SignPortURL:      server.URL,
	}

	book := matcher.NewSealedBook(1)
	sign := NewSignClient(server.URL)
	chain := &fakeSnapshotter{mid: big.NewInt(1_000_000_000_000_000_000)} // 1.00 USD mid
	h := NewHandler(cfg, book, sign, chain)

	taker := common.HexToAddress("0x000000000000000000000000000000000070a1")

	// --- 1. RFQ_SUBMIT (onchain instruction ingress) -----------------------------------------
	rfqPlain := RfqPlaintext{
		V:                1,
		Taker:            taker.Hex(),
		Side:             "SELL_FXRP",
		FxrpAmountRaw:    "5000000",
		LimitPriceUsdE18: "500000000000000000", // 0.50 USD limit — well below the matched price
		XrplAddress:      "rLLsk7Ac3eDPRRPFPeeC1nCPKMWnQ38rTL",
	}
	rfqJSON, err := json.Marshal(rfqPlain)
	if err != nil {
		t.Fatalf("marshal RFQ plaintext: %v", err)
	}
	rfqCiphertext, err := teeutils.Encrypt(padTo(rfqJSON, cfg.PadSize), &teeKey.PublicKey)
	if err != nil {
		t.Fatalf("ECIES-encrypt RFQ: %v", err)
	}
	rfqEnvelope, err := envelopeArgs.Pack(taker, rfqCiphertext)
	if err != nil {
		t.Fatalf("pack RFQ envelope: %v", err)
	}

	rfqID := crypto.Keccak256Hash([]byte("test-rfq-full-path"))
	rfqDf := &instruction.DataFixed{
		InstructionID:   rfqID,
		OPType:          opHash(OPTypeWDRFQ),
		OPCommand:       opHash(OPCommandRfqSubmit),
		OriginalMessage: rfqEnvelope,
	}

	rfqResult := h.HandleInstruction(rfqDf)
	if rfqResult.Status != 1 {
		t.Fatalf("RFQ_SUBMIT: expected status 1, got %d, log=%s", rfqResult.Status, rfqResult.Log)
	}
	var rfqAck RfqAck
	if err := json.Unmarshal(rfqResult.Data, &rfqAck); err != nil {
		t.Fatalf("decode RfqAck: %v", err)
	}
	if rfqAck.RfqID != rfqID.Hex() {
		t.Fatalf("RfqAck.RfqID mismatch: got %s want %s", rfqAck.RfqID, rfqID.Hex())
	}

	// --- 2. QUOTE_SUBMIT (POST /direct ingress) --------------------------------------------
	makerKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generating maker key: %v", err)
	}
	maker := crypto.PubkeyToAddress(makerKey.PublicKey)

	price := big.NewInt(1_005_000_000_000_000_000) // 1.005 USD — inside +-1% band of 1.00 mid, beats limit
	maxFxrp := big.NewInt(10_000_000)
	nonce := big.NewInt(1)

	digest := QuoteDigest(cfg.ChainID, cfg.EscrowAddr, rfqID, maker, price, maxFxrp, nonce)
	quoteSig, err := crypto.Sign(digest[:], makerKey)
	if err != nil {
		t.Fatalf("sign quote digest: %v", err)
	}
	quoteSig[64] += 27 // normalize V to {27,28} — the wallet-signature wire convention

	quotePlain := QuotePlaintext{
		V:           1,
		RfqID:       rfqID.Hex(),
		Maker:       maker.Hex(),
		PriceUsdE18: price.String(),
		MaxFxrpRaw:  maxFxrp.String(),
		Nonce:       nonce.String(),
		Sig:         "0x" + common.Bytes2Hex(quoteSig),
	}
	quoteJSON, err := json.Marshal(quotePlain)
	if err != nil {
		t.Fatalf("marshal quote plaintext: %v", err)
	}
	quoteCiphertext, err := teeutils.Encrypt(padTo(quoteJSON, cfg.PadSize), &teeKey.PublicKey)
	if err != nil {
		t.Fatalf("ECIES-encrypt quote: %v", err)
	}

	quoteDi := &teetypes.DirectInstruction{
		OPType:    opHash(OPTypeWDRFQ),
		OPCommand: opHash(OPCommandQuoteSubmit),
		Message:   quoteCiphertext,
	}

	quoteResult := h.HandleDirect(quoteDi)
	if quoteResult.Status != 1 {
		t.Fatalf("QUOTE_SUBMIT: expected status 1, got %d, log=%s", quoteResult.Status, quoteResult.Log)
	}
	var quoteAck QuoteAck
	if err := json.Unmarshal(quoteResult.Data, &quoteAck); err != nil {
		t.Fatalf("decode QuoteAck: %v", err)
	}
	if !quoteAck.Accepted {
		t.Fatalf("expected quote to be accepted")
	}

	// --- 3. RFQ_MATCH (onchain instruction ingress) ----------------------------------------
	// A tiny real sleep guarantees time.Now() at match time is strictly after the RFQ's
	// WindowEndsAt (RfqWindowSec=0), independent of clock resolution.
	time.Sleep(5 * time.Millisecond)

	matchDf := &instruction.DataFixed{
		InstructionID:   crypto.Keccak256Hash([]byte("match-trigger")),
		OPType:          opHash(OPTypeWDRFQ),
		OPCommand:       opHash(OPCommandRfqMatch),
		OriginalMessage: rfqID.Bytes(),
	}

	matchResult := h.HandleInstruction(matchDf)
	if matchResult.Status != 1 {
		t.Fatalf("RFQ_MATCH: expected status 1, got %d, log=%s", matchResult.Status, matchResult.Log)
	}

	var outcome matcher.MatchOutcome
	if err := json.Unmarshal(matchResult.Data, &outcome); err != nil {
		t.Fatalf("decode MatchResponse: %v", err)
	}

	// (a) outcome=matched with non-empty abiEncoded+teeSignature.
	if outcome.Outcome != "MATCHED" {
		t.Fatalf("expected outcome MATCHED, got %s (reasons=%v)", outcome.Outcome, outcome.Reasons)
	}
	if outcome.AbiEncoded == "" || outcome.TeeSignature == "" {
		t.Fatalf("expected non-empty abiEncoded/teeSignature, got abiEncoded=%q teeSignature=%q",
			outcome.AbiEncoded, outcome.TeeSignature)
	}
	if outcome.Match == nil || outcome.Match.Maker != maker.Hex() {
		t.Fatalf("expected match.maker=%s, got %+v", maker.Hex(), outcome.Match)
	}

	// (b) ecrecover of the produced signature over MatchInstructionLib's ethSignedDigest equals the
	// fake sign-key's address.
	abiEncodedBytes := common.FromHex(outcome.AbiEncoded)
	sigBytes := common.FromHex(outcome.TeeSignature)
	dataHash := matcher.DataHash(abiEncodedBytes)
	ethDigest := matcher.EthSignedDigest(dataHash, cfg.ChainID)

	recovered, err := matcher.Recover(ethDigest, sigBytes)
	if err != nil {
		t.Fatalf("recovering signer: %v", err)
	}
	if recovered != teeSignerAddr {
		t.Fatalf("ecrecover mismatch: signed by %s, recovered %s", teeSignerAddr.Hex(), recovered.Hex())
	}

	// Idempotent replay via the /direct RFQ_MATCH fallback ingress: same rfqId, cached outcome.
	matchDiFallback := &teetypes.DirectInstruction{
		OPType:    opHash(OPTypeWDRFQ),
		OPCommand: opHash(OPCommandRfqMatch),
		Message:   rfqID.Bytes(),
	}
	replay := h.HandleDirect(matchDiFallback)
	if replay.Status != 1 {
		t.Fatalf("RFQ_MATCH replay via /direct: expected status 1, got %d, log=%s", replay.Status, replay.Log)
	}
	var replayOutcome matcher.MatchOutcome
	if err := json.Unmarshal(replay.Data, &replayOutcome); err != nil {
		t.Fatalf("decode replayed MatchResponse: %v", err)
	}
	if replayOutcome.AbiEncoded != outcome.AbiEncoded || replayOutcome.TeeSignature != outcome.TeeSignature {
		t.Fatalf("replayed RFQ_MATCH did not return the cached outcome byte-for-byte")
	}
}

// TestFullActionPath_Direct_RfqSubmit_QuoteSubmit_RfqMatch mirrors
// TestFullActionPath_RfqSubmit_QuoteSubmit_RfqMatch above but, with cfg.AllowDirectRfq=true, drives
// ALL THREE commands (RFQ_SUBMIT, QUOTE_SUBMIT, RFQ_MATCH) through the /direct ingress
// (Handler.HandleDirect) — the demo-only ingress documented in PROTOCOL.md "Demo ingress
// (WD_ALLOW_DIRECT_RFQ)". RFQ_SUBMIT via /direct reuses handleRfqSubmit's decrypt+decode+AddRFQ
// path unchanged (handler.go's handleRfqSubmitFromDirect just wraps di.Message in a synthetic
// instruction.DataFixed), so this test is the end-to-end proof that reuse actually works, not just
// that it compiles. There is no onchain instructionId on this ingress, so — unlike the sibling test
// above, which picks rfqID upfront — this test only learns rfqId from the RFQ_SUBMIT RfqAck.
func TestFullActionPath_Direct_RfqSubmit_QuoteSubmit_RfqMatch(t *testing.T) {
	teeKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generating TEE key: %v", err)
	}
	teeSignerAddr := crypto.PubkeyToAddress(teeKey.PublicKey)

	server := newFakeSignServerReal(t, teeKey)
	defer server.Close()

	cfg := Config{
		ChainID:          114,
		EscrowAddr:       common.HexToAddress("0x00000000000000000000000000000000000E1E"),
		BondAddr:         common.HexToAddress("0x00000000000000000000000000000000000B0D"),
		MinBlockFxrpRaw:  1_000_000,
		BandBips:         100,
		QuoteTTLSec:      600,
		RfqWindowSec:     0, // close the auction window immediately so RFQ_MATCH can proceed in-test
		RfqTTLSec:        900,
		AllowDirectMatch: true,
		AllowDirectRfq:   true,
		PadSize:          512,
		SignPortURL:      server.URL,
	}

	book := matcher.NewSealedBook(1)
	sign := NewSignClient(server.URL)
	chain := &fakeSnapshotter{mid: big.NewInt(1_000_000_000_000_000_000)} // 1.00 USD mid
	h := NewHandler(cfg, book, sign, chain)

	taker := common.HexToAddress("0x000000000000000000000000000000000070a2")

	// --- 1. RFQ_SUBMIT (demo /direct ingress, WD_ALLOW_DIRECT_RFQ) --------------------------
	rfqPlain := RfqPlaintext{
		V:                1,
		Taker:            taker.Hex(),
		Side:             "SELL_FXRP",
		FxrpAmountRaw:    "5000000",
		LimitPriceUsdE18: "500000000000000000", // 0.50 USD limit — well below the matched price
		XrplAddress:      "rLLsk7Ac3eDPRRPFPeeC1nCPKMWnQ38rTL",
	}
	rfqJSON, err := json.Marshal(rfqPlain)
	if err != nil {
		t.Fatalf("marshal RFQ plaintext: %v", err)
	}
	rfqCiphertext, err := teeutils.Encrypt(padTo(rfqJSON, cfg.PadSize), &teeKey.PublicKey)
	if err != nil {
		t.Fatalf("ECIES-encrypt RFQ: %v", err)
	}
	rfqEnvelope, err := envelopeArgs.Pack(taker, rfqCiphertext)
	if err != nil {
		t.Fatalf("pack RFQ envelope: %v", err)
	}

	rfqDi := &teetypes.DirectInstruction{
		OPType:    opHash(OPTypeWDRFQ),
		OPCommand: opHash(OPCommandRfqSubmit),
		Message:   rfqEnvelope,
	}

	rfqResult := h.HandleDirect(rfqDi)
	if rfqResult.Status != 1 {
		t.Fatalf("RFQ_SUBMIT via /direct: expected status 1, got %d, log=%s", rfqResult.Status, rfqResult.Log)
	}
	var rfqAck RfqAck
	if err := json.Unmarshal(rfqResult.Data, &rfqAck); err != nil {
		t.Fatalf("decode RfqAck: %v", err)
	}
	rfqID := common.HexToHash(rfqAck.RfqID)

	// --- 2. QUOTE_SUBMIT (POST /direct ingress) --------------------------------------------
	makerKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generating maker key: %v", err)
	}
	maker := crypto.PubkeyToAddress(makerKey.PublicKey)

	price := big.NewInt(1_005_000_000_000_000_000) // 1.005 USD — inside +-1% band of 1.00 mid, beats limit
	maxFxrp := big.NewInt(10_000_000)
	nonce := big.NewInt(1)

	digest := QuoteDigest(cfg.ChainID, cfg.EscrowAddr, rfqID, maker, price, maxFxrp, nonce)
	quoteSig, err := crypto.Sign(digest[:], makerKey)
	if err != nil {
		t.Fatalf("sign quote digest: %v", err)
	}
	quoteSig[64] += 27 // normalize V to {27,28} — the wallet-signature wire convention

	quotePlain := QuotePlaintext{
		V:           1,
		RfqID:       rfqID.Hex(),
		Maker:       maker.Hex(),
		PriceUsdE18: price.String(),
		MaxFxrpRaw:  maxFxrp.String(),
		Nonce:       nonce.String(),
		Sig:         "0x" + common.Bytes2Hex(quoteSig),
	}
	quoteJSON, err := json.Marshal(quotePlain)
	if err != nil {
		t.Fatalf("marshal quote plaintext: %v", err)
	}
	quoteCiphertext, err := teeutils.Encrypt(padTo(quoteJSON, cfg.PadSize), &teeKey.PublicKey)
	if err != nil {
		t.Fatalf("ECIES-encrypt quote: %v", err)
	}

	quoteDi := &teetypes.DirectInstruction{
		OPType:    opHash(OPTypeWDRFQ),
		OPCommand: opHash(OPCommandQuoteSubmit),
		Message:   quoteCiphertext,
	}

	quoteResult := h.HandleDirect(quoteDi)
	if quoteResult.Status != 1 {
		t.Fatalf("QUOTE_SUBMIT: expected status 1, got %d, log=%s", quoteResult.Status, quoteResult.Log)
	}
	var quoteAck QuoteAck
	if err := json.Unmarshal(quoteResult.Data, &quoteAck); err != nil {
		t.Fatalf("decode QuoteAck: %v", err)
	}
	if !quoteAck.Accepted {
		t.Fatalf("expected quote to be accepted")
	}

	// --- 3. RFQ_MATCH (POST /direct fallback ingress) --------------------------------------
	// A tiny real sleep guarantees time.Now() at match time is strictly after the RFQ's
	// WindowEndsAt (RfqWindowSec=0), independent of clock resolution.
	time.Sleep(5 * time.Millisecond)

	matchDi := &teetypes.DirectInstruction{
		OPType:    opHash(OPTypeWDRFQ),
		OPCommand: opHash(OPCommandRfqMatch),
		Message:   rfqID.Bytes(),
	}

	matchResult := h.HandleDirect(matchDi)
	if matchResult.Status != 1 {
		t.Fatalf("RFQ_MATCH: expected status 1, got %d, log=%s", matchResult.Status, matchResult.Log)
	}

	var outcome matcher.MatchOutcome
	if err := json.Unmarshal(matchResult.Data, &outcome); err != nil {
		t.Fatalf("decode MatchResponse: %v", err)
	}

	// (a) outcome=matched with non-empty abiEncoded+teeSignature.
	if outcome.Outcome != "MATCHED" {
		t.Fatalf("expected outcome MATCHED, got %s (reasons=%v)", outcome.Outcome, outcome.Reasons)
	}
	if outcome.AbiEncoded == "" || outcome.TeeSignature == "" {
		t.Fatalf("expected non-empty abiEncoded/teeSignature, got abiEncoded=%q teeSignature=%q",
			outcome.AbiEncoded, outcome.TeeSignature)
	}
	if outcome.Match == nil || outcome.Match.Maker != maker.Hex() {
		t.Fatalf("expected match.maker=%s, got %+v", maker.Hex(), outcome.Match)
	}

	// (b) ecrecover of the produced signature over MatchInstructionLib's ethSignedDigest equals the
	// fake sign-key's address.
	abiEncodedBytes := common.FromHex(outcome.AbiEncoded)
	sigBytes := common.FromHex(outcome.TeeSignature)
	dataHash := matcher.DataHash(abiEncodedBytes)
	ethDigest := matcher.EthSignedDigest(dataHash, cfg.ChainID)

	recovered, err := matcher.Recover(ethDigest, sigBytes)
	if err != nil {
		t.Fatalf("recovering signer: %v", err)
	}
	if recovered != teeSignerAddr {
		t.Fatalf("ecrecover mismatch: signed by %s, recovered %s", teeSignerAddr.Hex(), recovered.Hex())
	}
}

// TestHandleInstruction_WrongIngress_IsWdErrPath asserts the fixed ingress binding
// (docs/design.md §4.2): QUOTE_SUBMIT arriving over the onchain-instruction ingress must be
// rejected WD_ERR_PATH, not silently routed.
func TestHandleInstruction_WrongIngress_IsWdErrPath(t *testing.T) {
	book := matcher.NewSealedBook(1)
	sign := NewSignClient("http://127.0.0.1:1") // unused — rejected before any network call
	chain := &fakeSnapshotter{mid: big.NewInt(1)}
	h := NewHandler(Config{PadSize: 512}, book, sign, chain)

	df := &instruction.DataFixed{
		OPType:          opHash(OPTypeWDRFQ),
		OPCommand:       opHash(OPCommandQuoteSubmit), // wrong ingress for this command
		OriginalMessage: nil,
	}

	result := h.HandleInstruction(df)
	if result.Status != 0 {
		t.Fatalf("expected status 0, got %d", result.Status)
	}
	if result.Log != ErrPath {
		t.Fatalf("expected Log=%s, got %s", ErrPath, result.Log)
	}
}

// TestHandleDirect_RfqSubmit_IsWdErrPath asserts RFQ_SUBMIT can never land on the /direct ingress.
func TestHandleDirect_RfqSubmit_IsWdErrPath(t *testing.T) {
	book := matcher.NewSealedBook(1)
	sign := NewSignClient("http://127.0.0.1:1")
	chain := &fakeSnapshotter{mid: big.NewInt(1)}
	h := NewHandler(Config{PadSize: 512}, book, sign, chain)

	di := &teetypes.DirectInstruction{
		OPType:    opHash(OPTypeWDRFQ),
		OPCommand: opHash(OPCommandRfqSubmit), // wrong ingress
	}

	result := h.HandleDirect(di)
	if result.Status != 0 || result.Log != ErrPath {
		t.Fatalf("expected status 0 / Log=%s, got status=%d log=%s", ErrPath, result.Status, result.Log)
	}
}
