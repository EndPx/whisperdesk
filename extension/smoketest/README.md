# FCE signing smoke test (Step 3 evidence)

Proves the **crypto loop** WhisperDesk depends on: a signature produced by the TEE-side Go
primitives (`go-flare-common/pkg/signing` + `tee-node/pkg/utils.Sign`, the exact call
`tee-node/internal/router.SignResult` makes) is accepted by Solidity `ecrecover` using the same
digest as `MatchInstructionLib.ethSignedDigest` (`keccak256(abi.encode(WD_MATCH_TAG, chainId,
dataHash))` + EIP-191). The test signs a sample `WD_MATCH_V1` payload, independently re-derives the
digest with go-ethereum primitives, recovers the signer, and asserts it matches — confirming
`DvPEscrow.lock()`'s `ecrecover` will accept a real TEE signature once Step 4 wires the handler.

## Run

Requires the FCE clones as siblings of this repo: `../../../fce/tee-node` (see `go.mod` replace).
Always set `CGO_ENABLED=0` on Windows (default cgo build of go-ethereum's libsecp256k1 stalls 15+ min):

```bash
cd extension/smoketest && CGO_ENABLED=0 go test ./... -run TestSigningSchemeMatchesMatchInstructionLib -v
```

The Solidity half of this same round-trip is covered by `contracts/test/` (`vm.sign` +
`MatchInstructionLib.ethSignedDigest`); this is the Go-side half.
