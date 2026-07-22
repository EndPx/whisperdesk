# FCE bring-up runbook (Step 3)

How to build and run the Flare Confidential Compute extension stack for WhisperDesk. The FCE clones
(`fce-extension-scaffold`, `tee-node`, `tee-proxy`) live as **siblings of this repo** under
`../fce/`. Status 22 Jul 2026: builds green, signing loop proven; the live Coston2 registration
(irreversible) is intentionally deferred — see the warning below.

## Environment gotchas (must-know)

- **Always `CGO_ENABLED=0`** on Windows. The default cgo build compiles go-ethereum's libsecp256k1 C
  sources and stalls 15+ min; `CGO_ENABLED=0` matches the scaffold's production Dockerfile and builds
  in <1 min/repo. `go build ./...` and `go test ./...` are clean in all three repos with it set.
- **go.mod replace path** (fixed): scaffold shipped `replace ...tee-node => ../../tee-node` (nested
  layout); our flat sibling layout needs `../tee-node`. Applied in `../fce/fce-extension-scaffold/go.mod`.
- **docker-compose build context** (identified, NOT yet applied — do before Path B step 6):
  `docker-compose.yaml` `extension-tee` uses `context: ../..` + `dockerfile:
  extension-examples/extension-scaffold/Dockerfile`, assuming a nested layout. Our flat clone needs
  `context: ..` (= `fce/`, which holds `tee-node/` as a sibling) + `dockerfile:
  fce-extension-scaffold/Dockerfile`, plus matching the Dockerfile's `COPY` source paths. Left
  unapplied deliberately: it can only be verified by running `docker compose up`, which is part of
  the deferred Path B bring-up.
- **SIMULATED_TEE ↔ MODE** must stay in sync: `SIMULATED_TEE=true` ⇔ image `MODE=1`, else
  "code hashes do not match". Coston2 hackathon path = `LOCAL_MODE=false` + `SIMULATED_TEE=true` + `MODE=1`.
- **chain_id consistency**: proxy config `chain_id`, extension `CHAIN_ID`, and the actual chain must
  all match (114 for Coston2) or the proxy panics with `InvalidTeePublicKeyOrSignature`.

## The signing loop is proven

`extension/smoketest/` confirms the TEE-side Go signature is `ecrecover`-compatible with
`DvPEscrow` (see that README). Step 4's handler must sign with the same `WD_MATCH_V1`-tagged
`Payload{prefix, chainId, dataHash}` + EIP-191 construction via the sign port (7701).

## Path B — live Coston2 (LOCAL_MODE=false, SIMULATED_TEE=true, MODE=1)

The hackathon-intended path (Path A, fully-local, needs a Hardhat devnet + local indexer + a normal
TEE/proxy pair we don't have — not viable here). Ordered steps:

1. `.env.coston2` from `.env.example`: `CHAIN_URL` = Coston2 RPC, `ADDRESSES_FILE` =
   `./config/coston2/deployed-addresses.json`, `LOCAL_MODE=false`, `SIMULATED_TEE=true`,
   `INITIAL_OWNER`/`DEPLOYMENT_PRIVATE_KEY` = funded deployer, `NORMAL_PROXY_URL` =
   `https://tee-proxy-coston2-1.flare.rocks`, `EXT_PROXY_URL` unset for now.
2. Fill `config/proxy/extension_proxy.coston2.docker.toml` `[db]` with the verified Indexer DB creds
   (`INDEXER_DB_*` from `.env` — host 34.38.42.208:3306, db `indexer`).
3. Public tunnel FIRST: `ngrok http 6674` (or cloudflared). Copy the HTTPS URL into `EXT_PROXY_URL`.
   (The VPS at `srv1330754.hstgr.cloud` can host this instead of ngrok — reverse-proxy 443→6674.)
4. `./scripts/use-chain.sh coston2` (copies `.env.coston2` → `.env`).
5. ⛔ **`./scripts/pre-build.sh` — IRREVERSIBLE.** Deploys `InstructionSender` + registers a NEW
   extension ID on the live `TeeExtensionRegistry`. Run **exactly once**; `--force` mints a second ID
   and orphans the first (later machine registration then hits `MachineManager.TooMany()`).
6. `./scripts/start-services.sh --chain coston2` → confirm `curl -sf http://localhost:6674/info`.
7. ⛔ **`./scripts/post-build.sh` (`register-tee -command rRap`) — IRREVERSIBLE-ish.** Registers the
   TEE machine identity. Use capital `R` in `rRap` on every run (lowercase → `Verification.ChallengeExpired`).
8. `./scripts/test.sh` — generic SAY_HELLO round-trip; proves the FCE loop before Step 4's matcher.

### Closing the ecrecover loop
Read the TEE identity address (`curl $EXT_PROXY_URL/info`), then from the escrow owner key call
`DvPEscrow.setTeeSigner(<teeAddress>)` (Coston2 `0xf8A54aA4187a9e4eCFC5814B498499c032f2601e`). This is
reversible and re-callable — the only one-shot actions are pre-build.sh and register-tee above.

> **Why deferred:** steps 5 & 7 are one-shot on-chain actions with no undo. They are held until a
> human is present to run them once, correctly, rather than risk burning the extension ID unattended.
