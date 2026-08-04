# 1 · Seal

The taker's RFQ (side, size, limit price) is ECIES-sealed before it reaches the enclave. Two
ingresses exist, and both work — they differ only in how the taker's identity is bound.

| Ingress | Taker identity | Where it's used |
|---|---|---|
| `POST /direct` | Self-attested in the request body (API-keyed, `WD_ALLOW_DIRECT_RFQ=true`) | The one-click browser demo — has to complete inside a single browser session |
| [`WhisperDeskInstructionSender.submitRfq`](https://coston2-explorer.flare.network/address/0x56A903F408C4745D34354Ec230BbfBDD78eC6426) | Stamped from `msg.sender` by the contract itself — cannot be forged by the caller | The chain-authenticated path — registry-enforced as the only valid instruction origin for extension `65641` |

Inside the enclave, the RFQ is identified by `rfqId = keccak256(ciphertext)`. Whichever ingress it
came through, everything downstream — sealing, in-enclave matching, EIP-712 maker auth, enclave
signing, the onchain `ecrecover` check — is identical.

Next: [2 · Match](./match.md)
