#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT=/mnt/d/Belajar/Hackacton/Flare
PRIVATE_KEY=$(sed -n 's/^PRIVATE_KEY=//p' "$ROOT/.env" | tr -d '[:space:]')
export PRIVATE_KEY
echo "key_len=${#PRIVATE_KEY}"
cd "$ROOT/contracts"
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc \
  --broadcast --json 2>/dev/null | tail -1
