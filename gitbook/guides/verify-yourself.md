# Verify it yourself

Every check below runs from a fresh clone of [`github.com/EndPx/whisperdesk`](https://github.com/EndPx/whisperdesk).
None of them need our keys, our config, or our word for it — each one reads Coston2 (and, for the
enclave monitor, the live enclave) directly and asserts something specific about the running
system.

## What you need

Node 20+ covers the first two checks. The contract suite needs
[Foundry](https://getfoundry.sh) (`curl -L https://foundry.paradigm.xyz | bash && foundryup`). The
e2e runners need Foundry, Node, and your own funded testnet keys — you deploy your own escrow
instance, so nothing here depends on desk-held funds.

## 1. Enclave monitor — is the live enclave the one the contracts actually trust?

```bash
cd scripts/enclave-loop && npm install && node monitor.mjs
```

**What it proves:** it reads the live enclave (`https://fce.endpx.cloud/info`) and Coston2 state
side by side and asserts all four of: the escrow trusts the running enclave's key, the TEE
registry routes instructions to it, its registered machine status is `PRODUCTION`, and the URL
registered onchain is the one actually serving requests. Exit `0` means all four passed. This is
also the check that watches for the enclave's identity key regenerating on restart — expected in
simulated-TEE mode, and exactly what a persistent identity in the roadmap would remove the need
for.

## 2. On-chain RFQ ingress — can a taker's identity be forged?

```bash
cd scripts/enclave-loop && npm install && node verify-onchain-rfq.mjs
```

**What it proves:** it decodes the first `submitRfq` instruction event straight from Coston2 and
checks that the message is `abi.encode(<the transaction's own sender>, <ECIES ciphertext>)` — i.e.
the taker address was stamped by `WhisperDeskInstructionSender` from `msg.sender`, not supplied by
the client. A caller cannot claim to be a different taker through this path.

## 3. Contract suite — do the settlement rules hold?

```bash
cd contracts && forge test --summary
```

**What it proves:** every invariant the desk depends on — `ecrecover == teeSigner`, the FTSOv2
±1% band re-check, FDC proof binding to one escrow instance, deadline handling, bond slashing —
holds under unit tests, fuzz/invariant tests, and two suites that fork Coston2 directly (so those
two need network access).

| Suite | Tests |
|---|---|
| `BondLedgerTest` | 17 |
| `DvPEscrowTest` | 66 |
| `ForkFdcReleaseTest` | 3 |
| `ForkFtsoBandTest` | 4 |
| `GoldenVectorsTest` | 4 |
| `InvariantsTest` | 4 (fuzz/invariant) |
| `MatcherToLockTest` | 2 |
| `WhisperDeskInstructionSenderTest` | 17 |
| **Total** | **117 passed, 0 failed** |

## 4. End-to-end runners — does a real DvP trade actually settle, and does default actually slash?

Deploy your own `DvPEscrow` instance — you become its owner and `teeSigner`, so you can self-sign
and run the whole flow without needing our enclave:

```bash
cd contracts && forge script script/DeployIntegration.s.sol --rpc-url coston2 --broadcast --slow
cd ../scripts/e2e && npm install
# repo-root .env: PRIVATE_KEY, TAKER_PRIVATE_KEY, MAKER_PRIVATE_KEY (funded via https://faucet.flare.network)
#                 XRPL_MAKER_SEED (https://faucet.altnet.rippletest.net), XRPL_TAKER_ADDRESS
ESCROW_ADDRESS=0x... npm run happy-path     # lock -> real XRPL payment -> fresh FDC proof -> release
ESCROW_ADDRESS=0x... npm run default-path   # lock -> no payment -> wait refundAfter+grace -> refund + bond slash
```

**What it proves:** `happy-path` proves a real DvP settlement clears — lock, a genuine XRPL
payment, a freshly generated FDC proof, then `release()` paying FXRP to the maker. `default-path`
proves the failure mode is a designed outcome, not an error — no payment arrives, the grace period
elapses, and a permissionless `refund()` returns the taker's principal plus the maker's slashed 1%
bond. Full steps and layout: `scripts/e2e/README.md`.

## 5. Real FAssets FXRP — reproduce the non-mock settlement

```bash
FXRP_ADDRESS=0x0b6A3645c240605887a5532109323A3E12273dc7 forge script script/DeployIntegration.s.sol --rpc-url coston2 --broadcast --slow
```

then point `happy-path.mjs` at the printed escrow address.

**What it proves:** the same mechanism, the same commands, settling against the genuine
FAssets-minted FXRP (`AssetManagerFXRP.fAsset()`,
[`0x0b6A3645…3dc7`](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7),
symbol `FTestXRP`) — the same asset the live demo now settles on every seat.

> **Not runnable from a standalone clone:** `extension/matcher`'s Go parity tests and
> `extension/smoketest/` resolve `tee-node` through a `replace` directive pointing at Flare's
> `fce-*` repos as sibling checkouts, which only exist on an operator machine. The parity they
> prove is also covered by `GoldenVectorsTest` / `MatcherToLockTest` in the contract suite above,
> which anyone can run.

---

Every claim in these docs carries an explorer link — [Coston2](https://coston2-explorer.flare.network)
or [XRPL Testnet](https://testnet.xrpl.org) — next to it. Nothing here has to be taken on trust.
