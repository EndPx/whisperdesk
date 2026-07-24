package fcewire

import "wd-matcher"

// RfqPlaintext is the RFQ ECIES payload (docs/design.md §6.1; PROTOCOL.md §Schemas). Decoded with
// json.Decoder.DisallowUnknownFields — extra fields are a hard reject (WD_ERR_DECODE), not silently
// ignored. All numeric amounts travel as decimal strings (never JSON numbers) to avoid float
// precision loss on 256-bit values.
type RfqPlaintext struct {
	V                int    `json:"v"`
	Taker            string `json:"taker"`            // 0x…20B — must equal the envelope sender
	Side             string `json:"side"`             // v1 accepts "SELL_FXRP" only
	FxrpAmountRaw    string `json:"fxrpAmountRaw"`    // decimal string, raw 6-dec
	LimitPriceUsdE18 string `json:"limitPriceUsdE18"` // decimal string, 18-dec USD per XRP
	XrplAddress      string `json:"xrplAddress"`      // plaintext r-address, in-enclave only until match
}

// QuotePlaintext is the Quote ECIES payload, sent via POST /direct (docs/design.md §6.2;
// PROTOCOL.md §Schemas).
type QuotePlaintext struct {
	V           int    `json:"v"`
	RfqID       string `json:"rfqId"`       // 0x…32B
	Maker       string `json:"maker"`       // 0x…20B — must equal the EIP-712 signature's recovered signer
	PriceUsdE18 string `json:"priceUsdE18"` // decimal string, 18-dec USD per XRP (== per FXRP at par)
	MaxFxrpRaw  string `json:"maxFxrpRaw"`  // decimal string, raw 6-dec
	Nonce       string `json:"nonce"`       // decimal string; higher nonce replaces the maker's resting quote
	Sig         string `json:"sig"`         // 0x…65B EIP-712 signature over the Quote struct (see quoteauth.go)
}

// RfqAck is the RFQ_SUBMIT success payload (docs/design.md §6.4/§4.8 — "no price echo, acks must
// not leak").
type RfqAck struct {
	RfqID        string `json:"rfqId"`
	WindowEndsAt uint64 `json:"windowEndsAt"`
}

// QuoteAck is the QUOTE_SUBMIT success payload (docs/design.md §6.4).
type QuoteAck struct {
	RfqID    string `json:"rfqId"`
	Accepted bool   `json:"accepted"`
	Replaced bool   `json:"replaced"`
}

// MatchResponse is the RFQ_MATCH success payload (docs/design.md §6.4). matcher.MatchOutcome's
// json tags (Outcome/Reasons/Match/AbiEncoded/TeeSignature) already match the design-doc shape
// exactly, so this is a plain alias — no separate struct/mapping to keep in sync.
type MatchResponse = matcher.MatchOutcome
