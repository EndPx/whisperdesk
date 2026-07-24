// Package fcewire is the canonical Step-5 WhisperDesk WD_RFQ handler: it wires the standalone
// extension/matcher engine (RFQ/quote book + deterministic matching + MatchInstruction signing) to
// the real FCE extension runtime — the Direct/Instruction ingress split (docs/design.md §4.2), the
// tee-node sign/decrypt loopback ports (§5.1), and cached (never in-path) FTSOv2/BondLedger/DvPEscrow
// chain reads (§4.4). See PROTOCOL.md in this directory for the authoritative wire schemas and the
// sign-port digest finding this package's signing seam relies on.
//
// This package is vendored BY COPY into fce-extension-scaffold/internal/wd/fcewire by
// sync-to-scaffold.sh/.ps1 so the scaffold's Docker build stays self-contained — this directory is
// the single source of truth; never hand-edit the copy.
package fcewire

import (
	"fmt"
	"os"
	"strconv"

	"github.com/ethereum/go-ethereum/common"
)

// OPType / OPCommand strings — byte-identical (via teeutils.ToHash's right-pad-32B scheme) across
// Solidity bytes32("…") literals (contracts/src/WhisperDeskInstructionSender.sol), this Go config,
// and any TS client (docs/design.md §4.2/§3.10).
const (
	OPTypeWDRFQ = "WD_RFQ"

	OPCommandRfqSubmit   = "RFQ_SUBMIT"   // onchain instruction ONLY; /direct demo bypass iff AllowDirectRfq (PROTOCOL.md "Demo ingress")
	OPCommandQuoteSubmit = "QUOTE_SUBMIT" // POST /direct ONLY
	OPCommandRfqMatch    = "RFQ_MATCH"    // onchain instruction (canonical); /direct fallback iff AllowDirectMatch
)

// FlareContractRegistry — same address on every Flare network (Mainnet/Coston2/Songbird/Coston).
const DefaultRegistryAddr = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019"

// XrpUsdFeedID is bytes21 0x015852502f55534400000000000000000000000000 — FTSOv2's Crypto-category
// feed id for "XRP/USD" (.claude/context/flare-docs/ftsov2.md §2/§3; also DvPEscrow.XRP_USD_FEED_ID).
var XrpUsdFeedID = [21]byte{
	0x01, 0x58, 0x52, 0x50, 0x2f, 0x55, 0x53, 0x44, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
}

// Config is the WD_RFQ handler's env-sourced configuration (docs/design.md §4.9). Every field here
// is read once at boot; policy fields may only be tightened by a redeploy, never relaxed at runtime.
type Config struct {
	ChainURL string
	ChainID  uint64

	EscrowAddr   common.Address
	BondAddr     common.Address
	RegistryAddr common.Address

	// Policy (matcher.Config mirror — docs/design.md §3.2/§4.9).
	MinBlockFxrpRaw uint64
	BandBips        uint64
	QuoteTTLSec     int64

	// RFQ auction window / book GC horizon (docs/design.md §4.3/§4.9).
	RfqWindowSec int64
	RfqTTLSec    int64

	// Chain-read cache cadence (docs/design.md §4.4/§4.9).
	PriceRefreshSec     int64
	PriceStaleMaxSec    int64
	ChainSnapshotTTLSec int64

	// AllowDirectMatch permits RFQ_MATCH via POST /direct as a gas-free demo keeper fallback
	// (docs/design.md §4.2) in addition to the canonical onchain-instruction ingress.
	AllowDirectMatch bool

	// AllowDirectRfq permits RFQ_SUBMIT via POST /direct — a demo-only ingress (PROTOCOL.md "Demo
	// ingress (WD_ALLOW_DIRECT_RFQ)") that exists solely because WhisperDeskInstructionSender (the
	// onchain sender-binding RFQ_SUBMIT is designed to require) is still a stub. When false (the
	// default), HandleDirect's RFQ_SUBMIT behavior is byte-identical to the production design:
	// WD_ERR_PATH, full stop. Never set true outside a gated demo instance.
	AllowDirectRfq bool

	// PadSize is the exact ECIES plaintext length (docs/design.md §5.3); non-matching plaintexts
	// are rejected WD_ERR_PAD.
	PadSize int

	// SignPortURL is the tee-node loopback sign/decrypt server, e.g. http://127.0.0.1:7701.
	SignPortURL string
}

// LoadConfig reads Config from the process environment, applying docs/design.md §4.9's defaults
// except where this task's explicit demo-instance overrides apply (WD_MIN_BLOCK_FXRP_RAW=1000000,
// WD_QUOTE_TTL_SEC=600 — see PROTOCOL.md "Demo-instance policy overrides").
func LoadConfig() (Config, error) {
	cfg := Config{
		MinBlockFxrpRaw:     1_000_000, // 1 FXRP raw (6-dec) — demo instance override, not the 5_000e6 canonical value
		BandBips:            100,
		QuoteTTLSec:         600,
		RfqWindowSec:        60,
		RfqTTLSec:           900,
		PriceRefreshSec:     2,
		PriceStaleMaxSec:    60,
		ChainSnapshotTTLSec: 5,
		AllowDirectMatch:    true,
		AllowDirectRfq:      false,
		PadSize:             512,
	}

	cfg.ChainURL = os.Getenv("CHAIN_URL")
	if cfg.ChainURL == "" {
		return Config{}, fmt.Errorf("fcewire: CHAIN_URL is required")
	}

	chainID, err := envUint64("CHAIN_ID", 114)
	if err != nil {
		return Config{}, err
	}
	cfg.ChainID = chainID

	escrow := os.Getenv("WD_ESCROW_ADDR")
	if escrow == "" {
		return Config{}, fmt.Errorf("fcewire: WD_ESCROW_ADDR is required")
	}
	if !common.IsHexAddress(escrow) {
		return Config{}, fmt.Errorf("fcewire: WD_ESCROW_ADDR is not a valid address: %q", escrow)
	}
	cfg.EscrowAddr = common.HexToAddress(escrow)

	bond := os.Getenv("WD_BOND_ADDR")
	if bond == "" {
		return Config{}, fmt.Errorf("fcewire: WD_BOND_ADDR is required")
	}
	if !common.IsHexAddress(bond) {
		return Config{}, fmt.Errorf("fcewire: WD_BOND_ADDR is not a valid address: %q", bond)
	}
	cfg.BondAddr = common.HexToAddress(bond)

	registry := os.Getenv("WD_REGISTRY_ADDR")
	if registry == "" {
		registry = DefaultRegistryAddr
	}
	if !common.IsHexAddress(registry) {
		return Config{}, fmt.Errorf("fcewire: WD_REGISTRY_ADDR is not a valid address: %q", registry)
	}
	cfg.RegistryAddr = common.HexToAddress(registry)

	if v, err := envUint64("WD_MIN_BLOCK_FXRP_RAW", cfg.MinBlockFxrpRaw); err != nil {
		return Config{}, err
	} else {
		cfg.MinBlockFxrpRaw = v
	}
	if v, err := envUint64("WD_BAND_BPS", cfg.BandBips); err != nil {
		return Config{}, err
	} else {
		cfg.BandBips = v
	}
	if v, err := envInt64("WD_QUOTE_TTL_SEC", cfg.QuoteTTLSec); err != nil {
		return Config{}, err
	} else {
		cfg.QuoteTTLSec = v
	}
	if v, err := envInt64("WD_RFQ_WINDOW_SEC", cfg.RfqWindowSec); err != nil {
		return Config{}, err
	} else {
		cfg.RfqWindowSec = v
	}
	if v, err := envInt64("WD_RFQ_TTL_SEC", cfg.RfqTTLSec); err != nil {
		return Config{}, err
	} else {
		cfg.RfqTTLSec = v
	}
	if v, err := envInt64("WD_PRICE_REFRESH_SEC", cfg.PriceRefreshSec); err != nil {
		return Config{}, err
	} else {
		cfg.PriceRefreshSec = v
	}
	if v, err := envInt64("WD_PRICE_STALE_MAX_SEC", cfg.PriceStaleMaxSec); err != nil {
		return Config{}, err
	} else {
		cfg.PriceStaleMaxSec = v
	}
	if v, err := envInt64("WD_CHAIN_SNAPSHOT_TTL_SEC", cfg.ChainSnapshotTTLSec); err != nil {
		return Config{}, err
	} else {
		cfg.ChainSnapshotTTLSec = v
	}
	if v, err := envBool("WD_ALLOW_DIRECT_MATCH", cfg.AllowDirectMatch); err != nil {
		return Config{}, err
	} else {
		cfg.AllowDirectMatch = v
	}
	// WD_ALLOW_DIRECT_RFQ deliberately does NOT use envBool's strconv.ParseBool (which would fail
	// LoadConfig on a typo'd value): this is a fail-closed demo gate, so anything other than the
	// exact literal "true" — unset, "1", "True", garbage — must boot as disabled, never error the
	// process out. See PROTOCOL.md "Demo ingress (WD_ALLOW_DIRECT_RFQ)".
	cfg.AllowDirectRfq = os.Getenv("WD_ALLOW_DIRECT_RFQ") == "true"
	if v, err := envInt64("WD_PAD_SIZE", int64(cfg.PadSize)); err != nil {
		return Config{}, err
	} else {
		cfg.PadSize = int(v)
	}

	signPort, err := envUint64("SIGN_PORT", 7701)
	if err != nil {
		return Config{}, err
	}
	cfg.SignPortURL = fmt.Sprintf("http://127.0.0.1:%d", signPort)

	return cfg, nil
}

func envUint64(key string, def uint64) (uint64, error) {
	s := os.Getenv(key)
	if s == "" {
		return def, nil
	}
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("fcewire: invalid %s: %w", key, err)
	}
	return v, nil
}

func envInt64(key string, def int64) (int64, error) {
	s := os.Getenv(key)
	if s == "" {
		return def, nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("fcewire: invalid %s: %w", key, err)
	}
	return v, nil
}

func envBool(key string, def bool) (bool, error) {
	s := os.Getenv(key)
	if s == "" {
		return def, nil
	}
	v, err := strconv.ParseBool(s)
	if err != nil {
		return false, fmt.Errorf("fcewire: invalid %s: %w", key, err)
	}
	return v, nil
}
