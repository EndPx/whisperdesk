package fcewire

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	teetypes "github.com/flare-foundation/tee-node/pkg/types"
)

// SignClient talks to tee-node's loopback sign/decrypt server (docs/design.md §5.1/§6.5,
// tee-node/internal/extension/server/server.go). Both endpoints are unauthenticated — the TEE
// boundary IS the container, per tee-node's own comment on NewSignServer.
//
// tee-node/pkg/types.SignRequest/SignResponse/DecryptRequest/DecryptResponse all declare their
// []byte fields with plain `json:"..."` tags (no `,string` or hexutil.Bytes) — encoding/json
// base64-encodes []byte by default, so json.Marshal-ing these structs directly produces the
// "base64 in JSON, not 0x hex" wire format design.md §5.1 calls out, with zero manual encoding.
type SignClient struct {
	baseURL string
	http    *http.Client
}

// NewSignClient constructs a client against baseURL (e.g. "http://127.0.0.1:7701"). The HTTP
// timeout is short: this call happens inside a handler's overall response, and the outer /action
// call itself is bounded by the proxy's 2-second client timeout (docs/design.md §4.1) — a sign/
// decrypt call that runs long must fail fast rather than eat the whole budget.
func NewSignClient(baseURL string) *SignClient {
	return &SignClient{
		baseURL: baseURL,
		http:    &http.Client{Timeout: 1500 * time.Millisecond},
	}
}

// Sign implements matcher.SignerFunc: POST {baseURL}/sign with the raw WD_MATCH_V1 pre-image
// message (NOT its hash — see extension/matcher/instruction.go's SignerFunc doc comment and
// PROTOCOL.md's "Sign-port digest finding": the real /sign handler keccak256s the posted bytes
// itself before the EIP-191 wrap, so posting the pre-hash message here reproduces
// extension/matcher.Sign()'s local-privkey output byte-for-byte). Returns the 65-byte [R||S||V]
// signature with V in {0,1}, exactly as tee-node's utils.Sign does — callers (matcher.SignWithFunc)
// normalize V to {27,28} themselves.
func (c *SignClient) Sign(message []byte) ([]byte, error) {
	reqBody, err := json.Marshal(teetypes.SignRequest{Message: message})
	if err != nil {
		return nil, fmt.Errorf("fcewire: SignClient.Sign: marshal request: %w", err)
	}

	resp, err := c.http.Post(c.baseURL+"/sign", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("fcewire: SignClient.Sign: post: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fcewire: SignClient.Sign: sign port returned %d: %s", resp.StatusCode, string(body))
	}

	var sr teetypes.SignResponse
	if err := json.Unmarshal(body, &sr); err != nil {
		return nil, fmt.Errorf("fcewire: SignClient.Sign: decode response: %w", err)
	}
	if len(sr.Signature) != 65 {
		return nil, fmt.Errorf("fcewire: SignClient.Sign: expected 65-byte signature, got %d", len(sr.Signature))
	}
	return sr.Signature, nil
}

// Decrypt calls POST {baseURL}/decrypt with an ECIES ciphertext blob and returns the plaintext.
// Ciphertext wire format: 0x04‖X(32)‖Y(32)‖IV(16)‖ct‖HMAC(32) (docs/design.md §5.1) — opaque to
// this client, which just forwards the bytes.
func (c *SignClient) Decrypt(ciphertext []byte) ([]byte, error) {
	reqBody, err := json.Marshal(teetypes.DecryptRequest{EncryptedMessage: ciphertext})
	if err != nil {
		return nil, fmt.Errorf("fcewire: SignClient.Decrypt: marshal request: %w", err)
	}

	resp, err := c.http.Post(c.baseURL+"/decrypt", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("fcewire: SignClient.Decrypt: post: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fcewire: SignClient.Decrypt: decrypt port returned %d: %s", resp.StatusCode, string(body))
	}

	var dr teetypes.DecryptResponse
	if err := json.Unmarshal(body, &dr); err != nil {
		return nil, fmt.Errorf("fcewire: SignClient.Decrypt: decode response: %w", err)
	}
	return dr.DecryptedMessage, nil
}
