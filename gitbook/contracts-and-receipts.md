# Contracts & Receipts

All addresses, transactions, and infrastructure below are **Coston2** (chainId `114`) and
**XRPL Testnet** only. Every row in this page is a live, independently verifiable artifact — not a
claim. Where the README frames a limit (simulated-TEE, MockFXRP in the interactive demo, the
1-FXRP testnet override), this page states it plainly rather than smoothing it over.

## Live infrastructure

| Component | Address / URL |
|---|---|
| FCE `/info` (signed `TeeInfo`) | https://fce.endpx.cloud/info |
| FCE extension ID | `0x…010069` (65641) |
| WhisperDeskInstructionSender | `0x56A903F408C4745D34354Ec230BbfBDD78eC6426` |
| Live TEE signer | `0x56564F61588bB110E0712c3938aDa4338e6cc18B` |
| DvPEscrow — **public one-click demo** | `0x5f32783D629E2acBb83f16628ad76D02A26CFB9B` |
| DvPEscrow — **enclave loop** (`teeSigner` = the live enclave) | `0x20A885cb6ed3F652C5Fcb6a683CE74436F6a7023` |
| MockFXRP (mintable, 6 dec) | `0x700bfC3620585eb42F1Dda6aBA3Ac8E793859FBE` |
| BondLedger | `0xC2f2F46A126E542E8178e2cc8fdC13aF3A48E156` |
| FtsoV2 (real Coston2 registry) | `0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d` |
| FdcVerification (real) | `0x906507E0B64bcD494Db73bd0459d1C667e14B933` |

Two more `DvPEscrow` instances exist outside the table above, used for the real-FXRP settlement:

| Component | Address / URL |
|---|---|
| DvPEscrow — **real-FXRP run** | `0xfa0895ce6af9ef9764afbb967d822dadc13ae087` |
| Real FXRP token (`AssetManagerFXRP.fAsset()`, symbol `FTestXRP`, 6 dec) | [`0x0b6A3645c240605887a5532109323A3E12273dc7`](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7) |

> No `mint()` exists on the real FXRP token — it can only be acquired the way the FAssets protocol
> intends. See [Real-FXRP run](#settled-against-the-real-fassets-fxrp) below for how we got it.

Verify the enclave/registry/instance binding yourself — needs only Node, no keys, no config:

```bash
cd scripts/enclave-loop && npm install && node monitor.mjs
```

It asserts all four: the escrow trusts the running enclave's key, the registry routes instructions
to it, its machine status is `PRODUCTION`, and the URL registered onchain is the one actually
serving. Exit 0 means all four passed.

---

## Happy path + default path

Ran against the **public one-click demo** escrow (`0x5f32783D…CFB9B`), signed by the integration
instance's registered `teeSigner` key (simulated-TEE custody, same `WD_MATCH_V1` / `ecrecover`
scheme as the enclave — byte-compatibility proven in `extension/smoketest/`).

| Step | Receipt |
|---|---|
| XRPL payment (maker → taker, exact drops + destination tag) | https://testnet.xrpl.org/transactions/097B23FD6F4C3FF6740A956838A180C29950DD3E05343786E95930116B18BAA6 |
| `release()` — maker received FXRP against FDC proof | https://coston2-explorer.flare.network/tx/0x2c162613abea611d7b09c50251b35936b6d7c8599daea17016d952591a17202f |
| `refund()` — taker got principal + 1% slashed bond after no payment | https://coston2-explorer.flare.network/tx/0x1605a2ced9852f9caefebf6339cac3d294758f9d5e30c968208d2a4c0cc1feed |

Both flows ran end-to-end against real Coston2 + real XRPL Testnet + the real FDC verifier/DA
layer. Every trade here is 1 FXRP against the testnet-only `MIN_BLOCK_FXRP` override — the desk's
canonical policy is a 5,000 FXRP minimum block; the deployed integration instance sets it to `1e6`
(1 FXRP) because a 5,000-FXRP block needs ~5,000 XRP of counter-payment on the XRPL leg, which a
faucet-funded testnet account cannot move.

---

## The enclave loop — signed by the live enclave, end to end

The run that matters for Bounty 2: **nothing was self-signed**. A sealed (ECIES) RFQ went into the
live enclave, a maker quote was authenticated inside it by EIP-712, the enclave matched them and
signed the `MatchInstruction` with its own in-enclave key, and the escrow accepted that signature
onchain (`ecrecover == teeSigner`) before the FDC-proven XRPL payment released the FXRP — one
continuous flow.

| Stage | Receipt |
|---|---|
| Sealed RFQ → enclave (`rfqId` = keccak256 of the ciphertext) | `0xddea516f…da38` |
| Enclave signer, verified by local `ecrecover` before any tx | [`0x56564F61…c18B`](https://coston2-explorer.flare.network/address/0x56564F61588bB110E0712c3938aDa4338e6cc18B) |
| `lock()` — escrow accepted the **enclave's** signature | https://coston2-explorer.flare.network/tx/0x58ec0e5e8e7b4e8ec85b86be863c62565a1292c210420e36b5f382196de5d1db |
| XRPL payment (1,005,708 drops, destination tag 1) | https://testnet.xrpl.org/transactions/D44BAE4B51F3A5B0F9CAF8510E4308A331547B1BFDDA5EF3059AB26DC9DB548A |
| FDC attestation request (voting round 1405105) | https://coston2-explorer.flare.network/tx/0x36e9e649b8d123369dbe0ede36fa2703bce8deb701c0f0270ab7689802f0a5e8 |
| `release()` — maker received 1.0 FXRP | https://coston2-explorer.flare.network/tx/0xb6b01c627771323542db03e7a911026139aa1e5a4e81c65dfd08866e21cbdfad |

Escrow: [`0x20A885cb…7023`](https://coston2-explorer.flare.network/address/0x20A885cb6ed3F652C5Fcb6a683CE74436F6a7023)
— its `teeSigner` **is** the live enclave. Reproduce with `scripts/enclave-loop/` (see that
directory plus `extension/fcewire/PROTOCOL.md` for the wire protocol).

---

## Chain-authenticated RFQ ingress

[`WhisperDeskInstructionSender`](https://coston2-explorer.flare.network/address/0x56A903F408C4745D34354Ec230BbfBDD78eC6426)
(`0x56A903F4…6426`) is deployed and is the **registry-enforced** instruction sender for extension
`65641` — the TEE registry rejects `sendInstructions` from any other contract, so this is the only
address that can originate a `WD_RFQ` instruction.

| Step | Receipt |
|---|---|
| Registry swap — `setExtensionContracts(65641, 0x0, 0x56A903F4…)` | https://coston2-explorer.flare.network/tx/0x00394192a6947f3f2dfc7b7b4ac4d2fabf841d002be77aaa89c4c4b6bf189519 |
| First onchain `submitRfq` | https://coston2-explorer.flare.network/tx/0xd50dd58c2dd66747dc1caa97077c64a4119b2efe4fb48ced14b3c15b50eef69a |

Decoding that transaction's instruction event, the message is
`abi.encode(0xBF164f13…c4F6, <ECIES ciphertext>)` — the taker address was written by the *contract*
from `msg.sender`, not supplied by the client. A caller cannot claim to be a different taker
(`contracts/test/` proves the binding; 117/117 tests green). Verify it yourself against live chain
state:

```bash
cd scripts/enclave-loop && npm install && node verify-onchain-rfq.mjs
```

### Full settlement through the onchain ingress

Identity is chain-authenticated the whole way — RFQ and match trigger onchain; the quote itself
goes over `/direct` because quotes are private maker data and never touch the chain.

| Stage | Receipt |
|---|---|
| `submitRfq` onchain — taker bound from `msg.sender` | https://coston2-explorer.flare.network/tx/0x212a33d771927a1b36b46b22da4b7d5dc739ebbad9cdb760825417c45299c481 |
| `triggerMatch` onchain → enclave matched + signed | https://coston2-explorer.flare.network/tx/0x94ab3378bf6571c6f2235034b18e13e0c578d77e01bad1d6c9a8ce17d975ee0d |
| `lock()` — escrow accepted the enclave's signature | https://coston2-explorer.flare.network/tx/0x7550a805531c03e2890d2b42ce8c34dc4baa136d82b63d0d2f1c3657af2c89a7 |
| XRPL payment | https://testnet.xrpl.org/transactions/D0F1D1F4BD9A4EA202341847BE9ECF5236C08249696DA45D2BEC384C014AA4D9 |
| `release()` — maker received 1.0 FXRP | https://coston2-explorer.flare.network/tx/0xcd660e692e9445f458ca99f285b2d405ffe702585bb4c5d90125c0b4c2811573 |

> **Scope note.** The receipts in this table came in over `POST /direct`
> (`WD_ALLOW_DIRECT_RFQ=true`), where the taker identity in the envelope is self-attested — that's
> the ingress the website's one-click demo uses, because it has to finish inside a browser session.
> The chain-authenticated ingress (`WhisperDeskInstructionSender.submitRfq`, table above) is the
> real design: deployed, registry-enforced, and settled end to end. Everything downstream of either
> ingress is identical — sealing, in-enclave matching, EIP-712 maker auth, enclave signing, and the
> onchain `ecrecover` check.

---

## Settled against the real FAssets FXRP

Same mechanism, same commands — but the asset is the genuine FAssets-minted FXRP
([`0x0b6A3645…3dc7`](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7),
symbol `FTestXRP`), on a dedicated escrow instance
([`0xfa0895ce…e087`](https://coston2-explorer.flare.network/address/0xfa0895ce6af9ef9764afbb967d822dadc13ae087)).

No `mint()` exists on the real asset — we acquired it the way the protocol intends: a **v1.3
direct mint we initiated ourselves**. 10.2 XRP went from our XRPL account to the FAssets Core Vault
with the 32-byte direct-minting memo, and the protocol's executor minted 10.0 FXRP to our address
(the 0.1 XRP executor fee is exactly what pays for that execution). The settlement wallets were
then funded by transfer from that balance — the run's transcript says so explicitly.

**Direct-mint provenance:**

| Step | Receipt |
|---|---|
| XRPL payment → Core Vault (10.2 XRP, direct-minting memo) | https://testnet.xrpl.org/transactions/833E5C138006185960338AB0707768401E35AD2A53A203EDF2D076C473081AC0 |
| FAssets mint — 10.0 real FXRP to our address | https://coston2-explorer.flare.network/tx/0xfc5255afa0cadee272275fa018b3a21a0b6aa69b497f01cae622045c5eb55c4d |

**Settlement, on the real-FXRP escrow:**

| Step | Receipt |
|---|---|
| `lock()` on the real-FXRP escrow | https://coston2-explorer.flare.network/tx/0x874e167d710c04f1c670c779288f620003061dc9f808d5284bfeef0ba9cc7dbb |
| XRPL payment (1,000,000 drops, destination tag 1) | https://testnet.xrpl.org/transactions/9188C50DC94E3D3B314B5B99E5ABE4DB3585E1C926ABB3125542EA20B3490ADF |
| FDC attestation request (voting round 1414419) | https://coston2-explorer.flare.network/tx/0x7c990bea581a5aa0f1b01e63d689c6b1b7e150678bc0ee5a0c18655ca6325371 |
| `release()` — maker received 1.0 **real** FXRP | https://coston2-explorer.flare.network/tx/0x9ea70cafebbf0e6b937216af9cea374d798e6eb0466b7104fe40fd7e256aaea3 |

Reproduce:

```bash
FXRP_ADDRESS=0x0b6A3645c240605887a5532109323A3E12273dc7 forge script script/DeployIntegration.s.sol --rpc-url coston2 --broadcast --slow
```

then point `happy-path.mjs` at the printed escrow.

---

## Scope, stated plainly

- **The interactive demo settles a MockFXRP test token** (mintable, unbacked) — the demo faucet has
  to hand every visitor FXRP, and the real asset cannot be conjured per visitor. The mechanism
  itself is not mock-bound: the real-FXRP run above proves it against the genuine FAssets asset on
  a second escrow instance.
- **The enclave runs in simulated-TEE mode** (attestation `magic_pass`, `SIMULATED_TEE=true`) — the
  path Flare states is eligible for judging; GCP Confidential Space is not required. The full
  onchain registration sits on top of it regardless: our own extension (`65641`), a TEE machine
  registered and at `PRODUCTION` status, and our own registry-enforced instruction sender. What
  simulated mode costs us is a hardware attestation and a persistent identity — the enclave's key
  regenerates on every restart by design, which is why `scripts/enclave-loop/monitor.mjs` watches
  for exactly that.
- **Two RFQ ingresses exist, and both work.** The onchain one (`WhisperDeskInstructionSender.submitRfq`)
  is the real design and stamps the taker from `msg.sender`, so identity cannot be forged. The
  one-click *demo* on the website uses `POST /direct` (API-keyed, self-attested taker), because it
  has to finish inside a browser session rather than wait on the auction window plus two extra
  onchain transactions.
- **Every trade in these receipts is 1 FXRP, not an institutional block.** The desk's canonical
  policy is a 5,000 FXRP minimum block (`MIN_BLOCK_FXRP`); the deployed integration instance
  (`contracts/script/DeployIntegration.s.sol`) sets it to `1e6` (1 FXRP) instead, because a
  5,000-FXRP block needs ~5,000 XRP of counter-payment on the XRPL leg, and a faucet-funded XRPL
  testnet account cannot move that.
- **The one-click demo is rate-limited** (3 runs per visitor per day, 20 globally) and runs on
  desk-held testnet keys — it is not "be the taker" with your own funds; that mode is separate (see
  the live demo at https://whisperdesk.endpx.cloud).
