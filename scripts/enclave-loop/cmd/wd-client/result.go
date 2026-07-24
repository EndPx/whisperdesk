package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"wd-client/internal/teeclient"
)

func runResult(args []string) error {
	fs := flag.NewFlagSet("result", flag.ContinueOnError)
	url := fs.String("url", envOr("EXT_PROXY_URL", teeclient.DefaultProxyURL), "tee-proxy base URL")
	timeout := fs.Duration("timeout", 15*time.Second, "request timeout")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if fs.NArg() < 1 {
		return fmt.Errorf("usage: wd-client result [--url <proxy>] <actionID 0x...>")
	}
	id := common.HexToHash(fs.Arg(0))

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	client := teeclient.New(*url, "")
	body, _, err := client.Result(ctx, id)
	if body != nil {
		// Print whatever the proxy returned even on a non-200 (helps debugging a WD_ERR_* result),
		// per the task spec's "print raw JSON" — the caller inspects it directly.
		os.Stdout.Write(body)
		fmt.Println()
	}
	return err
}
