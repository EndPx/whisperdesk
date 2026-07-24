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

	"wd-client/internal/teeclient"
	"wd-client/internal/wire"
)

func runSubmit(args []string) error {
	fs := flag.NewFlagSet("submit", flag.ContinueOnError)
	url := fs.String("url", envOr("EXT_PROXY_URL", teeclient.DefaultProxyURL), "tee-proxy base URL")
	apiKey := fs.String("api-key", os.Getenv("DIRECT_API_KEY"), "X-API-Key header for POST /direct (env DIRECT_API_KEY)")
	opType := fs.String("op-type", wire.OpType, "opType string, hashed with ToHash before sending")
	opCommand := fs.String("op-command", "", "opCommand string (RFQ_SUBMIT|QUOTE_SUBMIT|RFQ_MATCH), hashed with ToHash before sending")
	message := fs.String("message", "", "0x-hex ECIES blob (e.g. the output of `wd-client encrypt`)")
	timeout := fs.Duration("timeout", 15*time.Second, "request timeout")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if *opCommand == "" {
		return fmt.Errorf("--op-command is required (one of RFQ_SUBMIT, QUOTE_SUBMIT, RFQ_MATCH)")
	}
	msg := *message
	if msg == "" && fs.NArg() > 0 {
		msg = fs.Arg(0)
	}
	if msg == "" {
		return fmt.Errorf("--message (or a positional 0x-hex arg) is required")
	}
	if !strings.HasPrefix(msg, "0x") && !strings.HasPrefix(msg, "0X") {
		return fmt.Errorf("--message must be 0x-hex, got %q", msg)
	}
	messageBytes := common.FromHex(msg)

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	client := teeclient.New(*url, *apiKey)
	action, err := client.Submit(ctx, wire.Hash(*opType), wire.Hash(*opCommand), messageBytes)
	if err != nil {
		return err
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(action)
}
