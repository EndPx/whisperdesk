package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"

	"wd-client/internal/matchsig"
	"wd-client/internal/teeclient"
	"wd-client/internal/wire"
)

// loopOutput is the final JSON `loop` prints to stdout on a verified MATCHED outcome — everything
// a caller (e.g. run.mjs) needs to call DvPEscrow.lock(abiEncoded, teeSignature).
type loopOutput struct {
	MatchID              string `json:"matchId"`
	Escrow               string `json:"escrow"`
	Taker                string `json:"taker"`
	Maker                string `json:"maker"`
	AmountFxrp           string `json:"amountFxrp"`
	PriceUsd18           string `json:"priceUsd18"`
	TakerXrplAddress     string `json:"takerXrplAddress"`
	InstructionExpiresAt uint64 `json:"instructionExpiresAt"`
	AbiEncoded           string `json:"abiEncoded"`
	TeeSignature         string `json:"teeSignature"`
	ChainID              uint64 `json:"chainId"`
	EnclaveAddress       string `json:"enclaveAddress"`
	RecoveredSigner      string `json:"recoveredSigner"`
	Verified             bool   `json:"verified"`
}

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[loop] "+format+"\n", args...)
}

func runLoop(args []string) error {
	fs := flag.NewFlagSet("loop", flag.ContinueOnError)
	url := fs.String("url", envOr("EXT_PROXY_URL", teeclient.DefaultProxyURL), "tee-proxy base URL")
	apiKey := fs.String("api-key", os.Getenv("DIRECT_API_KEY"), "X-API-Key header for POST /direct (env DIRECT_API_KEY)")
	chainIDFlag := fs.Uint64("chain-id", 0, "override chainId used for the ecrecover check (default: /info's teeInfo.chainId)")
	pollInterval := fs.Duration("poll-interval", 3*time.Second, "interval between GET /action/result polls")
	resultTimeout := fs.Duration("result-timeout", 30*time.Second, "how long to poll for each action's result before giving up")
	windowWait := fs.Duration("window-wait", 5*time.Second, "extra buffer added after windowEndsAt before submitting RFQ_MATCH")
	matchRetries := fs.Int("match-retries", 5, "retries for RFQ_MATCH on WD_ERR_WINDOW_OPEN before giving up")
	makerKey := fs.String("maker-key", os.Getenv("MAKER_PRIVATE_KEY"), "maker private key (hex, env MAKER_PRIVATE_KEY) — when set, the "+
		"EIP-712 Quote signature is computed here, AFTER rfqId is known. Required unless quote.json already carries a valid `sig` "+
		"bound to this exact rfqId (it usually cannot: rfqId = keccak256(RFQ ciphertext), knowable only from the RfqAck)")
	escrowFlag := fs.String("escrow", os.Getenv("ESCROW_ADDRESS"), "DvPEscrow address used as the EIP-712 verifyingContract when signing the quote")
	rfqIDFlag := fs.String("rfq-id", "", "already-known rfqId (0x…32B) — skips RFQ_SUBMIT entirely. REQUIRED against the real "+
		"handler: extension/fcewire.Handler.HandleDirect has no RFQ_SUBMIT case (PROTOCOL.md §2/§3 — "+
		"confirmed from source, not assumed), so RFQ_SUBMIT must be driven onchain via "+
		"WhisperDeskInstructionSender.submitRfq (out of scope for this HTTP-only CLI); pass the resulting "+
		"instructionId here and this command starts at QUOTE_SUBMIT")
	if err := fs.Parse(args); err != nil {
		return err
	}

	var rfqPath, quotePath string
	if *rfqIDFlag != "" {
		if fs.NArg() < 1 {
			return fmt.Errorf("usage: wd-client loop --rfq-id 0x... [flags] <quote.json>")
		}
		quotePath = fs.Arg(0)
	} else {
		if fs.NArg() < 2 {
			return fmt.Errorf("usage: wd-client loop [flags] <rfq.json> <quote.json>  (or --rfq-id 0x... <quote.json>)")
		}
		rfqPath, quotePath = fs.Arg(0), fs.Arg(1)
	}

	quoteRaw, err := os.ReadFile(quotePath)
	if err != nil {
		return fmt.Errorf("reading %s: %w", quotePath, err)
	}
	var quoteFields map[string]any
	if err := json.Unmarshal(quoteRaw, &quoteFields); err != nil {
		return fmt.Errorf("%s is not a JSON object: %w", quotePath, err)
	}

	client := teeclient.New(*url, *apiKey)

	// --- /info: enclave identity + chainId ---
	infoCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	info, err := client.FetchInfo(infoCtx)
	cancel()
	if err != nil {
		return fmt.Errorf("fetching /info: %w", err)
	}
	chainID := info.TeeInfo.ChainID
	if *chainIDFlag != 0 {
		chainID = *chainIDFlag
	}
	logf("enclave address=%s chainId=%d", info.Address.Hex(), chainID)

	var rfqID common.Hash
	var windowEndsAt uint64 // 0 if unknown (--rfq-id path); the RFQ_MATCH retry loop below still
	// converges in that case, it just can't log/sleep to a known deadline first.

	if *rfqIDFlag != "" {
		rfqID = common.HexToHash(*rfqIDFlag)
		logf("using pre-supplied rfqId=%s (RFQ_SUBMIT skipped — see --rfq-id's help text)", rfqID.Hex())
	} else {
		rfqRaw, err := os.ReadFile(rfqPath)
		if err != nil {
			return fmt.Errorf("reading %s: %w", rfqPath, err)
		}
		if !json.Valid(rfqRaw) {
			return fmt.Errorf("%s is not valid JSON", rfqPath)
		}

		// --- RFQ_SUBMIT ---
		// CONFIRMED (not assumed — extension/fcewire/handler.go's HandleDirect has no RFQ_SUBMIT
		// case at all; any OPCommand it doesn't recognize on this ingress falls through to
		// errResult(..., ErrPath)): this WILL fail with status 0 WD_ERR_PATH against the real
		// handler. Attempted anyway so this command still does something useful against a relaxed/
		// test handler, and so the failure path below can explain the fix (--rfq-id) rather than
		// just erroring opaquely.
		logf("submitting RFQ_SUBMIT via /direct (NOTE: the real handler rejects this ingress for " +
			"RFQ_SUBMIT — see WD_ERR_PATH handling below)...")
		// RFQ_SUBMIT's message is abi.encode(sender, ciphertext) — NOT a bare ECIES blob (see
		// envelope.go / fcewire's decodeRfqEnvelope), so it uses its own submitter.
		rfqAction, rfqResult, err := sealEnvelopeAndSubmit(client, info, rfqRaw, *pollInterval, *resultTimeout)
		if err != nil {
			return fmt.Errorf("RFQ_SUBMIT: %w", err)
		}
		logf("RFQ_SUBMIT actionID=%s status=%d log=%q", rfqAction.Data.ID.Hex(), rfqResult.Result.Status, rfqResult.Result.Log)
		if rfqResult.Result.Status != 1 {
			if rfqResult.Result.Log == "WD_ERR_PATH" {
				return fmt.Errorf(
					"RFQ_SUBMIT failed: status=0 log=\"WD_ERR_PATH\" — this handler requires RFQ_SUBMIT " +
						"onchain (extension/fcewire.Handler.HandleDirect has no RFQ_SUBMIT case, PROTOCOL.md §2). " +
						"Submit the RFQ via WhisperDeskInstructionSender.submitRfq instead, then re-run with " +
						"--rfq-id <the resulting instructionId> and just the quote.json argument",
				)
			}
			return fmt.Errorf("RFQ_SUBMIT failed: status=%d log=%q", rfqResult.Result.Status, rfqResult.Result.Log)
		}
		// PROTOCOL.md §3: RfqAck.rfqId is authoritative (NOT the submission actionID, which is only
		// a coincidental match for a hypothetical direct-accepting handler — this path is unreachable
		// against the real handler per the WD_ERR_PATH branch above, kept for a relaxed/test build).
		var rfqAck wire.RfqAck
		if err := json.Unmarshal(rfqResult.Result.Data, &rfqAck); err != nil {
			return fmt.Errorf("RFQ_SUBMIT: decoding RfqAck: %w (raw: %s)", err, rfqResult.Result.Data)
		}
		rfqID = common.HexToHash(rfqAck.RfqID)
		windowEndsAt = rfqAck.WindowEndsAt
		logf("rfqId=%s windowEndsAt=%d (%s)", rfqID.Hex(), windowEndsAt, time.Unix(int64(windowEndsAt), 0).UTC())
	}

	// --- QUOTE_SUBMIT (this DOES work via /direct against the real handler — confirmed) ---
	quoteFields["rfqId"] = rfqID.Hex()

	// The maker's EIP-712 signature binds rfqId, so it can only be produced now. Skipped only if
	// the caller supplied a pre-signed quote (--maker-key empty).
	if *makerKey != "" {
		if !common.IsHexAddress(*escrowFlag) {
			return fmt.Errorf("--escrow (or ESCROW_ADDRESS) must be the DvPEscrow address to sign the quote; got %q", *escrowFlag)
		}
		makerAddr, err := applyQuoteSignature(quoteFields, *makerKey, chainID, common.HexToAddress(*escrowFlag), rfqID)
		if err != nil {
			return fmt.Errorf("signing quote: %w", err)
		}
		logf("quote signed (EIP-712) by maker=%s verifyingContract=%s", makerAddr.Hex(), common.HexToAddress(*escrowFlag).Hex())
	}

	quoteJSON, err := json.Marshal(quoteFields)
	if err != nil {
		return fmt.Errorf("re-marshaling quote payload with rfqId set: %w", err)
	}
	logf("submitting QUOTE_SUBMIT (rfqId=%s)...", rfqID.Hex())
	_, quoteResult, err := sealAndSubmit(client, info, wire.OpCommandQuoteSubmit, quoteJSON, *pollInterval, *resultTimeout)
	if err != nil {
		return fmt.Errorf("QUOTE_SUBMIT: %w", err)
	}
	if quoteResult.Result.Status != 1 {
		return fmt.Errorf("QUOTE_SUBMIT failed: status=%d log=%q", quoteResult.Result.Status, quoteResult.Result.Log)
	}
	var quoteAck wire.QuoteAck
	if err := json.Unmarshal(quoteResult.Result.Data, &quoteAck); err != nil {
		return fmt.Errorf("QUOTE_SUBMIT: decoding QuoteAck: %w (raw: %s)", err, quoteResult.Result.Data)
	}
	logf("QuoteAck: accepted=%v replaced=%v", quoteAck.Accepted, quoteAck.Replaced)
	if !quoteAck.Accepted {
		return fmt.Errorf("QUOTE_SUBMIT: quote was not accepted")
	}

	// --- wait for the RFQ auction window to close (only known if we drove RFQ_SUBMIT ourselves) ---
	if windowEndsAt != 0 {
		deadline := time.Unix(int64(windowEndsAt), 0).Add(*windowWait)
		if wait := time.Until(deadline); wait > 0 {
			logf("waiting %s for the RFQ window to close...", wait.Round(time.Second))
			time.Sleep(wait)
		}
	}

	// --- RFQ_MATCH (with WD_ERR_WINDOW_OPEN retries) ---
	// CONFIRMED (extension/fcewire/handler.go's decodeRfqID / handleMatchFromDirect): the /direct
	// message for RFQ_MATCH is the BARE 32-byte rfqId — raw, unpadded, unencrypted (no JSON, no
	// WD_PAD_SIZE pad, no ECIES). This is NOT the padded-JSON-then-ECIES shape earlier drafts of
	// PROTOCOL.md assumed before that handler existed. wire.MatchTriggerMessage builds exactly this.
	matchMessage := wire.MatchTriggerMessage(rfqID)

	var matchResult *teetypes.ActionResponse
	for attempt := 0; ; attempt++ {
		logf("submitting RFQ_MATCH (attempt %d)...", attempt+1)
		submitCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		action, err := client.Submit(submitCtx, wire.OpTypeHash(), wire.OpCommandHash(wire.OpCommandRFQMatch), matchMessage)
		cancel()
		if err != nil {
			return fmt.Errorf("RFQ_MATCH: submitting: %w", err)
		}
		res, err := pollResult(client, action.Data.ID, *pollInterval, *resultTimeout)
		if err != nil {
			return fmt.Errorf("RFQ_MATCH: %w", err)
		}
		if res.Result.Status == 1 || !strings.Contains(res.Result.Log, "WD_ERR_WINDOW_OPEN") || attempt >= *matchRetries {
			matchResult = res
			break
		}
		logf("RFQ_MATCH not ready yet (%s), retrying in %s...", res.Result.Log, *windowWait)
		time.Sleep(*windowWait)
	}
	if matchResult.Result.Status != 1 {
		return fmt.Errorf("RFQ_MATCH failed: status=%d log=%q", matchResult.Result.Status, matchResult.Result.Log)
	}

	var matchResp wire.MatchResponse
	if err := json.Unmarshal(matchResult.Result.Data, &matchResp); err != nil {
		return fmt.Errorf("RFQ_MATCH: decoding MatchResponse: %w (raw: %s)", err, matchResult.Result.Data)
	}

	if matchResp.Outcome != "MATCHED" {
		b, _ := json.MarshalIndent(matchResp, "", "  ")
		fmt.Println(string(b))
		return fmt.Errorf("RFQ_MATCH outcome=%s (no eligible quote) — see reasons above", matchResp.Outcome)
	}
	if matchResp.Match == nil || matchResp.AbiEncoded == "" || matchResp.TeeSignature == "" {
		return fmt.Errorf("RFQ_MATCH: outcome=MATCHED but match/abiEncoded/teeSignature is missing — malformed MatchResponse")
	}

	// --- independently verify the TEE signature BEFORE trusting anything (never skip this) ---
	abiEncoded := common.FromHex(matchResp.AbiEncoded)
	teeSig := common.FromHex(matchResp.TeeSignature)
	recovered, verifyErr := matchsig.VerifyMatch(abiEncoded, teeSig, chainID, info.Address)
	verified := verifyErr == nil
	if !verified {
		logf("SIGNATURE VERIFICATION FAILED: %v", verifyErr)
	} else {
		logf("signature verified: ecrecover == enclave address %s", info.Address.Hex())
	}

	out := loopOutput{
		MatchID:              matchResp.Match.MatchID,
		Escrow:               matchResp.Match.Escrow,
		Taker:                matchResp.Match.Taker,
		Maker:                matchResp.Match.Maker,
		AmountFxrp:           matchResp.Match.AmountFxrp,
		PriceUsd18:           matchResp.Match.PriceUsd18,
		TakerXrplAddress:     matchResp.Match.TakerXrplAddress,
		InstructionExpiresAt: matchResp.Match.InstructionExpiresAt,
		AbiEncoded:           matchResp.AbiEncoded,
		TeeSignature:         matchResp.TeeSignature,
		ChainID:              chainID,
		EnclaveAddress:       info.Address.Hex(),
		RecoveredSigner:      recovered.Hex(),
		Verified:             verified,
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		return err
	}
	if !verified {
		return fmt.Errorf("refusing to succeed: ecrecover did not match the enclave address (see printed JSON for both values)")
	}
	return nil
}

// sealAndSubmit pads+encrypts plaintext to the enclave pubkey, POSTs it as opCommand under
// wire.OpType, and polls for its result. Used for RFQ_SUBMIT and QUOTE_SUBMIT, both of which ARE
// ECIES-sealed JSON per PROTOCOL.md §5.1/§5.2 — NOT for RFQ_MATCH, whose /direct message is raw
// and unencrypted (see wire.MatchTriggerMessage's doc comment and the inline call site above).
func sealAndSubmit(client *teeclient.Client, info *teeclient.Info, opCommand string, plaintext []byte, pollInterval, resultTimeout time.Duration) (*teetypes.Action, *teetypes.ActionResponse, error) {
	padded, err := wire.Pad(plaintext)
	if err != nil {
		return nil, nil, err
	}
	ciphertext, err := teeclient.Encrypt(padded, info)
	if err != nil {
		return nil, nil, err
	}

	submitCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	action, err := client.Submit(submitCtx, wire.OpTypeHash(), wire.OpCommandHash(opCommand), ciphertext)
	cancel()
	if err != nil {
		return nil, nil, err
	}

	ar, err := pollResult(client, action.Data.ID, pollInterval, resultTimeout)
	if err != nil {
		return nil, nil, err
	}
	return action, ar, nil
}

// pollResult polls GET /action/result/{actionID}?submissionTag=submit until a terminal (status 0
// or 1) response is observed or resultTimeout elapses. A non-200/undecodable response from Result
// is treated as "not processed yet" and retried — see PROTOCOL.md §4's note that there is no
// documented "pending" status distinct from a fetch failure.
func pollResult(client *teeclient.Client, actionID common.Hash, pollInterval, resultTimeout time.Duration) (*teetypes.ActionResponse, error) {
	pollCtx, cancel := context.WithTimeout(context.Background(), resultTimeout)
	defer cancel()
	for {
		_, ar, err := client.Result(pollCtx, actionID)
		if err == nil && ar != nil {
			return ar, nil
		}
		select {
		case <-pollCtx.Done():
			return nil, fmt.Errorf("polling /action/result/%s (submissionTag=submit): timed out after %s: %w",
				actionID.Hex(), resultTimeout, pollCtx.Err())
		case <-time.After(pollInterval):
		}
	}
}
