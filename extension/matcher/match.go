package matcher

import (
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

// ChainSnapshot is the cached (never in-path) chain-read data the matching prefilter needs
// (design.md §4.4): FTSOv2 mid price and BondLedger/DvPEscrow snapshots. All of it is a fairness
// prefilter only — the escrow re-validates everything atomically at lock() time.
type ChainSnapshot struct {
	MidE18            *big.Int                  // FTSOv2 XRP/USD mid, 18-dec
	MidAge            time.Duration             // age of the cached mid at match time
	FreeBondRaw       map[common.Address]uint64 // maker -> BondLedger.freeBond snapshot, 6-dec raw
	TakerAvailableRaw uint64                    // taker's armed-uncommitted balance, 6-dec raw
}

// MaxPriceStaleness is the fail-closed bound on the cached FTSOv2 mid (design.md §4.4/§4.9
// WD_PRICE_STALE_MAX_SEC).
const MaxPriceStaleness = 60 * time.Second

// BondBips is the maker bond requirement as a fraction of notional (design.md §3.2 BOND_BIPS,
// mirrored in-enclave as a prefilter — BondLedger.lockBond is the authoritative onchain check).
const BondBips = 100

// MatchWire is the decoded-fields view of a match result (design.md §6.4 MatchWire component of
// MatchResponse) — hex/dec strings, suitable for JSON.
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

// MatchOutcome is the Go mirror of design.md §6.4's MatchResponse.
type MatchOutcome struct {
	Outcome      string         `json:"outcome"` // "MATCHED" | "NO_MATCH"
	Reasons      map[string]int `json:"reasons,omitempty"`
	Match        *MatchWire     `json:"match,omitempty"`
	AbiEncoded   string         `json:"abiEncoded,omitempty"`   // 0x… lock() arg 1
	TeeSignature string         `json:"teeSignature,omitempty"` // 0x… 65B, V in {27,28}, lock() arg 2

	// Signed carries the full typed result (hashes, raw bytes, recovered signer) for callers that
	// need more than the wire strings above (e.g. the match keeper, tests, genvectors).
	Signed *SignedMatch `json:"-"`
}

// eligibleQuote is a candidate quote annotated with why it passed (used only for readability).
type eligibleQuote struct {
	q *Quote
}

// matchCore is the pure deterministic matching function (design.md §4.5): no time.Now(), no RPC —
// time (now) and price (mid) are explicit arguments. Match() below is the book-locking wrapper
// that snapshots state and calls this.
func matchCore(cfg Config, escrow common.Address, rfq *RFQ, quotes []*Quote, snap ChainSnapshot, now time.Time) (*MatchOutcome, error) {
	if snap.MidE18 == nil || snap.MidE18.Sign() <= 0 {
		return nil, ErrPriceStale
	}
	if snap.MidAge > MaxPriceStaleness {
		return nil, ErrPriceStale
	}
	if snap.TakerAvailableRaw < rfq.FxrpAmountRaw {
		return &MatchOutcome{Outcome: "NO_MATCH", Reasons: map[string]int{"INSUFFICIENT_TAKER_FUNDS": 1}}, nil
	}

	reasons := map[string]int{}
	var eligible []eligibleQuote

	requiredBond := new(big.Int).Div(
		new(big.Int).Mul(new(big.Int).SetUint64(rfq.FxrpAmountRaw), big.NewInt(BondBips)),
		big.NewInt(10_000),
	)

	for _, q := range quotes {
		// 1. Self-match reject — a maker cannot fill their own taker RFQ (mirrors DvPEscrow's
		// SelfMatch() guard as a defense-in-depth prefilter, design.md §3.6/§3.12 threat #4… "SelfMatch").
		if q.Maker == rfq.Taker {
			reasons["SELF_MATCH"]++
			continue
		}
		// 2. Freshness — strict "<" QuoteTTLSec (design.md §4.5 step 2). A negative age (a quote
		// timestamped after `now`, which should never happen with honest inputs) is also stale —
		// fail closed rather than accept it.
		age := now.Sub(q.ReceivedAt)
		if age < 0 || age >= time.Duration(cfg.QuoteTTLSec)*time.Second {
			reasons["STALE"]++
			continue
		}
		// 3. Full size — no partial fills in v1.
		if q.MaxFxrpRaw < rfq.FxrpAmountRaw {
			reasons["UNDERSIZED"]++
			continue
		}
		// 4. In band: |price - mid| * 10000 <= BandBips * mid (inclusive, both sides).
		if !inBand(q.PriceE18, snap.MidE18, cfg.BandBips) {
			reasons["OUT_OF_BAND"]++
			continue
		}
		// 5. Beats taker limit (taker sells FXRP: higher price is better, must be >= limit).
		if q.PriceE18.Cmp(rfq.LimitPriceE18) < 0 {
			reasons["BELOW_LIMIT"]++
			continue
		}
		// 6. Bond snapshot >= 1% notional.
		freeBond := snap.FreeBondRaw[q.Maker]
		if new(big.Int).SetUint64(freeBond).Cmp(requiredBond) < 0 {
			reasons["INSUFFICIENT_BOND"]++
			continue
		}
		eligible = append(eligible, eligibleQuote{q: q})
	}

	if len(eligible) == 0 {
		return &MatchOutcome{Outcome: "NO_MATCH", Reasons: reasons}, nil
	}

	// Winner: max PriceE18; tie-break min Seq (price-time priority), deterministic.
	winner := eligible[0].q
	for _, e := range eligible[1:] {
		q := e.q
		switch q.PriceE18.Cmp(winner.PriceE18) {
		case 1:
			winner = q
		case 0:
			if q.Seq < winner.Seq {
				winner = q
			}
		}
	}

	mi := MatchInstruction{
		MatchID:              rfq.ID,
		Escrow:               escrow,
		Taker:                rfq.Taker,
		Maker:                winner.Maker,
		AmountFxrp:           new(big.Int).SetUint64(rfq.FxrpAmountRaw),
		PriceUsd18:           new(big.Int).Set(winner.PriceE18),
		TakerXrplAddress:     rfq.XrplAddress,
		InstructionExpiresAt: uint64(now.Unix()) + 300,
	}

	// Reasons is attached even on a MATCHED outcome (not just NO_MATCH) — it documents why every
	// non-winning quote was excluded, which is valuable both for callers/UI diagnostics and for
	// tests asserting individual filters fired as expected.
	return &MatchOutcome{Outcome: "MATCHED", Match: instructionToWire(mi), Reasons: nonEmptyReasons(reasons)}, nil
}

func nonEmptyReasons(r map[string]int) map[string]int {
	if len(r) == 0 {
		return nil
	}
	return r
}

// inBand reports whether price is within ±bandBips (basis points, out of 10_000) of mid,
// inclusive — integer-only, mirrors DvPEscrow.lock()'s band re-check exactly (design.md §3.6):
//
//	mi.priceUsd18 * 10_000 >= mid18 * (10_000 - BAND_BIPS) &&
//	mi.priceUsd18 * 10_000 <= mid18 * (10_000 + BAND_BIPS)
func inBand(price, mid *big.Int, bandBips uint64) bool {
	lhs := new(big.Int).Mul(price, big.NewInt(10_000))
	lowerBps := new(big.Int).Sub(big.NewInt(10_000), new(big.Int).SetUint64(bandBips))
	upperBps := new(big.Int).Add(big.NewInt(10_000), new(big.Int).SetUint64(bandBips))
	lower := new(big.Int).Mul(mid, lowerBps)
	upper := new(big.Int).Mul(mid, upperBps)
	return lhs.Cmp(lower) >= 0 && lhs.Cmp(upper) <= 0
}

func instructionToWire(mi MatchInstruction) *MatchWire {
	return &MatchWire{
		MatchID:              mi.MatchID.Hex(),
		Escrow:               mi.Escrow.Hex(),
		Taker:                mi.Taker.Hex(),
		Maker:                mi.Maker.Hex(),
		AmountFxrp:           mi.AmountFxrp.String(),
		PriceUsd18:           mi.PriceUsd18.String(),
		TakerXrplAddress:     mi.TakerXrplAddress,
		InstructionExpiresAt: mi.InstructionExpiresAt,
	}
}

// Match runs RFQ_MATCH for rfqID (design.md §4.5): guards, snapshots the book under lock, runs
// the pure matchCore, and on a MATCHED outcome builds + signs the MatchInstruction with the
// engine's TEE identity key (chainID=114 canonically) via the exact proven scheme in
// instruction.go's Sign(). Idempotent: a replayed call for an already-matched rfqId returns the
// cached outcome (status "success" either way — mirrors ActionResult status 1).
func Match(book *SealedBook, cfg Config, escrow common.Address, chainID uint64, teeKey *ecdsa.PrivateKey,
	rfqID common.Hash, snap ChainSnapshot, now time.Time,
) (*MatchOutcome, error) {
	return matchWithSignFunc(book, cfg, escrow, chainID, func(mi MatchInstruction) (*SignedMatch, error) {
		return Sign(mi, chainID, teeKey)
	}, rfqID, snap, now)
}

// MatchWithSigner runs RFQ_MATCH exactly like Match() above, but sources the WD_MATCH_V1 signature
// from signFn (a SignerFunc, see instruction.go) instead of a local *ecdsa.PrivateKey — the seam
// production callers (fcewire) use to sign via the tee-node sign port (POST /sign) rather than
// holding the TEE identity key in-process. Provably byte-identical output to Match() for the same
// underlying key (see SignerFunc's doc comment).
func MatchWithSigner(book *SealedBook, cfg Config, escrow common.Address, chainID uint64, signFn SignerFunc,
	rfqID common.Hash, snap ChainSnapshot, now time.Time,
) (*MatchOutcome, error) {
	return matchWithSignFunc(book, cfg, escrow, chainID, func(mi MatchInstruction) (*SignedMatch, error) {
		return SignWithFunc(mi, chainID, signFn)
	}, rfqID, snap, now)
}

// matchWithSignFunc is the shared body of Match()/MatchWithSigner(): guards, snapshots the book
// under lock, runs the pure matchCore, and on a MATCHED outcome builds + signs the MatchInstruction
// via the injected signer closure. Idempotent: a replayed call for an already-matched rfqId returns
// the cached outcome (status "success" either way — mirrors ActionResult status 1).
func matchWithSignFunc(book *SealedBook, cfg Config, escrow common.Address, chainID uint64,
	sign func(MatchInstruction) (*SignedMatch, error), rfqID common.Hash, snap ChainSnapshot, now time.Time,
) (*MatchOutcome, error) {
	if cached, ok := book.CachedOutcome(rfqID); ok {
		return cached, nil
	}

	rfq, quotes, err := book.snapshotForMatch(rfqID)
	if err != nil {
		return nil, err
	}
	if now.Before(rfq.WindowEndsAt) {
		return nil, ErrWindowOpen
	}

	outcome, err := matchCore(cfg, escrow, rfq, quotes, snap, now)
	if err != nil {
		return nil, err
	}

	if outcome.Outcome == "MATCHED" {
		mi := wireToInstruction(outcome.Match)
		signed, err := sign(mi)
		if err != nil {
			return nil, fmt.Errorf("matcher: Match: sign: %w", err)
		}
		outcome.Signed = signed
		outcome.AbiEncoded = "0x" + common.Bytes2Hex(signed.AbiEncoded)
		outcome.TeeSignature = "0x" + common.Bytes2Hex(signed.Signature)
	}

	book.markMatched(rfqID, outcome)
	return outcome, nil
}

func wireToInstruction(w *MatchWire) MatchInstruction {
	amount, _ := new(big.Int).SetString(w.AmountFxrp, 10)
	price, _ := new(big.Int).SetString(w.PriceUsd18, 10)
	return MatchInstruction{
		MatchID:              common.HexToHash(w.MatchID),
		Escrow:               common.HexToAddress(w.Escrow),
		Taker:                common.HexToAddress(w.Taker),
		Maker:                common.HexToAddress(w.Maker),
		AmountFxrp:           amount,
		PriceUsd18:           price,
		TakerXrplAddress:     w.TakerXrplAddress,
		InstructionExpiresAt: w.InstructionExpiresAt,
	}
}
