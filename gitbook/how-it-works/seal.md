# 1 · Seal

The taker's RFQ (side, size, limit price) is ECIES-sealed before it reaches the enclave. Two
ingresses exist. They differ only in how the taker's identity is bound.

| Ingress | Taker identity | Status |
|---|---|---|
| [`WhisperDeskInstructionSender.submitRfq`](https://coston2-explorer.flare.network/address/0x56A903F408C4745D34354Ec230BbfBDD78eC6426) | Stamped from `msg.sender` by the contract itself — cannot be forged by the caller | The design, and registry-enforced as the only valid instruction origin for extension `65641`. Has settled end to end. Not routing today — see below |
| `POST /direct` | Self-attested in the request envelope (API-keyed, `WD_ALLOW_DIRECT_RFQ=true`) | What the live site runs on |

**Why the live site is on the weaker one.** Onchain instructions reach the enclave through Flare's
hosted FTDC proxy, and that proxy currently answers our machine-availability check with a 404.
Nothing submitted that way arrives. The contract half is deployed, registry-enforced and proven; the
routing half is outside our code.

**What that costs, precisely.** It costs attribution, not safety. On `/direct` the address in the
envelope is claimed rather than stamped — but `lock()` reserves the FXRP from *that* address's own
armed escrow deposit and pays the XRP to the address sealed beside it. Name someone who has not
deposited and the RFQ can never lock; name someone who has and the trade settles to them. A forged
taker cannot be made to profit the forger. What is genuinely lost is the chain proving who wrote
the order.

The match trigger runs over `/direct` too, and there the cost is zero: `RFQ_MATCH` is permissionless
on both ingresses, carries no secret (the `rfqId` is already public), and names no party.

Inside the enclave, the RFQ is identified by `rfqId = keccak256(ciphertext)`. Whichever ingress it
came through, everything downstream — sealing, in-enclave matching, EIP-712 maker auth, enclave
signing, the onchain `ecrecover` check — is identical.

Next: [2 · Match](./match.md)
