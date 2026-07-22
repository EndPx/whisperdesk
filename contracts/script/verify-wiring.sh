#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
RPC=https://coston2-api.flare.network/ext/C/rpc
ESCROW=0xf8a54aa4187a9e4ecfc5814b498499c032f2601e
BOND=0xf918dfc8281185bf8073a6e541416ed4388dde1f
echo "bond.escrow()      = $(cast call $BOND 'escrow()(address)' --rpc-url $RPC)"
echo "escrow.teeSigner() = $(cast call $ESCROW 'teeSigner()(address)' --rpc-url $RPC)"
echo "escrow.PAYMENT_WINDOW = $(cast call $ESCROW 'PAYMENT_WINDOW()(uint32)' --rpc-url $RPC)"
echo "escrow.BOND_LEDGER  = $(cast call $ESCROW 'BOND_LEDGER()(address)' --rpc-url $RPC)"
