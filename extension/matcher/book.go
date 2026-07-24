package matcher

import (
	"fmt"
	"math/big"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

// Config holds the quantified policy constants (docs/design.md §3.2/§4.9) — integer-only,
// locked values. Policy may only be tightened at runtime (design.md §4.9); tests construct their
// own Config to probe boundaries without mutating the package-level default.
type Config struct {
	MinBlockFxrpRaw uint64 // 5_000e6 raw (6-dec) — MIN_BLOCK_FXRP
	BandBips        uint64 // 100 == ±1.00% inclusive — BAND_BIPS
	QuoteTTLSec     int64  // 60 — strict "<" freshness window
}

// DefaultConfig mirrors the canonical deploy's locked policy (design.md §3.2, §4.9 WD_* env
// defaults).
func DefaultConfig() Config {
	return Config{
		MinBlockFxrpRaw: 5_000_000_000,
		BandBips:        100,
		QuoteTTLSec:     60,
	}
}

// RFQ is the in-enclave representation of a sealed taker request (design.md §4.3).
type RFQ struct {
	ID            common.Hash
	Taker         common.Address
	FxrpAmountRaw uint64
	LimitPriceE18 *big.Int // minimum acceptable USD/FXRP for the seller (taker sells FXRP, v1)
	XrplAddress   string

	ReceivedAt   time.Time
	WindowEndsAt time.Time
	ExpiresAt    time.Time

	Matched bool
	Outcome *MatchOutcome // idempotence cache — RFQ_MATCH replays return the cached result
}

// Quote is the in-enclave representation of a sealed maker quote (design.md §4.3).
type Quote struct {
	RfqID      common.Hash
	Maker      common.Address
	PriceE18   *big.Int
	MaxFxrpRaw uint64
	Nonce      uint64

	ReceivedAt time.Time // freshness clock — eligible iff matchNow-ReceivedAt < QuoteTTLSec, strict
	Seq        uint64    // global intake counter — deterministic tie-break (price-time priority)
}

// SealedBook is the RAM-only, ephemeral order book (design.md §4.3/§4.7). It holds no persistent
// state and is never written to disk/DB — restart safety comes from the book simply vanishing.
type SealedBook struct {
	mu      sync.Mutex
	rfqs    map[common.Hash]*RFQ
	quotes  map[common.Hash]map[common.Address]*Quote // rfqId -> maker -> latest quote (replace-by-maker)
	epoch   uint64
	nextSeq uint64
}

// NewSealedBook constructs an empty book with a fresh random-per-boot epoch (design.md §4.3).
func NewSealedBook(epoch uint64) *SealedBook {
	return &SealedBook{
		rfqs:   make(map[common.Hash]*RFQ),
		quotes: make(map[common.Hash]map[common.Address]*Quote),
		epoch:  epoch,
	}
}

// Epoch returns the book's boot epoch (used only for observability/state aggregates, §4.9 GET /state).
func (b *SealedBook) Epoch() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.epoch
}

// Errors mirror the closed WD_ERR_* enum (design.md §4.8) at the granularity this package needs.
var (
	ErrBelowMinBlock = fmt.Errorf("matcher: %s", "WD_ERR_MIN_SIZE")
	ErrRfqExists     = fmt.Errorf("matcher: rfq already exists")
	ErrRfqUnknown    = fmt.Errorf("matcher: %s", "WD_ERR_RFQ_UNKNOWN")
	ErrWindowOpen    = fmt.Errorf("matcher: %s", "WD_ERR_WINDOW_OPEN")
	ErrEmptyXrplAddr = fmt.Errorf("matcher: empty XRPL address")
	ErrPriceStale    = fmt.Errorf("matcher: %s", "WD_ERR_PRICE_STALE")
)

// AddRFQ inserts a new RFQ into the book under the RFQ_SUBMIT intake path. Enforces the
// integer-only min-block-size policy (design.md §3.2: amountFxrp >= MIN_BLOCK_FXRP, i.e.
// >= 5_000_000_000 raw at exactly the boundary — not strictly greater) and basic well-formedness.
// windowSec is the RFQ auction window (design.md §4.9 WD_RFQ_WINDOW_SEC); ttlSec is the book GC
// horizon (WD_RFQ_TTL_SEC).
func (b *SealedBook) AddRFQ(cfg Config, id common.Hash, taker common.Address, fxrpAmountRaw uint64,
	limitPriceE18 *big.Int, xrplAddress string, now time.Time, windowSec, ttlSec int64,
) (*RFQ, error) {
	if fxrpAmountRaw < cfg.MinBlockFxrpRaw {
		return nil, ErrBelowMinBlock
	}
	if xrplAddress == "" {
		return nil, ErrEmptyXrplAddr
	}
	if limitPriceE18 == nil || limitPriceE18.Sign() <= 0 {
		return nil, fmt.Errorf("matcher: AddRFQ: limitPriceE18 must be positive")
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	if _, exists := b.rfqs[id]; exists {
		return nil, ErrRfqExists
	}

	rfq := &RFQ{
		ID:            id,
		Taker:         taker,
		FxrpAmountRaw: fxrpAmountRaw,
		LimitPriceE18: new(big.Int).Set(limitPriceE18),
		XrplAddress:   xrplAddress,
		ReceivedAt:    now,
		WindowEndsAt:  now.Add(time.Duration(windowSec) * time.Second),
		ExpiresAt:     now.Add(time.Duration(ttlSec) * time.Second),
	}
	b.rfqs[id] = rfq
	b.quotes[id] = make(map[common.Address]*Quote)
	return rfq, nil
}

// UpsertQuote implements QUOTE_SUBMIT / replace-by-maker (design.md §4.3/§6.2): a higher nonce
// replaces the maker's resting quote for this rfqId; equal/lower nonce is a stale-nonce reject.
// Caller (the /direct handler) is responsible for the EIP-712 signature + bond checks — this
// method only owns book bookkeeping and nonce monotonicity.
func (b *SealedBook) UpsertQuote(rfqID common.Hash, maker common.Address, priceE18 *big.Int,
	maxFxrpRaw uint64, nonce uint64, now time.Time,
) (replaced bool, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	byMaker, ok := b.quotes[rfqID]
	if !ok {
		return false, ErrRfqUnknown
	}
	existing, has := byMaker[maker]
	if has && nonce <= existing.Nonce {
		return false, fmt.Errorf("matcher: %s", "WD_ERR_STALE_NONCE")
	}

	b.nextSeq++
	byMaker[maker] = &Quote{
		RfqID:      rfqID,
		Maker:      maker,
		PriceE18:   new(big.Int).Set(priceE18),
		MaxFxrpRaw: maxFxrpRaw,
		Nonce:      nonce,
		ReceivedAt: now,
		Seq:        b.nextSeq,
	}
	return has, nil
}

// snapshotForMatch returns the RFQ and a defensive copy of its resting quotes for use outside the
// lock — matchCore is a pure function over this snapshot (design.md §4.5: "no time.Now(), no RPC
// inside").
func (b *SealedBook) snapshotForMatch(rfqID common.Hash) (*RFQ, []*Quote, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	rfq, ok := b.rfqs[rfqID]
	if !ok {
		return nil, nil, ErrRfqUnknown
	}
	byMaker := b.quotes[rfqID]
	quotes := make([]*Quote, 0, len(byMaker))
	for _, q := range byMaker {
		quotes = append(quotes, q)
	}
	// Copy the RFQ struct so matchCore never observes concurrent mutation.
	rfqCopy := *rfq
	return &rfqCopy, quotes, nil
}

// markMatched caches the outcome on the RFQ so a replayed RFQ_MATCH for the same rfqId returns
// the same result idempotently (design.md §4.5 step 1, §4.7 "double-match" invariant).
func (b *SealedBook) markMatched(rfqID common.Hash, outcome *MatchOutcome) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if rfq, ok := b.rfqs[rfqID]; ok {
		rfq.Matched = true
		rfq.Outcome = outcome
	}
}

// Participants returns rfqID's taker and the addresses of every maker currently resting a quote
// against it — exactly what a caller needs to build a ChainSnapshot (taker's armed/committed
// balance, each maker's free bond) before calling Match/MatchWithSigner. Read-only, defensive copy;
// safe to call outside book.mu (fcewire's handler.go uses this to snapshot chain state ahead of
// RFQ_MATCH, never inside the 2-second /action handler path itself — see docs/design.md §4.1/§4.4).
func (b *SealedBook) Participants(rfqID common.Hash) (taker common.Address, makers []common.Address, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	rfq, ok := b.rfqs[rfqID]
	if !ok {
		return common.Address{}, nil, ErrRfqUnknown
	}
	byMaker := b.quotes[rfqID]
	makers = make([]common.Address, 0, len(byMaker))
	for m := range byMaker {
		makers = append(makers, m)
	}
	return rfq.Taker, makers, nil
}

// CachedOutcome returns a previously computed match outcome for rfqID, if any (idempotence check).
func (b *SealedBook) CachedOutcome(rfqID common.Hash) (*MatchOutcome, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	rfq, ok := b.rfqs[rfqID]
	if !ok || !rfq.Matched {
		return nil, false
	}
	return rfq.Outcome, true
}

// GC removes RFQs (and their quotes) past ExpiresAt — mirrors the design's 5s-tick janitor
// (§4.3), exposed here as a synchronous sweep for tests/callers to drive explicitly.
func (b *SealedBook) GC(now time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, rfq := range b.rfqs {
		if now.After(rfq.ExpiresAt) {
			delete(b.rfqs, id)
			delete(b.quotes, id)
		}
	}
}
