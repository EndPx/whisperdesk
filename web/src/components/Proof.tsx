const EXPLORER = "https://coston2-explorer.flare.network";

/**
 * The receipts, reorganised around WHAT EACH ONE PROVES.
 *
 * The previous version was six tiles of hashes and short mechanical labels. A judge could see
 * that transactions existed but not what they established — the burden of translating
 * "ecrecover == 0x5656…" into "nobody self-signed this" was left to the reader. Each card now
 * leads with the guarantee in plain English, carries a "Proven live" badge, and only then shows
 * the transaction that backs it.
 */
type Guarantee = {
  id: string;
  kicker: string;
  claim: string;
  body: string;
  badge: string;
  tx: string;
  href: string;
};

const GUARANTEES: Guarantee[] = [
  {
    id: "P1",
    kicker: "No self-signing",
    claim: "Nothing here is signed by us",
    body:
      "The instruction that moved the funds was signed inside the enclave with its own key, and the escrow recovered that signature on-chain before touching anything. The desk cannot forge a match for itself.",
    badge: "lock() accepted the enclave's signature",
    tx: "0x58ec…d1db",
    href: `${EXPLORER}/tx/0x58ec0e5e8e7b4e8ec85b86be863c62565a1292c210420e36b5f382196de5d1db`,
  },
  {
    id: "P2",
    kicker: "Cross-chain DvP",
    claim: "Delivery only against proven payment",
    body:
      "FXRP is released when — and only when — the Flare Data Connector proves the exact XRPL payment landed before the deadline. The two legs live on chains that cannot see each other, so the proof is the only bridge between them.",
    badge: "release() after a fresh FDC proof",
    tx: "0xb6b0…dfad",
    href: `${EXPLORER}/tx/0xb6b01c627771323542db03e7a911026139aa1e5a4e81c65dfd08866e21cbdfad`,
  },
  {
    id: "P3",
    kicker: "Default path",
    claim: "A no-show costs the maker, not the taker",
    body:
      "If the XRP never arrives, the taker gets their principal back plus the maker's slashed 1% bond. The failure path is a designed outcome that settles — not an error that strands funds.",
    badge: "refund() paid principal + slashed bond",
    tx: "0x1605…feed",
    href: `${EXPLORER}/tx/0x1605a2ced9852f9caefebf6339cac3d294758f9d5e30c968208d2a4c0cc1feed`,
  },
  {
    id: "P4",
    kicker: "Real asset",
    claim: "The desk settles genuine FXRP",
    body:
      "Every seat in the live demo settles FAssets-minted FXRP — no mock, no stand-in. The first supply came from XRP we sent into the Core Vault ourselves; visitors get theirs from Flare's own faucet, which is what let the placeholder go entirely.",
    badge: "real FXRP released to the maker",
    tx: "0x9ea7…aea3",
    href: `${EXPLORER}/tx/0x9ea70cafebbf0e6b937216af9cea374d798e6eb0466b7104fe40fd7e256aaea3`,
  },
];

// Every figure here names something a reader can go and check, so every figure links to it. As
// plain text they read like claims about addresses rather than pointers to them — the opposite of
// what this section exists to do.
const STATS: { label: string; href: string; title: string }[] = [
  {
    label: "117/117 tests green",
    href: "https://github.com/EndPx/whisperdesk/tree/main/contracts/test",
    title: "The contract suite: unit, fuzz/invariant, and two that fork Coston2",
  },
  {
    label: "enclave signer 0x5656…c18B",
    href: `${EXPLORER}/address/0x56564F61588bB110E0712c3938aDa4338e6cc18B`,
    title: "The key the enclave signs MatchInstructions with — held only inside the TEE",
  },
  {
    label: "enclave escrow 0x20A8…7023",
    href: `${EXPLORER}/address/0x20A885cb6ed3F652C5Fcb6a683CE74436F6a7023`,
    title: "The DvPEscrow whose teeSigner is that enclave key",
  },
  {
    label: "FCE extension 0x…010069",
    href: `${EXPLORER}/address/0x0000000000000000000000000000000000010069`,
    title: "Extension 65641 — the registry that routes instructions to our TEE machine",
  },
  {
    label: "live at fce.endpx.cloud",
    href: "https://fce.endpx.cloud/info",
    title: "The running enclave — returns its signed TeeInfo on every request",
  },
];

export default function Proof() {
  return (
    <section id="proof" className="py-20 sm:py-28">
      <div className="mx-auto max-w-[1120px] px-6 sm:px-8">
        <p className="mono-label text-[0.72rem] text-ink-3 mb-4">What we prove, live</p>
        <h2 className="font-display font-semibold text-[1.9rem] sm:text-[2.4rem] leading-[1.12] tracking-tight max-w-2xl text-balance mb-5">
          Not a mockup — it settled on-chain.
        </h2>

        <p className="max-w-[58ch] text-[0.95rem] leading-[1.7] text-ink-2 mb-12">
          Four guarantees, each backed by a transaction you can open. Signed by the live enclave,
          verified by the real Flare Data Connector, settled on real Coston2 and XRPL testnet.
        </p>

        <div className="grid gap-5 sm:grid-cols-2">
          {GUARANTEES.map((g) => (
            <a
              key={g.id}
              href={g.href}
              target="_blank"
              rel="noopener noreferrer"
              className="panel panel-hover flex flex-col p-7 sm:p-8 group"
            >
              <p className="mono-label text-[0.6rem] text-ice mb-3">
                {g.id} · {g.kicker}
              </p>
              <p className="font-display font-semibold text-[1.15rem] leading-snug tracking-tight text-ink mb-3 text-balance">
                {g.claim}
              </p>
              <p className="text-[0.9rem] leading-[1.65] text-ink-2 mb-6">{g.body}</p>

              <div className="mt-auto pt-5 border-t border-steel-line flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <span className="mono-label text-[0.56rem] text-ink-3 flex items-center gap-2">
                  <span className="ice-dot shrink-0" />
                  Proven live · {g.badge}
                </span>
                <span className="mono-data text-[0.74rem] text-ink-2 group-hover:text-ice transition-colors duration-300">
                  {g.tx}
                </span>
              </div>
            </a>
          ))}
        </div>

        <div className="mt-6 panel px-7 py-5 sm:px-8">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
            {STATS.map((s) => (
              <a
                key={s.label}
                href={s.href}
                target="_blank"
                rel="noopener noreferrer"
                title={s.title}
                className="mono-data text-[0.78rem] text-ink-2 hover:text-ice hover:underline underline-offset-4 transition-colors duration-300"
              >
                {s.label}
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
