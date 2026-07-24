package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"wd-client/internal/teeclient"
	"wd-client/internal/wire"
)

// readPayload implements the "stdin/arg" input convention shared by encrypt and loop:
//   - "-" or no arg at all -> read all of stdin
//   - arg starting with "@" -> read the file at the path following "@"
//   - anything else -> treat the arg itself as the literal JSON text
func readPayload(arg string) ([]byte, error) {
	switch {
	case arg == "" || arg == "-":
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return nil, fmt.Errorf("reading stdin: %w", err)
		}
		return b, nil
	case len(arg) > 0 && arg[0] == '@':
		b, err := os.ReadFile(arg[1:])
		if err != nil {
			return nil, fmt.Errorf("reading %s: %w", arg[1:], err)
		}
		return b, nil
	default:
		return []byte(arg), nil
	}
}

func runEncrypt(args []string) error {
	fs := flag.NewFlagSet("encrypt", flag.ContinueOnError)
	url := fs.String("url", envOr("EXT_PROXY_URL", teeclient.DefaultProxyURL), "tee-proxy base URL")
	padSize := fs.Int("pad-size", wire.PadSize, "pad plaintext to exactly this many bytes before ECIES (WD_PAD_SIZE)")
	noPad := fs.Bool("no-pad", false, "skip padding (plaintext must already be the exact size the engine expects)")
	timeout := fs.Duration("timeout", 15*time.Second, "request timeout (for the /info fetch)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	var arg string
	if fs.NArg() > 0 {
		arg = fs.Arg(0)
	}

	raw, err := readPayload(arg)
	if err != nil {
		return err
	}
	if !json.Valid(raw) {
		return fmt.Errorf("input is not valid JSON (got %d bytes) — pass a JSON literal, @path/to/file.json, or pipe JSON on stdin", len(raw))
	}

	plaintext := raw
	if !*noPad {
		if *padSize != wire.PadSize {
			padded := make([]byte, 0, *padSize)
			padded = append(padded, raw...)
			if len(padded) > *padSize {
				return fmt.Errorf("input is %d bytes, exceeds --pad-size=%d", len(padded), *padSize)
			}
			for len(padded) < *padSize {
				padded = append(padded, ' ')
			}
			plaintext = padded
		} else {
			plaintext, err = wire.Pad(raw)
			if err != nil {
				return err
			}
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	client := teeclient.New(*url, "")
	info, err := client.FetchInfo(ctx)
	if err != nil {
		return fmt.Errorf("fetching /info for the enclave pubkey: %w", err)
	}

	ciphertext, err := teeclient.Encrypt(plaintext, info)
	if err != nil {
		return err
	}

	fmt.Printf("0x%x\n", ciphertext)
	return nil
}
