// Command wd-client is the client half of WhisperDesk's enclave loop (extension/fcewire/PROTOCOL.md):
// derive the enclave's identity from GET /info, ECIES-seal WD_RFQ plaintexts to it, drive RFQ ->
// quote -> match through POST /direct + GET /action/result, and independently verify the returned
// MatchInstruction's TEE signature before trusting it. See PROTOCOL.md for the full wire spec this
// implements against, and README-usage below (also printed by `wd-client help`/no args).
package main

import (
	"fmt"
	"os"
)

const usage = `wd-client — WhisperDesk enclave-loop client CLI

Usage:
  wd-client info    [--url <proxy>]
  wd-client encrypt [--url <proxy>] [--pad-size N] <json-or-@file-or-->
  wd-client submit  [--url <proxy>] [--api-key <key>] --op-command <RFQ_SUBMIT|QUOTE_SUBMIT|RFQ_MATCH> --message 0x<hex>
  wd-client result  [--url <proxy>] <actionID 0x...>
  wd-client loop    [--url <proxy>] [--api-key <key>] [--chain-id N] [--timeout Ns] [--window-wait Ns] <rfq.json> <quote.json>

Flags read from env if unset: EXT_PROXY_URL (default https://fce.endpx.cloud), DIRECT_API_KEY.

Run 'wd-client <command> -h' for command-specific flags.`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}

	var err error
	switch os.Args[1] {
	case "info":
		err = runInfo(os.Args[2:])
	case "encrypt":
		err = runEncrypt(os.Args[2:])
	case "submit":
		err = runSubmit(os.Args[2:])
	case "result":
		err = runResult(os.Args[2:])
	case "loop":
		err = runLoop(os.Args[2:])
	case "-h", "--help", "help":
		fmt.Println(usage)
		return
	default:
		fmt.Fprintf(os.Stderr, "wd-client: unknown command %q\n\n%s\n", os.Args[1], usage)
		os.Exit(2)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "wd-client %s: %v\n", os.Args[1], err)
		os.Exit(1)
	}
}

// envOr returns the environment variable's value, or def if unset/empty.
func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
