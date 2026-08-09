# Contracts & Receipts

All addresses, transactions, and infrastructure below are **Coston2** (chainId `114`) and
**XRPL Testnet** only. Every row in this page is a live, independently verifiable artifact — not a
claim. Where the README frames a limit (simulated-TEE attestation, the 1-FXRP testnet override),
this page states it plainly rather than smoothing it over.

## Live infrastructure

| Component | Address / URL |
|---|---|
| FCE `/info` (signed `TeeInfo`) | https://fce.endpx.cloud/info |
| FCE extension ID | `0x…010069` (65641) |
| WhisperDeskInstructionSender | `0x56A903F408C4745D34354Ec230BbfBDD78eC6426` |
| Live TEE signer | `0x56564F61588bB110E0712c3938aDa4338e6cc18B` |
| DvPEscrow — **one-click seat** (`teeSigner` = owner, which self-signs its match) | `0x78768737b4AfD0e2Fd3676E8dA55E5ff1155fB5c` |
| DvPEscrow — **open desk** (`teeSigner` = the live enclave) | `0xB3C762634a86991A1e56530056dA05068DE2044C` |
| FXRP — genuine FAssets asset (`FTestXRP`, 6 dec) | `0x0b6A3645c240605887a5532109323A3E12273dc7` |
| BondLedger — one-click | `0xc90B84FDAB441149402AB86b0AaF9F7B4518F32B` |
| BondLedger — open desk | `0x72A577AddB04ff29C40107De927621E4Fb44c638` |
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
> (`WD_ALLOW_DIRECT_RFQ=true`), where the taker identity in the envelope is self-attested. That was
> true of these runs and is no longer how the site submits orders: RFQ submission goes through
> `WhisperDeskInstructionSender.submitRfq` from the taker's own wallet, so the taker is stamped from
> `msg.sender` rather than claimed.
>
> That path was down for a stretch and we blamed the wrong party. Every onchain submission 404'd and
> we attributed it to Flare's hosted FTDC proxy; the cause was our own TEE machine, registered
> on-chain under `http://localhost:6674`. Flare's data providers push to the URL recorded on-chain,
> so they were pushing at a loopback address that meant nothing to them.
> `updateTeeMachineSettings` corrected it and the machine reached `PRODUCTION` — note that
> `register-tee` will not update that URL for an already-registered machine, whatever flags you
> pass, because `Register()` is its only writer and it is skipped.
>
> `/direct` is still used for `RFQ_MATCH`, where it gives nothing away: that call is permissionless
> on either ingress, carries no secret, and names no party. Everything downstream of either ingress
> is identical — sealing, in-enclave matching, EIP-712 maker auth, enclave signing, and the onchain
> `ecrecover` check.

---

## Two strangers, one block, and a desk on neither side

Every other run on this page has the desk holding a leg — signing as maker in wallet mode, standing
in as taker in maker mode. That proves the machinery. It does not prove the product, which claims
two parties who have never met can trade a block through a venue that reads neither of their orders
and cannot pick the winner.

The taker below was **generated at the start of the run**. Open it on the explorer: this trade and
nothing else. Ninety seconds earlier it did not exist, so it cannot be the desk's standing
counterparty. The maker is a separate key that signed its own EIP-712 quote without ever seeing the
order's size or limit.

And the taker **wrote that order**. The desk publishes two bounds — `MIN_BLOCK_FXRP` off the escrow,
and `mid × (1 + BAND_BIPS)` off FTSOv2 — each read from the contract that enforces it, and the taker
picks a size and a limit inside them. That is the line between a venue and a counterparty: sealing
an order the desk composed itself would hide it from makers while leaving it in plain sight of
whoever wrote it.

| Stage | Receipt |
|---|---|
| Taker, created during the run | [`0x6e6F7743…77AA`](https://coston2-explorer.flare.network/address/0x6e6F7743A94E7748cb195E836f04c1599eF277AA) |
| Maker, a different key | [`0x35AC3BE4…CE3C`](https://coston2-explorer.flare.network/address/0x35AC3BE4d8D3841f394564983Ed7b3fC3666CE3C) |
| Taker's own `deposit()` | https://coston2-explorer.flare.network/tx/0x893978e65bb7fe3004721d3699c30ee6cd27d0130663a9c8c9353738a2907c51 |
| The order the taker chose | 1.0 FXRP, limit 1.030323 USD (ceiling that run: 1.045856) |
| Sealed RFQ published, `rfqId` = `matchId` | `0x755f5b90…2abb` |
| Maker's blind quote, above that limit | 1.035118 USD/XRP → `MATCHED` |
| XRPL payment — maker → the taker's own account | https://testnet.xrpl.org/transactions/36FFAA9A105019D7B63A08591F6E1AB0A0B5C434FBDF9D86F6BB85E9BE38F323 |
| `release()` — maker received 1.0 FXRP | https://coston2-explorer.flare.network/tx/0x2da3adc27e340f49ecec8f8023bdb85c899cb292256e5a4eddfae412c796fed0 |

The script checks the chain as it goes, and those checks passed: `matches().taker` ==
`0x6e6F7743…`, `matches().maker` == `0x35AC3BE4…`, and the escrow's XRP destination == the taker's
own XRPL account. Balances after: maker FXRP 4.8 → 5.8, taker XRP 100.999768 on an account that was
empty minutes earlier.

The bounds are enforced, not decorative — checked live against the deployed API. A size below the
block minimum, a limit above the band, and a zero limit are each refused with the reason:
`"minimum block is 1000000 raw FXRP"`, `"a limit above … can never fill: lock() re-reads the FTSOv2
mid"`, `"limit price must be positive"`.

What the desk did, in full: sealed the order, relayed two permissionless calls, paid their gas. It
held neither leg. The FXRP came out of the taker's own escrow deposit, the bond was the maker's own,
and the XRP went from the maker's XRPL account to the taker's.

Reproduce: `scripts/e2e/two-party-desk.mjs` — it generates a fresh taker every run, so no two runs
share a counterparty. This has now settled three times with three unrelated takers; the earlier two
released at
[`0x46353742…90ac`](https://coston2-explorer.flare.network/tx/0x46353742101183d8852ba788a1d3cfb012d7eea9110ece16ec0b7da45f5190ac)
and
[`0xe959c8eb…7e21c`](https://coston2-explorer.flare.network/tx/0xe959c8ebb84dfc79bd8538a119b71798c17251f5bfa8397ab0889d2e46f7e21c).

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

### Run again on 6 August 2026

"It worked once" and "it works" are different claims, so the whole thing was done a second time from
scratch — another direct mint, then another settlement on the same escrow with the same commands.
Nothing was reset or reused between the two runs.

| Step | Receipt |
|---|---|
| XRPL payment → Core Vault (10.2 XRP, second direct mint) | https://testnet.xrpl.org/transactions/68D0D0041A8780B7D0F6F2CEBCB18B5CF43880C966FC0D6DDE7B5EF9C184AF53 |
| FAssets mint — 10.0 more real FXRP | https://coston2-explorer.flare.network/tx/0xf2b1c06c81c215d82969ed2e6a4cdef23048dbf16eea301b3e8fc4f10d7bca4b |
| `lock()` | https://coston2-explorer.flare.network/tx/0x28b7dff170bd8e5ce1d0ae6ca81712cad0c5e5170ae72ee6ee719ab26aa4786b |
| XRPL payment (1,000,000 drops, destination tag 2) | https://testnet.xrpl.org/transactions/0C0DB6C6FB3ECCC9CAA7820B16987F4D3049CB14E26ACDF30A535D6B0BA12C1B |
| FDC attestation request (voting round 1417476) | https://coston2-explorer.flare.network/tx/0x7af3ef8548efbd6e2604f4ca0755d834b09984b093129ad36ac572059fee5061 |
| `release()` — maker received another 1.0 **real** FXRP | https://coston2-explorer.flare.network/tx/0x5934b0ac377ec4f256dd22216ab070ee14b5060ccf16559bc5667200d08ed6a3 |

The desk still holds real FXRP after both runs, so this is not a one-off that consumed its own
supply in order to exist.

Reproduce:

```bash
FXRP_ADDRESS=0x0b6A3645c240605887a5532109323A3E12273dc7 forge script script/DeployIntegration.s.sol --rpc-url coston2 --broadcast --slow
```

then point `happy-path.mjs` at the printed escrow.

---

## Scope, stated plainly

- **The demo settles the genuine FAssets asset** (`FTestXRP`, 6 dec) on both escrows. A mintable
  stand-in used to sit here, because a demo faucet has to fund every visitor and the real asset
  cannot be conjured per visitor — until Flare's own faucet turned out to hand out 10 FXRP per
  address per day. Both escrows were redeployed against the real token and the mock retired.
  Nothing the desk runs can mint FXRP; it exists only against XRP locked in FAssets.
- **The enclave runs in simulated-TEE mode** (attestation `magic_pass`, `SIMULATED_TEE=true`) — the
  path Flare states is eligible for judging; GCP Confidential Space is not required. The full
  onchain registration sits on top of it regardless: our own extension (`65641`), a TEE machine
  registered and at `PRODUCTION` status, and our own registry-enforced instruction sender. What
  simulated mode costs us is a hardware attestation and a persistent identity — the enclave's key
  regenerates on every restart by design, which is why `scripts/enclave-loop/monitor.mjs` watches
  for exactly that.
- **Two RFQ ingresses exist; the live site is on the weaker one today.** The onchain one
  (`WhisperDeskInstructionSender.submitRfq`) is the real design and stamps the taker from
  `msg.sender`, so identity cannot be forged — it is deployed, registry-enforced and has settled end
  to end. It routes through Flare's hosted FTDC proxy, which now answers our machine-availability
  check with a 404, so nothing arrives that way. The site therefore runs on `POST /direct`
  (API-keyed, self-attested taker). That costs attribution, not safety: `lock()` reserves the FXRP
  from the named taker's own armed deposit and pays the XRP to the address sealed beside it.
- **Every trade in these receipts is 1 FXRP, not an institutional block.** The desk's canonical
  policy is a 5,000 FXRP minimum block (`MIN_BLOCK_FXRP`); the deployed integration instance
  (`contracts/script/DeployIntegration.s.sol`) sets it to `1e6` (1 FXRP) instead, because a
  5,000-FXRP block needs ~5,000 XRP of counter-payment on the XRPL leg, and a faucet-funded XRPL
  testnet account cannot move that.
- **The one-click demo is rate-limited** (3 runs per visitor per day, 20 globally) and runs on
  desk-held testnet keys — it is not "be the taker" with your own funds; that mode is separate (see
  the live demo at https://whisperdesk.endpx.cloud).
