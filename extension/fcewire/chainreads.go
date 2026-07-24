package fcewire

import (
	"context"
	"fmt"
	"math/big"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

// This file hand-encodes the handful of read-only eth_calls the WD_RFQ handler needs
// (FlareContractRegistry.getContractAddressByName, FtsoV2.getFeedByIdInWei, BondLedger.freeBond,
// DvPEscrow.balances) rather than depending on abigen'd bindings — the ABI surface is four
// single-purpose view/payable reads, and hand-encoding keeps fcewire's dependency graph to
// go-ethereum + go-flare-common + tee-node only (no forge-build-artifact plumbing into a Go
// package). All calls are made via eth_call (ethclient.CallContract), which works against
// `payable` functions too since it never broadcasts a state-changing transaction.

var (
	addressTy, _ = abi.NewType("address", "", nil)
	stringTy, _  = abi.NewType("string", "", nil)
	bytes21Ty, _ = abi.NewType("bytes21", "", nil)
	uint256Ty, _ = abi.NewType("uint256", "", nil)
	uint128Ty, _ = abi.NewType("uint128", "", nil)
	uint64Ty, _  = abi.NewType("uint64", "", nil)
)

func selector(sig string) []byte {
	return crypto.Keccak256([]byte(sig))[:4]
}

// resolveContractAddress calls FlareContractRegistry.getContractAddressByName(string) — the
// registry pattern every Flare protocol contract address must be resolved through rather than
// hardcoded (.claude/context/flare-docs/network-tooling.md §2).
func resolveContractAddress(ctx context.Context, client *ethclient.Client, registry common.Address, name string) (common.Address, error) {
	args := abi.Arguments{{Type: stringTy}}
	packed, err := args.Pack(name)
	if err != nil {
		return common.Address{}, fmt.Errorf("fcewire: pack getContractAddressByName args: %w", err)
	}
	calldata := append(selector("getContractAddressByName(string)"), packed...)

	out, err := client.CallContract(ctx, ethereum.CallMsg{To: &registry, Data: calldata}, nil)
	if err != nil {
		return common.Address{}, fmt.Errorf("fcewire: getContractAddressByName(%q): %w", name, err)
	}

	retArgs := abi.Arguments{{Type: addressTy}}
	vals, err := retArgs.Unpack(out)
	if err != nil || len(vals) != 1 {
		return common.Address{}, fmt.Errorf("fcewire: unpack getContractAddressByName(%q) result: %w", name, err)
	}
	addr, ok := vals[0].(common.Address)
	if !ok {
		return common.Address{}, fmt.Errorf("fcewire: getContractAddressByName(%q): unexpected return type", name)
	}
	if addr == (common.Address{}) {
		return common.Address{}, fmt.Errorf("fcewire: registry has no address registered for %q", name)
	}
	return addr, nil
}

// getFeedByIdInWei calls FtsoV2Interface.getFeedByIdInWei(bytes21) — value already normalized to
// 18 decimals (.claude/context/flare-docs/ftsov2.md §4).
func getFeedByIdInWei(ctx context.Context, client *ethclient.Client, ftsoV2 common.Address, feedID [21]byte) (*big.Int, uint64, error) {
	args := abi.Arguments{{Type: bytes21Ty}}
	packed, err := args.Pack(feedID)
	if err != nil {
		return nil, 0, fmt.Errorf("fcewire: pack getFeedByIdInWei args: %w", err)
	}
	calldata := append(selector("getFeedByIdInWei(bytes21)"), packed...)

	out, err := client.CallContract(ctx, ethereum.CallMsg{To: &ftsoV2, Data: calldata}, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("fcewire: getFeedByIdInWei: %w", err)
	}

	retArgs := abi.Arguments{{Type: uint256Ty}, {Type: uint64Ty}}
	vals, err := retArgs.Unpack(out)
	if err != nil || len(vals) != 2 {
		return nil, 0, fmt.Errorf("fcewire: unpack getFeedByIdInWei result: %w", err)
	}
	value, ok := vals[0].(*big.Int)
	ts, ok2 := vals[1].(uint64)
	if !ok || !ok2 {
		return nil, 0, fmt.Errorf("fcewire: getFeedByIdInWei: unexpected return types")
	}
	return value, ts, nil
}

// freeBond calls BondLedger.freeBond(address) — the public mapping getter the engine reads as
// "availableBond" (contracts/src/BondLedger.sol).
func freeBond(ctx context.Context, client *ethclient.Client, bondLedger, maker common.Address) (uint64, error) {
	args := abi.Arguments{{Type: addressTy}}
	packed, err := args.Pack(maker)
	if err != nil {
		return 0, fmt.Errorf("fcewire: pack freeBond args: %w", err)
	}
	calldata := append(selector("freeBond(address)"), packed...)

	out, err := client.CallContract(ctx, ethereum.CallMsg{To: &bondLedger, Data: calldata}, nil)
	if err != nil {
		return 0, fmt.Errorf("fcewire: freeBond(%s): %w", maker.Hex(), err)
	}

	retArgs := abi.Arguments{{Type: uint256Ty}}
	vals, err := retArgs.Unpack(out)
	if err != nil || len(vals) != 1 {
		return 0, fmt.Errorf("fcewire: unpack freeBond result: %w", err)
	}
	amount, ok := vals[0].(*big.Int)
	if !ok {
		return 0, fmt.Errorf("fcewire: freeBond: unexpected return type")
	}
	return clampUint64(amount), nil
}

// takerBalance calls DvPEscrow.balances(address) — the public getter for the TakerBalance struct
// {uint128 armed; uint128 committed; uint64 armedUntil} (contracts/src/DvPEscrow.sol §3.3).
func takerBalance(ctx context.Context, client *ethclient.Client, escrow, taker common.Address) (armed, committed uint64, armedUntil uint64, err error) {
	args := abi.Arguments{{Type: addressTy}}
	packed, err := args.Pack(taker)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("fcewire: pack balances args: %w", err)
	}
	calldata := append(selector("balances(address)"), packed...)

	out, callErr := client.CallContract(ctx, ethereum.CallMsg{To: &escrow, Data: calldata}, nil)
	if callErr != nil {
		return 0, 0, 0, fmt.Errorf("fcewire: balances(%s): %w", taker.Hex(), callErr)
	}

	retArgs := abi.Arguments{{Type: uint128Ty}, {Type: uint128Ty}, {Type: uint64Ty}}
	vals, unpackErr := retArgs.Unpack(out)
	if unpackErr != nil || len(vals) != 3 {
		return 0, 0, 0, fmt.Errorf("fcewire: unpack balances result: %w", unpackErr)
	}
	armedBig, ok1 := vals[0].(*big.Int)
	committedBig, ok2 := vals[1].(*big.Int)
	armedUntilVal, ok3 := vals[2].(uint64)
	if !ok1 || !ok2 || !ok3 {
		return 0, 0, 0, fmt.Errorf("fcewire: balances: unexpected return types")
	}
	return clampUint64(armedBig), clampUint64(committedBig), armedUntilVal, nil
}

// clampUint64 saturates a non-negative *big.Int to math.MaxUint64 rather than silently wrapping —
// these are fairness-prefilter reads only (the escrow re-validates atomically at lock()), so a
// clamp can only make the enclave-side prefilter MORE conservative, never less.
func clampUint64(v *big.Int) uint64 {
	if v == nil || v.Sign() <= 0 {
		return 0
	}
	if v.IsUint64() {
		return v.Uint64()
	}
	return ^uint64(0)
}
