// Package teeclient is a thin HTTP client for the tee-proxy external surface (design.md §6.5):
// GET /info, POST /direct, GET /action/result/{id}. It decodes responses straight into
// tee-node/pkg/types structs (the same types the proxy itself encodes with) rather than
// hand-rolling parallel structs, so there is exactly one source of truth for the wire shapes.
package teeclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"
)

// DefaultProxyURL is the judge-facing deployment's proxy base URL (task spec default for
// EXT_PROXY_URL).
const DefaultProxyURL = "https://fce.endpx.cloud"

// Client is a small stateless HTTP wrapper — no retries/backoff beyond what callers (e.g. the
// `loop` subcommand's polling loop) implement themselves.
type Client struct {
	BaseURL    string
	APIKey     string // DIRECT_API_KEY, sent as X-API-Key on POST /direct only
	HTTPClient *http.Client
}

// New constructs a Client. baseURL should have no trailing slash (trimmed defensively anyway).
func New(baseURL, apiKey string) *Client {
	for len(baseURL) > 0 && baseURL[len(baseURL)-1] == '/' {
		baseURL = baseURL[:len(baseURL)-1]
	}
	return &Client{
		BaseURL:    baseURL,
		APIKey:     apiKey,
		HTTPClient: &http.Client{Timeout: 30 * time.Second},
	}
}

// Info is GET /info's decoded response plus the derived enclave ETH address (PROTOCOL.md §7):
// address = crypto.PubkeyToAddress(ParsePubKey(teeInfo.publicKey)) = address(keccak256(X||Y)[12:]).
type Info struct {
	teetypes.SignedTeeInfoResponse
	Address common.Address
}

// FetchInfo calls GET {BaseURL}/info and derives the enclave address from the returned pubkey.
func (c *Client) FetchInfo(ctx context.Context) (*Info, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/info", nil)
	if err != nil {
		return nil, fmt.Errorf("teeclient: FetchInfo: building request: %w", err)
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("teeclient: FetchInfo: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("teeclient: FetchInfo: reading body: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("teeclient: FetchInfo: GET /info returned %d: %s", resp.StatusCode, string(body))
	}

	var tir teetypes.SignedTeeInfoResponse
	if err := json.Unmarshal(body, &tir); err != nil {
		return nil, fmt.Errorf("teeclient: FetchInfo: decoding response: %w", err)
	}

	pub, err := teetypes.ParsePubKey(tir.TeeInfo.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("teeclient: FetchInfo: parsing publicKey: %w", err)
	}

	return &Info{
		SignedTeeInfoResponse: tir,
		Address:               crypto.PubkeyToAddress(*pub),
	}, nil
}

// Encrypt ECIES-seals plaintext (already padded to WD_PAD_SIZE by the caller — see wire.Pad) to
// the enclave's public key, exactly reusing tee-node/pkg/utils.Encrypt (go-ethereum crypto/ecies,
// ECIES_AES128_SHA256 — PROTOCOL.md §8). Not a method on Client because it needs no network call
// once the pubkey is known — callers that already have an *Info can call this directly.
func Encrypt(plaintext []byte, info *Info) ([]byte, error) {
	pub, err := teetypes.ParsePubKey(info.TeeInfo.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("teeclient: Encrypt: parsing publicKey: %w", err)
	}
	ct, err := teeutils.Encrypt(plaintext, pub)
	if err != nil {
		return nil, fmt.Errorf("teeclient: Encrypt: %w", err)
	}
	return ct, nil
}

// Submit POSTs {BaseURL}/direct with the given opType/opCommand (already ToHash'd 32-byte hashes)
// and an ECIES message blob (PROTOCOL.md §3), and returns the decoded echoed Action.
func (c *Client) Submit(ctx context.Context, opType, opCommand common.Hash, message []byte) (*teetypes.Action, error) {
	di := teetypes.DirectInstruction{
		OPType:    opType,
		OPCommand: opCommand,
		Message:   message,
	}
	body, err := json.Marshal(di)
	if err != nil {
		return nil, fmt.Errorf("teeclient: Submit: marshaling request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/direct", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("teeclient: Submit: building request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.APIKey != "" {
		req.Header.Set("X-API-Key", c.APIKey)
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("teeclient: Submit: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("teeclient: Submit: reading body: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("teeclient: Submit: POST /direct returned %d: %s", resp.StatusCode, string(respBody))
	}

	var action teetypes.Action
	if err := json.Unmarshal(respBody, &action); err != nil {
		return nil, fmt.Errorf("teeclient: Submit: decoding response: %w", err)
	}
	return &action, nil
}

// Result calls GET {BaseURL}/action/result/{id}?submissionTag=submit (design.md §6.5, direct
// results, 30 min TTL) and returns the raw response body alongside the decoded ActionResponse —
// callers that just want to print raw JSON (the `result` subcommand) use the []byte; `loop` uses
// the decoded struct.
func (c *Client) Result(ctx context.Context, actionID common.Hash) ([]byte, *teetypes.ActionResponse, error) {
	url := fmt.Sprintf("%s/action/result/%s?submissionTag=submit", c.BaseURL, actionID.Hex())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("teeclient: Result: building request: %w", err)
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("teeclient: Result: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, fmt.Errorf("teeclient: Result: reading body: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return body, nil, fmt.Errorf("teeclient: Result: GET /action/result returned %d: %s", resp.StatusCode, string(body))
	}

	var ar teetypes.ActionResponse
	if err := json.Unmarshal(body, &ar); err != nil {
		return body, nil, fmt.Errorf("teeclient: Result: decoding response: %w", err)
	}
	return body, &ar, nil
}
