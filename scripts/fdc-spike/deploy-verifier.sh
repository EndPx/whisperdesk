#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT=/mnt/d/Belajar/Hackacton/Flare
PRIVATE_KEY=$(sed -n 's/^PRIVATE_KEY=//p' "$ROOT/.env" | tr -d '[:space:]')
export PRIVATE_KEY
echo "key_len=${#PRIVATE_KEY}"
cd "$ROOT/contracts"
forge create src/spike/FdcXrpVerifier.sol:FdcXrpVerifier \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --constructor-args 0x906507E0B64bcD494Db73bd0459d1C667e14B933
