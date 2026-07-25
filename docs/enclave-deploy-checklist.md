# Enclave deploy checklist — `/direct` enable + port fix + escrow retarget

For the human operator running this on the VPS (`/root/whisperdesk/fce-extension-scaffold`, live at
`https://fce.endpx.cloud`). Prepared locally only — nothing here has touched the VPS or been
committed. Read the whole file before running anything; step 0 gates everything else.

Local diffs this checklist assumes are already synced to the VPS:
- `fce-extension-scaffold/config/proxy/extension_proxy.coston2.docker.toml.example` — added `[direct]`
- `fce-extension-scaffold/docker-compose.yaml` — `DIRECT_API_KEY` passthrough on `ext-proxy`,
  `EXT_PROXY_INTERNAL_BIND` default flipped to `127.0.0.1:6673`, `WD_*` passthrough on `extension-tee`
- `Flare/contracts/script/DeployIntegration.s.sol` — optional `TEE_SIGNER` env override

## 0. Pre-flight — verify before touching anything

**0.1 — codeHash / re-registration verdict (read this before deciding to restart `extension-tee`).**
In `MODE=1` (simulated, what this stack runs — see `.claude/context/deployments.md`), the `/info`
`codeHash` is **not** derived from the built image at all:
- `tee-node/internal/attestation/attestation.go:46` sets `cHash := settings.TestCodeHash` unconditionally;
  the real-attestation derivation block that would read the codeHash out of the actual binary/image
  only runs `if settings.Mode == 0` (line 49) — skipped entirely when `MODE=1`.
- `tee-node/internal/attestation/attestation_token.go:34-36` — `GetGoogleAttestationToken` short-circuits
  to the `MagicPass` sentinel whenever `settings.Mode != 0`, so no real attestation call happens either.
- `tee-node/internal/settings/settings.go:112` — `TestCodeHash = common.HexToHash("194844cf417dde867073e5ab7199fa4d21fd82b5dbe2bdea8b3d7fc18d10fdc2")`,
  a hardcoded Go constant, matching the currently-registered `codeHash 0x194844…fdc2` in
  `.claude/context/deployments.md`.

  **Verdict: rebuilding the `extension-tee` image does NOT change the `/info` codeHash in simulated
  mode**, as long as `MODE` stays `1` and nobody edits `settings.go`'s `TestCodeHash` literal. `docker
  compose build extension-tee` is safe from a codeHash standpoint.

  **But there is a bigger, separate landmine**: `tee-node/internal/node/node.go:83-89` —
  `Initialize()` calls `crypto.GenerateKey()` to mint a **fresh in-memory ECDSA keypair on every
  process start**, with no persistence (no volume, no seed). This is the node's `PublicKey`/`TeeID`
  (part of `MachineData`, `attestation.go:67-74`), and it is exactly what `DvPEscrow.teeSigner` is
  checked against. Confirmed by `docs/design.md` §3.11: *"TEE machines are stateless; the identity
  key regenerates on every boot (confirmed by Flare)."* **Any restart of the `extension-tee`
  container — rebuild or not — rotates the live TEE signer address** (`0x1832e33F99cF5628f6Dc7Ae34e6011995BFdE4BD`
  today) and invalidates it against every escrow that has that address as `teeSigner`, until
  `register-tee -command rRap` + `setTeeSigner(newAddr)` are re-run (design.md §3.11 runbook,
  `scripts/wd-rebind.sh`).

  **Consequence for this checklist**: the `[direct]`/port-binding/`DIRECT_API_KEY` changes below are
  all on **`ext-proxy` only** — they do not require touching `extension-tee`. Restarting `ext-proxy`
  alone does not rotate the enclave's key (that key lives in the `extension-tee` process, not the
  proxy). **Keep `extension-tee` running and do not restart/rebuild it in this pass** unless you
  explicitly intend to run the full re-registration + `setTeeSigner` rebind afterward (§5 below) —
  the `WD_*` vars being added are not yet read by any code (`grep` across the scaffold repo finds zero
  consumers), so there is no functional reason to restart `extension-tee` just to pick them up today.

**0.2 — directory layout / build context (verified 24 Jul, VPS is already correct).** The live VPS
checkout at `/root/whisperdesk/fce-extension-scaffold` already runs the **flat** sibling layout
correctly: `docker-compose.yaml` has `context: ..` + `dockerfile: fce-extension-scaffold/Dockerfile`,
the `Dockerfile` `COPY`s `fce-extension-scaffold/` + `WORKDIR /build/fce-extension-scaffold`, and
`go.mod` has `replace github.com/flare-foundation/tee-node => ../tee-node` — all confirmed by fetching
the three files off the VPS and diffing. **The local checkout has now been brought into line with the
VPS** (its `docker-compose.yaml`/`Dockerfile` previously carried the upstream *nested*
`context: ../..` + `extension-examples/extension-scaffold/` paths — that was a local-only staleness,
NOT the VPS state). So a content diff of the local vs VPS `docker-compose.yaml` is now **env
additions only** (the `DIRECT_API_KEY` / `WD_*` passthrough and the `127.0.0.1:6673` bind default);
the `Dockerfile` differs only by one comment line.

**Do NOT overwrite the VPS `docker-compose.yaml`/`Dockerfile`/`go.mod` wholesale** — the build-context
lines are already right there and identical; only the env-passthrough hunks need to land. Apply them
with `git apply --check` (which will cleanly add just those hunks) or paste them by hand. Sanity-check
before any build:
```bash
cd /root/whisperdesk/fce-extension-scaffold
docker compose -f docker-compose.yaml -f docker-compose.coston2.yaml config | grep -A4 'context:\|dockerfile'
# expect: context: /root/whisperdesk  +  dockerfile: .../fce-extension-scaffold/Dockerfile
```

**0.3 — this pass never restarts `extension-tee`.** Given 0.1, the plan below only restarts
`ext-proxy`. `extension-tee`'s new `WD_*` env passthrough is inert (no code reads it yet) and stays
staged in `.env`/compose for a deliberate future rebind (§5), not exercised here.

## 1. Sync the diffs to the VPS

Two things go up: (a) the **new Go handler source** (`internal/wd/` + the `internal/extension/*.go`
edits — these must be in the image, so they gate the `extension-tee` rebuild), and (b) the
**`docker-compose.yaml` env-passthrough hunks** (build-context is already correct on the VPS per
§0.2 — do NOT overwrite the whole file).

```bash
# (a) handler source — rsync the two dirs the sync script produced (verified build-clean locally)
rsync -av --delete "D:/Belajar/Hackacton/fce/fce-extension-scaffold/internal/wd/" \
  vps:/root/whisperdesk/fce-extension-scaffold/internal/wd/
rsync -av "D:/Belajar/Hackacton/fce/fce-extension-scaffold/internal/extension/" \
  vps:/root/whisperdesk/fce-extension-scaffold/internal/extension/

# (b) compose env hunks ONLY — generate a diff of just the env lines and apply with --check first.
cd "D:/Belajar/Hackacton/fce/fce-extension-scaffold"
git diff -- docker-compose.yaml > /tmp/compose-env.diff   # after the 0.2 fix this is env-additions only
scp /tmp/compose-env.diff vps:/root/whisperdesk/fce-extension-scaffold/
ssh vps 'cd /root/whisperdesk/fce-extension-scaffold && git apply --check compose-env.diff && git apply compose-env.diff'
```
`--check` first — if it fails, the VPS `docker-compose.yaml` diverged; **merge only the env hunks by
hand**, never overwrite the build-context lines (they are already the correct flat-layout values).
Confirm afterward with the `docker compose ... config | grep context:` check from §0.2.

**The actual live `config/proxy/extension_proxy.coston2.docker.toml` (not the `.example`) is
gitignored** — it holds the real Indexer DB credentials and was never in this checkout (confirmed:
only the `.example` exists locally). You cannot diff/rsync it from here. **Manually add the same
`[direct]` block** (copied below) to the end of the live file on the VPS:
```toml
[direct]
enable = true
api_key_variable = "DIRECT_API_KEY"
api_key_optional = false
max_body_size = 65536
```
Field names verified against `tee-proxy/pkg/config/config.go`'s `Direct` struct
(`enable`/`api_key`/`api_key_variable`/`api_key_optional`/`max_body_size` — config.go:196-202), not
just `config.example.toml`.

## 2. Generate `DIRECT_API_KEY`

**Do not** ask an assistant to generate or store this — generate and hold it yourself:
```bash
openssl rand -hex 32
```
Put it in the VPS's `.env` (next to `PROXY_PRIVATE_KEY`) as `DIRECT_API_KEY=<generated value>`. This
is a secret — never echo it into shell history you'll paste elsewhere, never commit it, never send it
to a log.

## 3. Bring up `ext-proxy` only

```bash
cd /root/whisperdesk/fce-extension-scaffold
docker compose -f docker-compose.yaml -f docker-compose.coston2.yaml config >/dev/null   # sanity-check merge
curl -sf https://fce.endpx.cloud/info | tee /tmp/info-before.json   # capture BEFORE state
docker compose -f docker-compose.yaml -f docker-compose.coston2.yaml up -d ext-proxy
docker compose -f docker-compose.yaml -f docker-compose.coston2.yaml logs -f ext-proxy   # watch for panics / config errors
```
Confirm `extension-tee` did not restart (`docker compose ps` — its `Up <duration>` should not have
reset) and is still reachable through the bounced proxy:
```bash
curl -sf https://fce.endpx.cloud/info | tee /tmp/info-after.json
diff /tmp/info-before.json /tmp/info-after.json   # expect NO diff — same codeHash, same PublicKey/TeeID
```
If `PublicKey`/`TeeID` differ from before, `extension-tee` restarted (intentionally or as a side
effect of `depends_on`) — stop and go to §5 (full rebind) before deploying anything against it.

## 4. Verify the port fix and `/direct`

```bash
# 6673 must now be loopback-only — confirm from the VPS itself and from outside:
ss -tlnp | grep 6673                     # expect 127.0.0.1:6673, not 0.0.0.0:6673
curl -m3 http://<vps-public-ip>:6673/info   # expect connection refused/timeout from off-box

# /direct without a key → 401, per tee-proxy/internal/server/external.go verifyAPIKey (line 184-192)
curl -si -X POST https://fce.endpx.cloud/direct -d '{}'        # expect HTTP/1.1 401
curl -si -X POST https://fce.endpx.cloud/direct \
  -H "X-API-Key: <the DIRECT_API_KEY you generated>" -d '{}'   # expect 400 (invalid body), NOT 401 —
                                                                 # proves the key check passed and it's
                                                                 # now failing on payload shape instead
```

## 5. Escrow deploy + `TEE_SIGNER` wiring

Order matters — deploy against the **currently live** enclave address, read fresh, not the value
hardcoded in `deployments.md` (it hasn't drifted per §3's diff check, but read it again to be sure):
```bash
curl -sf https://fce.endpx.cloud/info | jq -r '.machineData.publicKey'   # or however /info nests it —
                                                                            # cross-check against TeeID/address
```
Then, from the main repo:
```bash
cd contracts
export PRIVATE_KEY=<funded deployer key>
export TEE_SIGNER=<address read from /info above>   # NEW — omit to keep old default-to-deployer behavior
forge script script/DeployIntegration.s.sol --rpc-url coston2 --broadcast --slow
```
Record the new `DvPEscrow`/`BondLedger` addresses in `.claude/context/deployments.md` (submission
item). Then wire them into the VPS extension env (staged only — see §0.3, no restart yet):
```bash
# on the VPS, in whatever .env extension-tee's env_file (config/extension.env) reads:
WD_ESCROW_ADDR=<new DvPEscrow address>
WD_BOND_ADDR=<new BondLedger address>
WD_MIN_BLOCK_FXRP_RAW=1000000        # 1 FXRP, 6-dec raw — matches MIN_BLOCK_FXRP in the script
WD_BAND_BPS=<pick a value — design.md §3.6/§3.12 band check, currently ±1% = 100 bps>
WD_QUOTE_TTL_SEC=<pick a value — design.md §3.6 instructionExpiresAt is +300s today>
# Demo-only: enables the /direct RFQ_SUBMIT bypass (extension/fcewire/PROTOCOL.md "Demo ingress
# (WD_ALLOW_DIRECT_RFQ)"). Kept on because the website's one-click demo has to finish inside a
# browser session; the onchain sender (WhisperDeskInstructionSender, deployed and registry-enforced)
# is the real ingress and needs the auction window plus two extra transactions.
# Exact string "true" enables it; unset it to make RFQ_SUBMIT onchain-only.
WD_ALLOW_DIRECT_RFQ=<"true" to enable, unset otherwise>
```

**If/when you do decide to restart `extension-tee`** to make it start consuming `WD_*` (once that
consumer code exists) or to pick up the `docker-compose.yaml`/proxy-config sync in full, follow the
full rebind runbook — restarting rotates the enclave's key (§0.1), so the escrow's `teeSigner` goes
stale the moment the container comes back up, **even if you just set `TEE_SIGNER` to the right value
five minutes ago**:
```bash
docker compose -f docker-compose.yaml -f docker-compose.coston2.yaml up -d --build extension-tee
# then, per docs/design.md §3.11 / scripts/wd-rebind.sh:
#   register-tee -command rRap   (capital R = fresh challenge; lowercase r → ChallengeExpired)
#   curl -sf https://fce.endpx.cloud/info   # read the NEW teeID/publicKey
#   cast send <escrow-owner-key> <ESCROW_ADDR> "setTeeSigner(address)" <newTeeId> --rpc-url coston2
```
Do this rebind in the **same maintenance window** as the restart — an escrow whose `teeSigner` no
longer matches the running enclave will fail-closed on every `lock()` (design.md §3.4/§3.12 #1) until
rebound.

## 6. Rollback

```bash
cd /root/whisperdesk/fce-extension-scaffold
docker compose -f docker-compose.yaml -f docker-compose.coston2.yaml down ext-proxy
git diff docker-compose.yaml config/proxy/extension_proxy.coston2.docker.toml.example   # review
git checkout -- docker-compose.yaml   # or manually revert the hunks if git apply diverged (0.2)
# revert the live (gitignored) coston2.docker.toml's [direct] block by hand (delete the block added in §1)
docker compose -f docker-compose.yaml -f docker-compose.coston2.yaml up -d ext-proxy
# previous image tag, if extension-tee was ever rebuilt in this session:
docker compose -f docker-compose.yaml -f docker-compose.coston2.yaml images extension-tee
docker tag <previous-image-id> local/extension-tee:rollback
# then point docker-compose at the tag or `docker run` it directly to restore the exact prior binary
```
Nothing in §3-4 (the ext-proxy-only path) touches the escrow or the enclave's registered identity, so
rollback there is a plain config/container revert. The escrow deployed in §5 is a **new, separate**
contract — rolling it back just means going back to pointing the demo at the old
`0x5f32783D629E2acBb83f16628ad76D02A26CFB9B` (or whichever was live before), no on-chain undo needed.

## Monitoring

There are **two independent, verified ways** the enclave loop can silently break, and both need to be
watched — one is not a superset of the other:

1. **teeSigner identity drift** (§0.1: the enclave's identity key regenerates in memory on every
   `extension-tee` restart, with no persistence). A silent VPS reboot between now and judging rotates
   the live TEE signer address without any visible symptom — `/info` still returns 200, the site still
   loads, but every `lock()` with an enclave signature reverts (`DvPEscrow.teeSigner` no longer
   matches).
2. **TEE machine registration drift** — the machine registered on-chain for our extension
   (`getRandomTeeIds`) can point at a dead machine after a rebuild, silently dropping every
   ONCHAIN-routed instruction. `/direct` is unaffected and `/info` stays HTTP 200 throughout, so
   nothing else notices either. This is exactly what happened on 25 Jul.

`scripts/enclave-loop/monitor.mjs` runs **both** checks in one process (reusing the shared derivation
/ fetch / on-chain-read logic in `scripts/enclave-loop/lib/enclave.mjs`, also used by
`healthcheck.mjs` and `onchain-ingress-readiness.mjs` individually) — install `monitor.mjs` on cron,
not `healthcheck.mjs` alone, or the machine-registration failure mode goes unwatched again.

**Install this on the VPS** (not done by this checklist — a human runs it), every 15 minutes:

```cron
*/15 * * * * cd /root/whisperdesk-web && /usr/bin/node scripts/enclave-loop/monitor.mjs >> /var/log/whisperdesk-healthcheck.log 2>&1 || echo "WhisperDesk monitor exit=$? at $(date -u)" >> /var/log/whisperdesk-healthcheck-alerts.log
```

Adjust the `cd` path to wherever the repo actually lives on the VPS (the cron runs from
`/root/whisperdesk-web`, not `/root/whisperdesk/enclave-loop` — a previous version of this doc had
the wrong path), and point `node` at the right binary if it's not on cron's default `PATH`.
`monitor.mjs` needs no flags to run the real check — it defaults `EXT_PROXY_URL`/`ESCROW_ADDRESS`/
`COSTON2_RPC`/`FLARE_TEE_MANAGER`/`EXT_ID` to the live judge-facing values, override via env if
you're pointing it at a different deployment.

**Exit codes** (see the header comment in `monitor.mjs` for the authoritative version):

| Exit | Meaning | Action |
|---|---|---|
| `0` | OK — both checks pass (one `OK <check>: ...` line per check, quiet otherwise) | none |
| `1` | DRIFT — enclave reachable, but at least one check failed | stderr names exactly which check(s) drifted and prints the exact fix command: `setTeeSigner` for the teeSigner check, pause the stale machine + `post-build.sh` for the machine-registration check |
| `2` | DOWN — `/info` unreachable, non-200, malformed, or an RPC/contract read failed | enclave or RPC is broken — check `docker compose ps`/logs on the VPS before assuming a drift |
| `3` | (only via `--selftest`) offline derivation math itself is broken | should never fire from the cron line above; means `ethers` or the script changed, not a deployment issue |

Exit `1` is the one that matters most before judging: either failure mode means the demo will fail on
the very first `lock()` or the very first ONCHAIN-routed RFQ a judge tries, even though the site looks
fully up. Treat any `1` in the alert log as same-day, not "next time someone's on the VPS."

`healthcheck.mjs` (teeSigner check only) and `onchain-ingress-readiness.mjs` (machine registration +
signing-policy check, with more diagnostic detail) still exist standalone with the same CLI and exit
codes as before, for manual runs and because they're referenced directly elsewhere in this doc — but
the cron should run `monitor.mjs`, not `healthcheck.mjs` alone, so neither blind spot goes unwatched.

## Onchain RFQ ingress (submitRfq)

Prepared locally only — nothing below has been deployed, sent, or committed. `WhisperDeskInstructionSender.sol`
is implemented and green (`forge test`, 17/17), but it is **not yet deployed anywhere on Coston2** — it is
absent from `.claude/context/deployments.md` and from `contracts/broadcast/DeployIntegration.s.sol/114/run-latest.json`
(which only deployed `MockFXRP`/`BondLedger`/`DvPEscrow`). Deploying + wiring it in is a **separate, deliberate
action** for a human to run in one window — this section is the record for that window.

### Scout verdict (verbatim)

> **NO_REREGISTRATION_NEEDED** — DEFINITIVE, on-chain-verified: pre-build.sh does NOT need to be re-run. The live
> extension (id 65641 / 0x...010069) can be pointed at a new WhisperDeskInstructionSender via one governance-style
> call, with zero effect on the TEE machine, the TEE signer key, or any tee-proxy/tee-node config.
>
> 1) How the relay decides whose instructions to accept — it is on-chain only, not env-only, not "both." The
> registry rejects any `sendInstructions` call where `msg.sender` doesn't match the registered InstructionSender
> (`fce-extension-scaffold/docs/instruction-sender.md:5-7`). Neither `tee-proxy` nor `tee-node` reference
> `INSTRUCTION_SENDER`/`instructionSender` anywhere (grepped both repos, zero matches) — the relay's own filtering
> (`tee-proxy/pkg/machinepath/machinepath.go:100-148`) keys purely on `extensionID`, never on sender-contract
> address. There is no env var, no proxy-side allowlist to edit. The swap takes effect for the very next
> `sendInstructions()` call after the tx lands — no extension-tee restart, no TEE-key rotation, no `register-tee`
> re-run.
>
> 2) `register-tee`/MachineManager (`tee-node/internal/node/node.go:82-88`) keys TEE *machines* by `extensionId`,
> not by instructions-sender address — changing the sender doesn't touch machine registration at all.
>
> 3) The setter exists and is owner-gated, and the existing deployer key already IS that owner. The real generated
> binding — `go-flare-common@v1.2.2-...-c573c79c0924/pkg/contracts/tee/extensionmanager/autogen.go:917` —
> `setExtensionContracts(uint256 _extensionId, address _teeExtensionStateVerifier, address _teeExtensionInstructionsSender)`,
> selector `0x6df0108f`, updates an EXISTING extension id's sender in place (distinct from `Register()`, which
> mints a new id — the scaffold's own `registerExtension()` only ever calls `Register()`, which is why re-running
> `pre-build.sh` always mints a new id; that's a scaffold-script limitation, not a contract limitation). All TEE
> facets are bound to one diamond proxy, `FlareTeeManager`, at `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` on
> Coston2. Live read-only `eth_call` (Coston2 RPC, 25 Jul 2026), extension id 65641:
> - `getTeeExtensionInstructionsSender(65641)` = `0x6C2CA15B0c9459a71807e6Fb134874609E9c8790` (matches the
>   currently-live sender and `deployments.md` exactly)
> - `getExtensionOwner(65641)` = `0xf4E45BCC0c7dE24bE0c00107C91fb12544B9e125` (matches the deployer key exactly)
> - `getExtensionOperator(65641)` = `0x0` (unset); `getTeeExtensionStateVerifier(65641)` = `0x0` (unset)
> - `nextPublicExtensionId()` = `0x1009a` (65690) — confirms the next `pre-build.sh` run really would mint a fresh
>   id, the orphaning risk already documented in `flare-docs/fcc-fce.md` and `deployments.md`.
>
> Simulated (`eth_call` only — no broadcast, no state change, no gas) call to
> `setExtensionContracts(65641, address(0), <placeholder new sender>)`:
> - from the deployer/owner key → **no revert**.
> - from an unrelated random address → reverts with selector `0xcd49fd1d`, decoded against the ABI's error
>   list as `OnlyExtensionOwner()`. Triple-confirmed on-chain: the function is genuinely access-controlled, and
>   the existing deployer key already passes that check for extension 65641 today.
>
> 4) The Go extension trusts the **sender field embedded in the instruction payload**, not "which contract sent
> this." `fce-extension-scaffold/internal/wd/fcewire/handler.go` (`decodeRfqEnvelope`) unpacks
> `message = abi.encode(msg.sender, ciphertext)` and takes party identity only from that envelope, never from
> decrypted plaintext. The Go handler has no independent check of which contract address originated the
> instruction — it relies entirely on layer (3)'s on-chain enforcement. As long as the new
> `WhisperDeskInstructionSender.sol` correctly does `abi.encode(msg.sender, ciphertext)` in `submitRfq`, the swap
> is transparent to the Go handler — no code change needed there either.

**Wire-compatibility cross-check performed in this pass** (against the actual `extension/fcewire/handler.go` in
this repo, not the scaffold copy the scout cited — same contract, confirmed independently):
- `envelopeArgs = abi.Arguments{{Type: addressTy}, {Type: mustBytesType()}}` in `decodeRfqEnvelope` = `(address, bytes)`,
  exactly matching `WhisperDeskInstructionSender.submitRfq`'s `message: abi.encode(msg.sender, ciphertext)`.
- `opHash()` in `handler.go` right-pads the ASCII string into a fixed `[32]byte` — byte-identical to Solidity's
  `bytes32("...")` literal. The Go string constants (`extension/fcewire/config.go`) are `OPTypeWDRFQ = "WD_RFQ"`,
  `OPCommandRfqSubmit = "RFQ_SUBMIT"`, `OPCommandRfqMatch = "RFQ_MATCH"` — these match
  `WhisperDeskInstructionSender.sol`'s `OP_TYPE_WD_RFQ`/`OP_COMMAND_RFQ_SUBMIT`/`OP_COMMAND_RFQ_MATCH` constants
  character-for-character.
- `decodeRfqID`'s `len(data) == 32` fast path matches `triggerMatch`'s `message: abi.encode(rfqId)` — `abi.encode`
  of a lone static `bytes32` has no offset/length word, so it is the raw 32 bytes; confirmed both by inspection
  and by `test_TriggerMatch_PayloadDecodesToRfqId` asserting `message.length == 32` and `bytes32(message) == rfqId`.
- **No mismatch found. No contract change was needed.**
- The `msg.sender`-binding security property is proven by
  `test_SubmitRfq_DifferentCallerYieldsDifferentEncodedSender`: two different `vm.prank`'d callers each produce
  a decoded sender equal to themselves and never equal to the other — i.e. a caller cannot make the envelope
  claim to be anyone but itself (the EVM guarantees `msg.sender` cannot be forged by the caller; this test proves
  the contract's encoding preserves that guarantee rather than substituting some spoofable self-attested field).

### Exact steps (from the scout, to run in one deliberate window)

1. Deploy `contracts/src/WhisperDeskInstructionSender.sol` to Coston2 from the existing deployer key
   (`0xf4E45BCC0c7dE24bE0c00107C91fb12544B9e125`). Its constructor + `setExtensionId()` auto-discover extension id
   65641 from the registry — nothing to hardcode. Record the deployed address in `.claude/context/deployments.md`
   per `.claude/rules/flare-integration.md`.
2. (Optional, cheap) Sanity-check the new contract's bytecode is present on-chain (`validate.AddressHasCode`
   pattern, `fce-extension-scaffold/tools/cmd/register-extension/main.go:36`).
3. Call `FlareTeeManager` (diamond proxy) at `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` on Coston2:
   `setExtensionContracts(65641, address(0), <new WhisperDeskInstructionSender address>)`, selector `0x6df0108f`,
   from the deployer/owner key. One transaction — no `pre-build.sh`, no `register-tee`, no `post-build.sh`, no
   docker/container restart. **Pass `address(0)` for `_teeExtensionStateVerifier`** to preserve its current
   (unset) value.
4. After the tx mines, re-read `getTeeExtensionInstructionsSender(65641)` via `eth_call` and confirm it now
   returns the new address; check the emitted `TeeExtensionContractsSet` event.
5. Do nothing else — no env var changes, no restart of `tee-proxy`/`tee-node`/`extension-tee`, no changes to
   `internal/wd/fcewire/handler.go` or `config.go`. The old sender (`0x6C2CA15B0c9459a71807e6Fb134874609E9c8790`)
   remains deployed but becomes inert for this extension immediately — any future call it makes to
   `sendInstructions()` will revert on `msg.sender` mismatch.
6. Log the change in `.claude/context/deployments.md` (new sender address, tx hash, timestamp). Unlike the Step 3
   FCE registration entry (irreversible), this action IS repeatable/correctable — `setExtensionContracts` can be
   called again later to point at yet another sender.

### Risks

- `setExtensionContracts` is owner-privileged and immediately effective, with no dry-run/timelock observed in the
  simulation — get the new sender address exactly right before broadcasting. A wrong address breaks RFQ ingress
  until corrected (recoverable, but do this well before demo day, not last-minute).
- The registry does not inspect the new contract's code at all
  (`fce-extension-scaffold/docs/instruction-sender.md:46`). If `submitRfq` did not encode
  `message = abi.encode(msg.sender, ciphertext)` exactly as `handler.go`'s `decodeRfqEnvelope` expects, RFQ
  submissions would silently fail sender-binding checks — **this pass re-verified the encoding matches exactly
  against this repo's actual `handler.go`** (see cross-check above), so this specific risk is closed for the
  current source, but re-check it again if either side changes.
- Passing anything other than `address(0)` for `_teeExtensionStateVerifier` in the same call would also change
  that field (currently unset) — verify calldata encodes exactly `(65641, 0x0, newSenderAddr)`.
- A possible governance timelock on this facet beyond what the live `eth_call` simulation showed was not fully
  ruled out (the ABI lists a `GovernanceCallTimelocked` event, inferred to be scoped to system-wide setters, not
  per-extension owner calls, based on the simulation result and function grouping — not on reading the facet's
  Solidity source, which wasn't available locally).
- Everything above (scout's steps 1-6) was investigated read-only via `eth_call` simulation and public getters
  only — **no transaction has been sent, and `WhisperDeskInstructionSender` has not been deployed**. Treat the
  exact steps as validated-but-unexecuted; confirm the real broadcast tx succeeds and re-check
  `getTeeExtensionInstructionsSender(65641)` afterward before treating the swap as done.

### GO/NO-GO

**GO**, with the deploy step still to run. The contract implementation, its `msg.sender`-binding security
property, and its wire format were independently re-verified in this pass against the actual
`extension/fcewire/handler.go` in this repo (not just the scaffold copy the scout inspected) with no mismatch
found and no contract change required; `forge build`/`forge test` are green at 117/117 (100 pre-existing + 17
new). The remaining risk is entirely operational (a single owner-gated `setExtensionContracts` call plus the
prerequisite deploy), not a code-correctness question — switching the live extension is safe to attempt in a
deliberate window, following the exact steps above, with `.claude/context/deployments.md` updated immediately
after.

## Fixing the stale TEE machine registration (the last onchain-ingress gap)

**Symptom.** `submitRfq` lands onchain correctly, but the enclave never consumes the instruction.
`node scripts/enclave-loop/onchain-ingress-readiness.mjs` reports check A as STALE.

**Cause (verified on-chain 25 Jul).** `getRandomTeeIds(65641, 1)` returns
`0x1832e33F99cF5628f6Dc7Ae34e6011995BFdE4BD` — the TEE identity from before the 24 Jul WD_RFQ
rebuild. The running enclave is `0x56564F61588bB110E0712c3938aDa4338e6cc18B`. The identity key
regenerates on every enclave boot, so the rebuild orphaned the registration and onchain instructions
are routed to a machine that no longer exists. `/direct` bypasses machine routing entirely, which is
why the live demo and the enclave loop are unaffected.

Note the signing policy is NOT the blocker: the enclave's `lastSigningPolicyId` (5857) matches
`FlareSystemsManager.getCurrentRewardEpochId()` (5857). ext-proxy's repeated
`signing policy 5858 not yet on chain; waiting` is ordinary look-ahead for the next epoch.

**Fix — two transactions, in this order.** `MachineManager` has no remove/deregister; it has
`pause(address)` (gated `NotOwnerOrPauser`) and the old machine's owner is our deployer key, so the
dead machine can be taken out of rotation. Pause FIRST so a slot is free before registering — the
ABI does define a `TooMany` error and the per-extension cap is unknown.

```bash
# 1. take the dead machine out of rotation (simulated clean from the deployer key)
cast send 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE "pause(address)" \
  0x1832e33F99cF5628f6Dc7Ae34e6011995BFdE4BD \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc --private-key $PRIVATE_KEY

# 2. register the enclave that is actually running (⛔ irreversible-ish — read §0.1 first)
ssh root@76.13.179.205
cd /root/whisperdesk/fce-extension-scaffold && ./scripts/post-build.sh

# 3. confirm, then re-test the onchain path
node scripts/enclave-loop/onchain-ingress-readiness.mjs      # expect READY
```

`post-build.sh` runs allow-tee-version → set-governance → register-tee. Because the running enclave's
teeID is not yet registered, register-tee takes the `PreRegistration` branch (a fresh registration,
not a re-registration), so the `ChallengeExpired` hazard that motivates `-command rRap` does not
apply — the default `rap` is correct here. Do NOT restart `extension-tee` during this: another boot
would rotate the identity again and invalidate the registration you just made (and
`DvPEscrow.setTeeSigner` with it).
