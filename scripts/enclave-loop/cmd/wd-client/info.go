package main

import (
	"context"
	"encoding/json"
	"flag"
	"os"
	"time"

	teetypes "github.com/flare-foundation/tee-node/pkg/types"

	"wd-client/internal/teeclient"
)

// infoOutput is wd-client's curated `info` output — the fields the rest of the loop actually
// needs (address, chainId, raw pubkey), plus the full raw response for anyone who wants more.
type infoOutput struct {
	Address     string                         `json:"address"`
	ChainID     uint64                         `json:"chainId"`
	PublicKeyX  string                         `json:"publicKeyX"`
	PublicKeyY  string                         `json:"publicKeyY"`
	CodeHash    string                         `json:"codeHash"`
	Platform    string                         `json:"platform"`
	ExtensionID string                         `json:"extensionId"`
	Raw         teetypes.SignedTeeInfoResponse `json:"raw"`
}

func runInfo(args []string) error {
	fs := flag.NewFlagSet("info", flag.ContinueOnError)
	url := fs.String("url", envOr("EXT_PROXY_URL", teeclient.DefaultProxyURL), "tee-proxy base URL")
	timeout := fs.Duration("timeout", 15*time.Second, "request timeout")
	if err := fs.Parse(args); err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	client := teeclient.New(*url, "")
	info, err := client.FetchInfo(ctx)
	if err != nil {
		return err
	}

	out := infoOutput{
		Address:     info.Address.Hex(),
		ChainID:     info.TeeInfo.ChainID,
		PublicKeyX:  info.TeeInfo.PublicKey.X.Hex(),
		PublicKeyY:  info.TeeInfo.PublicKey.Y.Hex(),
		CodeHash:    info.MachineData.CodeHash.Hex(),
		Platform:    info.MachineData.Platform.Hex(),
		ExtensionID: info.MachineData.ExtensionID.Hex(),
		Raw:         info.SignedTeeInfoResponse,
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}
