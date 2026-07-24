package fcewire

// Closed WD_ERR_* enum (docs/design.md §4.8) — status 0, Data = nil, Log = "WD_ERR_<CODE>".
// Never echo field values in the Log string: these codes are the entire error surface handlers may
// return to callers.
const (
	ErrPath       = "WD_ERR_PATH"        // command landed on the wrong ingress (§4.2 table)
	ErrDecode     = "WD_ERR_DECODE"      // envelope/JSON/ABI decode failure, or malformed field
	ErrDecrypt    = "WD_ERR_DECRYPT"     // ECIES decrypt failure (sign port /decrypt error)
	ErrAuth       = "WD_ERR_AUTH"        // taker != envelope sender, or maker quote EIP-712 sig invalid
	ErrSide       = "WD_ERR_SIDE"        // side != SELL_FXRP
	ErrMinSize    = "WD_ERR_MIN_SIZE"    // amountFxrp < MIN_BLOCK_FXRP_RAW
	ErrBond       = "WD_ERR_BOND"        // reserved for bond-related hard failures
	ErrTakerFunds = "WD_ERR_TAKER_FUNDS" // reserved for taker-funds hard failures
	ErrRfqUnknown = "WD_ERR_RFQ_UNKNOWN" // rfqId not found in the sealed book
	ErrWindowOpen = "WD_ERR_WINDOW_OPEN" // RFQ_MATCH attempted before WindowEndsAt
	ErrStaleNonce = "WD_ERR_STALE_NONCE" // quote nonce <= the maker's existing resting quote nonce
	ErrPriceStale = "WD_ERR_PRICE_STALE" // cached FTSOv2 mid older than WD_PRICE_STALE_MAX_SEC, or unset
	ErrSign       = "WD_ERR_SIGN"        // sign-port /sign call failed
	ErrPad        = "WD_ERR_PAD"         // decrypted plaintext length != WD_PAD_SIZE
)
