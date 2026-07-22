package matcher

import (
	"math/big"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

var (
	testEscrow = common.HexToAddress("0x00000000000000000000000000000000000E1E")
	testTaker  = common.HexToAddress("0x0000000000000000000000000000000000700A")
	testMidE18 = big.NewInt(1_000_000_000_000_000_000) // 1.00 USD
)

func testCfg() Config {
	return DefaultConfig()
}

func testRFQ(now time.Time, limitE18 *big.Int) *RFQ {
	return &RFQ{
		ID:            crypto.Keccak256Hash([]byte("test-rfq")),
		Taker:         testTaker,
		FxrpAmountRaw: 5_000_000_000,
		LimitPriceE18: limitE18,
		XrplAddress:   "rLLsk7Ac3eDPRRPFPeeC1nCPKMWnQ38rTL",
		ReceivedAt:    now.Add(-30 * time.Second),
		WindowEndsAt:  now, // window already closed at match time
		ExpiresAt:     now.Add(15 * time.Minute),
	}
}

func makerAddr(n byte) common.Address {
	var a common.Address
	a[19] = n
	return a
}

func snapAllFunded(mid *big.Int, makers ...common.Address) ChainSnapshot {
	bonds := make(map[common.Address]uint64, len(makers))
	for _, m := range makers {
		bonds[m] = 1_000_000_000_000 // plenty of free bond for any test-sized notional
	}
	return ChainSnapshot{
		MidE18:            mid,
		MidAge:            0,
		FreeBondRaw:       bonds,
		TakerAvailableRaw: 1_000_000_000_000,
	}
}

// ---------------------------------------------------------------------------------------
// AddRFQ min-block boundary (design.md §3.2: amountFxrp >= MIN_BLOCK_FXRP = 5_000_000_000 raw)
// ---------------------------------------------------------------------------------------

func TestAddRFQ_MinBlockBoundary(t *testing.T) {
	cfg := testCfg()
	now := time.Now()

	t.Run("exactly at boundary is accepted", func(t *testing.T) {
		book := NewSealedBook(1)
		id := crypto.Keccak256Hash([]byte("boundary-ok"))
		rfq, err := book.AddRFQ(cfg, id, testTaker, 5_000_000_000, big.NewInt(1), "rAddr", now, 60, 900)
		if err != nil {
			t.Fatalf("expected acceptance at exact boundary, got err: %v", err)
		}
		if rfq.FxrpAmountRaw != 5_000_000_000 {
			t.Fatalf("unexpected amount stored: %d", rfq.FxrpAmountRaw)
		}
	})

	t.Run("one raw unit below boundary is rejected", func(t *testing.T) {
		book := NewSealedBook(1)
		id := crypto.Keccak256Hash([]byte("boundary-bad"))
		_, err := book.AddRFQ(cfg, id, testTaker, 4_999_999_999, big.NewInt(1), "rAddr", now, 60, 900)
		if err != ErrBelowMinBlock {
			t.Fatalf("expected ErrBelowMinBlock, got: %v", err)
		}
	})

	t.Run("one raw unit above boundary is accepted", func(t *testing.T) {
		book := NewSealedBook(1)
		id := crypto.Keccak256Hash([]byte("boundary-above"))
		_, err := book.AddRFQ(cfg, id, testTaker, 5_000_000_001, big.NewInt(1), "rAddr", now, 60, 900)
		if err != nil {
			t.Fatalf("expected acceptance above boundary, got err: %v", err)
		}
	})
}

// ---------------------------------------------------------------------------------------
// Best-quote selection: highest eligible price wins (design.md §4.5 step 3).
// ---------------------------------------------------------------------------------------

func TestMatchCore_BestQuoteSelection(t *testing.T) {
	cfg := testCfg()
	now := time.Now()
	rfq := testRFQ(now, big.NewInt(0)) // limit=0 so every candidate "beats the limit"

	m1, m2, m3 := makerAddr(1), makerAddr(2), makerAddr(3)
	quotes := []*Quote{
		{RfqID: rfq.ID, Maker: m1, PriceE18: big.NewInt(1_000_000_000_000_000_000), MaxFxrpRaw: 1e13, Nonce: 1, ReceivedAt: now.Add(-1 * time.Second), Seq: 1},
		{RfqID: rfq.ID, Maker: m2, PriceE18: big.NewInt(1_005_000_000_000_000_000), MaxFxrpRaw: 1e13, Nonce: 1, ReceivedAt: now.Add(-1 * time.Second), Seq: 2}, // best, in band
		{RfqID: rfq.ID, Maker: m3, PriceE18: big.NewInt(1_002_000_000_000_000_000), MaxFxrpRaw: 1e13, Nonce: 1, ReceivedAt: now.Add(-1 * time.Second), Seq: 3},
	}
	snap := snapAllFunded(testMidE18, m1, m2, m3)

	outcome, err := matchCore(cfg, testEscrow, rfq, quotes, snap, now)
	if err != nil {
		t.Fatalf("matchCore: %v", err)
	}
	if outcome.Outcome != "MATCHED" {
		t.Fatalf("expected MATCHED, got %s (reasons=%v)", outcome.Outcome, outcome.Reasons)
	}
	if outcome.Match.Maker != m2.Hex() {
		t.Fatalf("expected winner %s, got %s", m2.Hex(), outcome.Match.Maker)
	}
	if outcome.Match.PriceUsd18 != "1005000000000000000" {
		t.Fatalf("unexpected winning price: %s", outcome.Match.PriceUsd18)
	}
}

// ---------------------------------------------------------------------------------------
// Band filter: both above and below ±1% (BAND_BIPS=100) of the FTSOv2 mid are excluded;
// the inclusive boundary itself is accepted (design.md §3.6/§4.5).
// ---------------------------------------------------------------------------------------

func TestMatchCore_BandFilter_BothSides(t *testing.T) {
	cfg := testCfg()
	now := time.Now()
	rfq := testRFQ(now, big.NewInt(0))

	mLow, mHigh := makerAddr(1), makerAddr(2)
	// mid = 1e18; band = ±1% => [0.99e18, 1.01e18] inclusive.
	quotes := []*Quote{
		{RfqID: rfq.ID, Maker: mLow, PriceE18: big.NewInt(989_999_999_999_999_999), MaxFxrpRaw: 1e13, Nonce: 1, ReceivedAt: now.Add(-1 * time.Second), Seq: 1},    // just below -1%
		{RfqID: rfq.ID, Maker: mHigh, PriceE18: big.NewInt(1_010_000_000_000_000_001), MaxFxrpRaw: 1e13, Nonce: 1, ReceivedAt: now.Add(-1 * time.Second), Seq: 2}, // just above +1%
	}
	snap := snapAllFunded(testMidE18, mLow, mHigh)

	outcome, err := matchCore(cfg, testEscrow, rfq, quotes, snap, now)
	if err != nil {
		t.Fatalf("matchCore: %v", err)
	}
	if outcome.Outcome != "NO_MATCH" {
		t.Fatalf("expected NO_MATCH (both out of band), got %s: %+v", outcome.Outcome, outcome.Match)
	}
	if outcome.Reasons["OUT_OF_BAND"] != 2 {
		t.Fatalf("expected both quotes counted OUT_OF_BAND, got reasons=%v", outcome.Reasons)
	}
}

func TestMatchCore_BandFilter_InclusiveBoundaryAccepted(t *testing.T) {
	cfg := testCfg()
	now := time.Now()
	rfq := testRFQ(now, big.NewInt(0))

	mLower, mUpper := makerAddr(1), makerAddr(2)
	quotes := []*Quote{
		{RfqID: rfq.ID, Maker: mLower, PriceE18: big.NewInt(990_000_000_000_000_000), MaxFxrpRaw: 1e13, Nonce: 1, ReceivedAt: now.Add(-1 * time.Second), Seq: 1},   // exactly -1%
		{RfqID: rfq.ID, Maker: mUpper, PriceE18: big.NewInt(1_010_000_000_000_000_000), MaxFxrpRaw: 1e13, Nonce: 1, ReceivedAt: now.Add(-1 * time.Second), Seq: 2}, // exactly +1%, best price
	}
	snap := snapAllFunded(testMidE18, mLower, mUpper)

	outcome, err := matchCore(cfg, testEscrow, rfq, quotes, snap, now)
	if err != nil {
		t.Fatalf("matchCore: %v", err)
	}
	if outcome.Outcome != "MATCHED" {
		t.Fatalf("expected MATCHED (inclusive boundary), got %s: reasons=%v", outcome.Outcome, outcome.Reasons)
	}
	if outcome.Match.Maker != mUpper.Hex() {
		t.Fatalf("expected the higher in-band boundary quote to win, got %s", outcome.Match.Maker)
	}
}

// ---------------------------------------------------------------------------------------
// Quote expiry: strict "<" 60s freshness (design.md §4.5 step 2 / §4.9 WD_QUOTE_TTL_SEC).
// ---------------------------------------------------------------------------------------

func TestMatchCore_QuoteExpiry(t *testing.T) {
	cfg := testCfg()
	now := time.Now()
	rfq := testRFQ(now, big.NewInt(0))

	mFresh, mStale := makerAddr(1), makerAddr(2)
	quotes := []*Quote{
		{RfqID: rfq.ID, Maker: mFresh, PriceE18: big.NewInt(1_000_000_000_000_000_000), MaxFxrpRaw: 1e13, Nonce: 1, ReceivedAt: now.Add(-59 * time.Second), Seq: 1},
		{RfqID: rfq.ID, Maker: mStale, PriceE18: big.NewInt(1_005_000_000_000_000_000), MaxFxrpRaw: 1e13, Nonce: 1, ReceivedAt: now.Add(-60 * time.Second), Seq: 2}, // exactly 60s -> stale (strict <)
	}
	snap := snapAllFunded(testMidE18, mFresh, mStale)

	outcome, err := matchCore(cfg, testEscrow, rfq, quotes, snap, now)
	if err != nil {
		t.Fatalf("matchCore: %v", err)
	}
	if outcome.Outcome != "MATCHED" {
		t.Fatalf("expected MATCHED on the fresh quote, got %s: reasons=%v", outcome.Outcome, outcome.Reasons)
	}
	if outcome.Match.Maker != mFresh.Hex() {
		t.Fatalf("expected the fresh (higher would-be-losing) quote to win since the better-priced one is stale, got %s", outcome.Match.Maker)
	}
	if outcome.Reasons["STALE"] != 1 {
		t.Fatalf("expected exactly one STALE reason, got reasons=%v", outcome.Reasons)
	}
}

// ---------------------------------------------------------------------------------------
// Self-match reject: a quote from the taker's own address never wins, even at the best price
// (design.md §3.12 threat table "SelfMatch()", enforced here as an enclave-side prefilter).
// ---------------------------------------------------------------------------------------

func TestMatchCore_SelfMatchReject(t *testing.T) {
	cfg := testCfg()
	now := time.Now()
	rfq := testRFQ(now, big.NewInt(0))

	other := makerAddr(1)
	quotes := []*Quote{
		// Taker quoting on their own RFQ, at the best (highest) price:
		{RfqID: rfq.ID, Maker: rfq.Taker, PriceE18: big.NewInt(1_010_000_000_000_000_000), MaxFxrpRaw: 1e13, Nonce: 1, ReceivedAt: now.Add(-1 * time.Second), Seq: 1},
		{RfqID: rfq.ID, Maker: other, PriceE18: big.NewInt(1_000_000_000_000_000_000), MaxFxrpRaw: 1e13, Nonce: 1, ReceivedAt: now.Add(-1 * time.Second), Seq: 2},
	}
	snap := snapAllFunded(testMidE18, rfq.Taker, other)

	outcome, err := matchCore(cfg, testEscrow, rfq, quotes, snap, now)
	if err != nil {
		t.Fatalf("matchCore: %v", err)
	}
	if outcome.Outcome != "MATCHED" {
		t.Fatalf("expected MATCHED on the non-self quote, got %s: reasons=%v", outcome.Outcome, outcome.Reasons)
	}
	if outcome.Match.Maker != other.Hex() {
		t.Fatalf("self-quote must never win even at a better price; got winner %s", outcome.Match.Maker)
	}
	if outcome.Reasons["SELF_MATCH"] != 1 {
		t.Fatalf("expected exactly one SELF_MATCH reason, got reasons=%v", outcome.Reasons)
	}
}

func TestMatchCore_SelfMatchOnly_NoMatch(t *testing.T) {
	cfg := testCfg()
	now := time.Now()
	rfq := testRFQ(now, big.NewInt(0))

	quotes := []*Quote{
		{RfqID: rfq.ID, Maker: rfq.Taker, PriceE18: big.NewInt(1_000_000_000_000_000_000), MaxFxrpRaw: 1e13, Nonce: 1, ReceivedAt: now.Add(-1 * time.Second), Seq: 1},
	}
	snap := snapAllFunded(testMidE18, rfq.Taker)

	outcome, err := matchCore(cfg, testEscrow, rfq, quotes, snap, now)
	if err != nil {
		t.Fatalf("matchCore: %v", err)
	}
	if outcome.Outcome != "NO_MATCH" {
		t.Fatalf("expected NO_MATCH when the only quote is a self-match, got %s", outcome.Outcome)
	}
}

// ---------------------------------------------------------------------------------------
// Deterministic tie-break: equal price -> lowest Seq (price-time priority) wins, regardless of
// input slice order (design.md §4.5 step 3).
// ---------------------------------------------------------------------------------------

func TestMatchCore_DeterministicTieBreak(t *testing.T) {
	cfg := testCfg()
	now := time.Now()
	rfq := testRFQ(now, big.NewInt(0))

	mA, mB, mC := makerAddr(1), makerAddr(2), makerAddr(3)
	tiePrice := big.NewInt(1_000_000_000_000_000_000)
	base := []*Quote{
		{RfqID: rfq.ID, Maker: mA, PriceE18: tiePrice, MaxFxrpRaw: 1e13, Nonce: 1, ReceivedAt: now.Add(-1 * time.Second), Seq: 5},
		{RfqID: rfq.ID, Maker: mB, PriceE18: tiePrice, MaxFxrpRaw: 1e13, Nonce: 1, ReceivedAt: now.Add(-1 * time.Second), Seq: 2}, // lowest Seq -> should win
		{RfqID: rfq.ID, Maker: mC, PriceE18: tiePrice, MaxFxrpRaw: 1e13, Nonce: 1, ReceivedAt: now.Add(-1 * time.Second), Seq: 9},
	}
	snap := snapAllFunded(testMidE18, mA, mB, mC)

	// Run the same tie-break against multiple orderings of the input slice — the outcome must not
	// depend on iteration/insertion order (this is what makes it "deterministic").
	orders := [][]*Quote{
		{base[0], base[1], base[2]},
		{base[2], base[1], base[0]},
		{base[1], base[0], base[2]},
		{base[2], base[0], base[1]},
	}
	for i, quotes := range orders {
		outcome, err := matchCore(cfg, testEscrow, rfq, quotes, snap, now)
		if err != nil {
			t.Fatalf("order %d: matchCore: %v", i, err)
		}
		if outcome.Outcome != "MATCHED" {
			t.Fatalf("order %d: expected MATCHED, got %s", i, outcome.Outcome)
		}
		if outcome.Match.Maker != mB.Hex() {
			t.Fatalf("order %d: expected lowest-Seq tie-break winner %s, got %s", i, mB.Hex(), outcome.Match.Maker)
		}
	}
}

// ---------------------------------------------------------------------------------------
// Additional eligibility filters exercised for completeness: undersized quotes, below-limit
// quotes, and insufficient bond are all excluded (design.md §4.5 step 2).
// ---------------------------------------------------------------------------------------

func TestMatchCore_UndersizedQuoteExcluded(t *testing.T) {
	cfg := testCfg()
	now := time.Now()
	rfq := testRFQ(now, big.NewInt(0))
	m := makerAddr(1)
	quotes := []*Quote{
		{RfqID: rfq.ID, Maker: m, PriceE18: big.NewInt(1_000_000_000_000_000_000), MaxFxrpRaw: rfq.FxrpAmountRaw - 1, Nonce: 1, ReceivedAt: now.Add(-1 * time.Second), Seq: 1},
	}
	snap := snapAllFunded(testMidE18, m)

	outcome, err := matchCore(cfg, testEscrow, rfq, quotes, snap, now)
	if err != nil {
		t.Fatalf("matchCore: %v", err)
	}
	if outcome.Outcome != "NO_MATCH" || outcome.Reasons["UNDERSIZED"] != 1 {
		t.Fatalf("expected NO_MATCH/UNDERSIZED, got %s reasons=%v", outcome.Outcome, outcome.Reasons)
	}
}

func TestMatchCore_BelowLimitExcluded(t *testing.T) {
	cfg := testCfg()
	now := time.Now()
	// Taker demands at least 1.005 USD/FXRP.
	rfq := testRFQ(now, big.NewInt(1_005_000_000_000_000_000))
	m := makerAddr(1)
	quotes := []*Quote{
		{RfqID: rfq.ID, Maker: m, PriceE18: big.NewInt(1_000_000_000_000_000_000), MaxFxrpRaw: 1e13, Nonce: 1, ReceivedAt: now.Add(-1 * time.Second), Seq: 1},
	}
	snap := snapAllFunded(testMidE18, m)

	outcome, err := matchCore(cfg, testEscrow, rfq, quotes, snap, now)
	if err != nil {
		t.Fatalf("matchCore: %v", err)
	}
	if outcome.Outcome != "NO_MATCH" || outcome.Reasons["BELOW_LIMIT"] != 1 {
		t.Fatalf("expected NO_MATCH/BELOW_LIMIT, got %s reasons=%v", outcome.Outcome, outcome.Reasons)
	}
}

func TestMatchCore_InsufficientBondExcluded(t *testing.T) {
	cfg := testCfg()
	now := time.Now()
	rfq := testRFQ(now, big.NewInt(0))
	m := makerAddr(1)
	quotes := []*Quote{
		{RfqID: rfq.ID, Maker: m, PriceE18: big.NewInt(1_000_000_000_000_000_000), MaxFxrpRaw: 1e13, Nonce: 1, ReceivedAt: now.Add(-1 * time.Second), Seq: 1},
	}
	snap := ChainSnapshot{
		MidE18:            testMidE18,
		FreeBondRaw:       map[common.Address]uint64{m: 1}, // far below required 1% of notional
		TakerAvailableRaw: 1_000_000_000_000,
	}

	outcome, err := matchCore(cfg, testEscrow, rfq, quotes, snap, now)
	if err != nil {
		t.Fatalf("matchCore: %v", err)
	}
	if outcome.Outcome != "NO_MATCH" || outcome.Reasons["INSUFFICIENT_BOND"] != 1 {
		t.Fatalf("expected NO_MATCH/INSUFFICIENT_BOND, got %s reasons=%v", outcome.Outcome, outcome.Reasons)
	}
}

// ---------------------------------------------------------------------------------------
// End-to-end Match(): book + window guard + snapshot + sign + idempotent replay.
// ---------------------------------------------------------------------------------------

func TestMatch_EndToEnd_SignsAndCaches(t *testing.T) {
	cfg := testCfg()
	now := time.Now()
	book := NewSealedBook(42)

	id := crypto.Keccak256Hash([]byte("e2e-rfq"))
	_, err := book.AddRFQ(cfg, id, testTaker, 5_000_000_000, big.NewInt(1), "rLLsk7Ac3eDPRRPFPeeC1nCPKMWnQ38rTL", now.Add(-90*time.Second), 60, 900)
	if err != nil {
		t.Fatalf("AddRFQ: %v", err)
	}

	maker := makerAddr(7)
	if _, err := book.UpsertQuote(id, maker, big.NewInt(1_000_000_000_000_000_000), 1e13, 1, now.Add(-1*time.Second)); err != nil {
		t.Fatalf("UpsertQuote: %v", err)
	}

	teeKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	snap := snapAllFunded(testMidE18, maker)

	outcome, err := Match(book, cfg, testEscrow, 114, teeKey, id, snap, now)
	if err != nil {
		t.Fatalf("Match: %v", err)
	}
	if outcome.Outcome != "MATCHED" {
		t.Fatalf("expected MATCHED, got %s: %v", outcome.Outcome, outcome.Reasons)
	}
	if outcome.Signed == nil || len(outcome.Signed.Signature) != 65 {
		t.Fatalf("expected a signed 65-byte signature, got %+v", outcome.Signed)
	}
	if outcome.Signed.Signer != crypto.PubkeyToAddress(teeKey.PublicKey) {
		t.Fatalf("recovered signer does not match TEE key")
	}

	// Idempotent replay: a second Match() call for the same rfqId returns the identical cached
	// outcome without re-deriving anything (design.md §4.5 step 1 / §4.7 double-match invariant).
	again, err := Match(book, cfg, testEscrow, 114, teeKey, id, snap, now.Add(time.Second))
	if err != nil {
		t.Fatalf("Match (replay): %v", err)
	}
	if again.AbiEncoded != outcome.AbiEncoded || again.TeeSignature != outcome.TeeSignature {
		t.Fatalf("replayed Match() did not return the cached outcome byte-for-byte")
	}
}

func TestMatch_WindowStillOpen(t *testing.T) {
	cfg := testCfg()
	now := time.Now()
	book := NewSealedBook(1)

	id := crypto.Keccak256Hash([]byte("window-open-rfq"))
	// windowSec=60, RFQ received "now" -> WindowEndsAt = now+60s, so matching right now must fail.
	_, err := book.AddRFQ(cfg, id, testTaker, 5_000_000_000, big.NewInt(1), "rAddr", now, 60, 900)
	if err != nil {
		t.Fatalf("AddRFQ: %v", err)
	}

	teeKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	snap := snapAllFunded(testMidE18)

	_, err = Match(book, cfg, testEscrow, 114, teeKey, id, snap, now)
	if err != ErrWindowOpen {
		t.Fatalf("expected ErrWindowOpen, got %v", err)
	}
}
