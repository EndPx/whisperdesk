#!/usr/bin/env bash
# Vendors extension/matcher and extension/fcewire (this repo's canonical WhisperDesk WD_RFQ source)
# BY COPY into fce-extension-scaffold/internal/wd/{matcher,fcewire}, rewriting the internal
# "wd-matcher" import path to the scaffold module's path. The scaffold's Dockerfile builds a single
# module tree with no sibling-repo relative `replace` directives — this script is what keeps that
# tree self-contained and up to date with the canonical source.
#
# Only non-test .go source files are vendored (no *_test.go, no extension/matcher/cmd/genvectors,
# no go.mod/go.sum) — the vendored tree is library code only; the canonical source's own tests keep
# covering behavior, and vectors_test.go's relative path to
# contracts/test/vectors/matchinstruction.json would break once copied into a different directory
# depth anyway.
#
# Usage: ./sync-to-scaffold.sh [path/to/fce-extension-scaffold]
# Defaults to the documented sibling layout (../../../fce/fce-extension-scaffold relative to the
# Flare repo root) if no argument is given.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCAFFOLD_PATH="${1:-$REPO_ROOT/../fce/fce-extension-scaffold}"
SCAFFOLD_PATH="$(cd "$SCAFFOLD_PATH" && pwd)"

MATCHER_SRC="$REPO_ROOT/extension/matcher"
FCEWIRE_SRC="$REPO_ROOT/extension/fcewire"
WD_DEST="$SCAFFOLD_PATH/internal/wd"
MATCHER_DEST="$WD_DEST/matcher"
FCEWIRE_DEST="$WD_DEST/fcewire"

echo "Source (canonical):"
echo "  matcher : $MATCHER_SRC"
echo "  fcewire : $FCEWIRE_SRC"
echo "Destination (vendored copy):"
echo "  $WD_DEST"

copy_go_sources() {
  local src_dir="$1" dest_dir="$2"
  rm -rf "$dest_dir"
  mkdir -p "$dest_dir"
  for f in "$src_dir"/*.go; do
    base="$(basename "$f")"
    case "$base" in
      *_test.go) continue ;;
    esac
    cp "$f" "$dest_dir/$base"
    echo "  copied $base"
  done
}

copy_go_sources "$MATCHER_SRC" "$MATCHER_DEST"
copy_go_sources "$FCEWIRE_SRC" "$FCEWIRE_DEST"

# Rewrite the canonical "wd-matcher" import path to the scaffold's vendored location.
for f in "$FCEWIRE_DEST"/*.go; do
  sed -i.bak 's/"wd-matcher"/"extension-scaffold\/internal\/wd\/matcher"/' "$f"
  rm -f "$f.bak"
done

echo
echo "Vendored extension/matcher -> $MATCHER_DEST"
echo "Vendored extension/fcewire -> $FCEWIRE_DEST"
echo "Rewrote import path: wd-matcher -> extension-scaffold/internal/wd/matcher"
echo
echo "Next: cd '$SCAFFOLD_PATH' && go mod tidy && go build ./... && go vet ./... && go test ./..."
