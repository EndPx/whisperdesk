# 1 · Seal

The taker's RFQ (side, size, limit price) is ECIES-sealed before it reaches the enclave. Two
ingresses exist. They differ only in how the taker's identity is bound.

| Ingress | Taker identity | Used for |
|---|---|---|
| [`WhisperDeskInstructionSender.submitRfq`](https://coston2-explorer.flare.network/address/0x56A903F408C4745D34354Ec230BbfBDD78eC6426) | Stamped from `msg.sender` by the contract itself — cannot be claimed by the caller | **Every order.** Registry-enforced as the only valid instruction origin for extension `65641` |
| `POST /direct` | Self-attested in the request envelope (API-keyed) | `RFQ_MATCH` only — see below |

The desk seals your order and hands the ciphertext **back**. The transaction goes out from your own
wallet, because the contract writes the taker from `msg.sender`: relaying it from a desk key would
produce an order attributed to the desk, the exact forgery this ingress exists to prevent.

**A wrong diagnosis worth recording.** This path was down for a stretch. Every onchain submission
404'd, we attributed it to Flare's hosted FTDC proxy, and order submission moved to `/direct` with a
self-attested taker. The cause was ours: our TEE machine was registered on-chain under
`http://localhost:6674`. Flare's data providers push to the URL recorded on-chain, so they were
pushing at a loopback address that meant nothing to them, and the availability check could never
complete. `updateTeeMachineSettings` fixed it and the machine reached `PRODUCTION`. If you hit the
same 404, read `getTeeMachine(<teeId>)` first — and note that `register-tee` will not update that
URL for an already-registered machine whatever flags you pass, because `Register()` is its only
writer and it gets skipped.

**Why the match trigger stays on `/direct`.** Moving it there costs nothing: `RFQ_MATCH` is
permissionless on both ingresses, carries no secret (the `rfqId` is already public), and names no
party. Onchain it would only add a transaction, a fee and a wait to a call anyone may make.

Inside the enclave, the RFQ is identified by `rfqId = keccak256(ciphertext)`. Whichever ingress it
came through, everything downstream — sealing, in-enclave matching, EIP-712 maker auth, enclave
signing, the onchain `ecrecover` check — is identical.

Next: [2 · Match](./match.md)
