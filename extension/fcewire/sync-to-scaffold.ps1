#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Vendors extension/matcher and extension/fcewire (this repo's canonical WhisperDesk WD_RFQ source)
  BY COPY into fce-extension-scaffold/internal/wd/{matcher,fcewire}, rewriting the internal
  "wd-matcher" import path to the scaffold module's path. The scaffold's Dockerfile builds a single
  module tree with no sibling-repo relative `replace` directives — this script is what keeps that
  tree self-contained and up to date with the canonical source.

.DESCRIPTION
  Run this from anywhere; paths are resolved relative to this script's own location. Re-run any
  time extension/matcher or extension/fcewire change — it always fully replaces the destination
  directories (no incremental/partial copy) so stale files never linger.

  Only non-test .go source files are vendored (no *_test.go, no extension/matcher/cmd/genvectors,
  no go.mod/go.sum) — the vendored tree is library code only; the canonical source's own tests keep
  covering behavior, and vectors_test.go's relative path to contracts/test/vectors/matchinstruction.json
  would break once copied into a different directory depth anyway.

.PARAMETER ScaffoldPath
  Path to the fce-extension-scaffold checkout. Defaults to the documented sibling layout
  (..\..\..\fce\fce-extension-scaffold relative to the Flare repo root).
#>
param(
    [string]$ScaffoldPath
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
if (-not $ScaffoldPath) {
    $ScaffoldPath = Join-Path $RepoRoot "..\fce\fce-extension-scaffold"
}
$ScaffoldPath = Resolve-Path $ScaffoldPath -ErrorAction Stop

$MatcherSrc = Join-Path $RepoRoot "extension\matcher"
$FcewireSrc = Join-Path $RepoRoot "extension\fcewire"
$WdDest     = Join-Path $ScaffoldPath "internal\wd"
$MatcherDest = Join-Path $WdDest "matcher"
$FcewireDest = Join-Path $WdDest "fcewire"

Write-Host "Source (canonical):"
Write-Host "  matcher : $MatcherSrc"
Write-Host "  fcewire : $FcewireSrc"
Write-Host "Destination (vendored copy):"
Write-Host "  $WdDest"

function Copy-GoSources {
    param(
        [string]$SrcDir,
        [string]$DestDir,
        [string[]]$ExcludeDirNames = @()
    )

    if (Test-Path $DestDir) {
        Remove-Item -Recurse -Force $DestDir
    }
    New-Item -ItemType Directory -Force -Path $DestDir | Out-Null

    Get-ChildItem -Path $SrcDir -Filter "*.go" -File | Where-Object {
        $_.Name -notlike "*_test.go"
    } | ForEach-Object {
        Copy-Item $_.FullName -Destination (Join-Path $DestDir $_.Name)
        Write-Host "  copied $($_.Name)"
    }
}

Copy-GoSources -SrcDir $MatcherSrc -DestDir $MatcherDest
Copy-GoSources -SrcDir $FcewireSrc -DestDir $FcewireDest

# Rewrite the canonical "wd-matcher" import path to the scaffold's vendored location. fcewire's
# package files import it unaliased (`import "wd-matcher"`); the package's own `package matcher`
# clause means call sites keep using the `matcher.` identifier unchanged either way.
Get-ChildItem -Path $FcewireDest -Filter "*.go" -File | ForEach-Object {
    (Get-Content $_.FullName -Raw) -replace '"wd-matcher"', '"extension-scaffold/internal/wd/matcher"' |
        Set-Content -NoNewline $_.FullName
}

Write-Host ""
Write-Host "Vendored extension/matcher -> $MatcherDest"
Write-Host "Vendored extension/fcewire -> $FcewireDest"
Write-Host "Rewrote import path: wd-matcher -> extension-scaffold/internal/wd/matcher"
Write-Host ""
Write-Host "Next: cd '$ScaffoldPath'; go mod tidy; go build ./...; go vet ./...; go test ./..."
