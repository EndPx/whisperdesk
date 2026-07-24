const EXPLORER = "https://coston2-explorer.flare.network";

type Receipt = {
  label: string;
  detail: string;
  tx?: string;
  href?: string;
};

const RECEIPTS: Receipt[] = [
  {
    label: "enclave-signed lock() — nothing self-signed",
    detail: "ecrecover == live enclave 0x5656…c18B",
    tx: "0x58ec…d1db",
    href: `${EXPLORER}/tx/0x58ec0e5e8e7b4e8ec85b86be863c62565a1292c210420e36b5f382196de5d1db`,
  },
  {
    label: "enclave loop · release() → maker got FXRP",
    detail: "sealed RFQ → TEE match → FDC proof → settled ✓",
    tx: "0xb6b0…dfad",
    href: `${EXPLORER}/tx/0xb6b01c627771323542db03e7a911026139aa1e5a4e81c65dfd08866e21cbdfad`,
  },
  {
    label: "XRPL payment",
    detail: "tesSUCCESS",
    tx: "097B23FD…BAA6",
    href: "https://testnet.xrpl.org/transactions/097B23FD6F4C3FF6740A956838A180C29950DD3E05343786E95930116B18BAA6",
  },
  {
    label: "FDC proof",
    detail: "XRPPayment · status 0 · bound to escrow",
    href: `${EXPLORER}/address/0x5f32783D629E2acBb83f16628ad76D02A26CFB9B`,
  },
  {
    label: "release() → maker received FXRP",
    detail: "settled ✓",
    tx: "0x2c16…202f",
    href: `${EXPLORER}/tx/0x2c162613abea611d7b09c50251b35936b6d7c8599daea17016d952591a17202f`,
  },
  {
    label: "default path · refund() → taker",
    detail: "principal + 1% slashed bond · settled ✓",
    tx: "0x1605…feed",
    href: `${EXPLORER}/tx/0x1605a2ced9852f9caefebf6339cac3d294758f9d5e30c968208d2a4c0cc1feed`,
  },
];

const STATS = [
  "100/100 tests green",
  "enclave signer 0x5656…c18B",
  "enclave escrow 0x20A8…7023",
  "FCE extension 0x…010069",
  "live at fce.endpx.cloud",
];

export default function Proof() {
  return (
    <section id="proof" className="py-20 sm:py-28">
      <div className="mx-auto max-w-[1120px] px-6 sm:px-8">
        <p className="mono-label text-[0.72rem] text-ink-3 mb-4">The receipts</p>
        <h2 className="font-display font-semibold text-[1.9rem] sm:text-[2.4rem] leading-[1.12] tracking-tight max-w-2xl text-balance mb-14">
          Not a mockup — it settled on-chain.
        </h2>

        <div className="grid gap-px bg-steel-line sm:grid-cols-2">
          {RECEIPTS.map((r) => {
            const body = (
              <>
                <p className="mono-label text-[0.66rem] text-ink-3 mb-3">{r.label}</p>
                <p className="mono-data text-[0.85rem] text-ice mb-2">{r.detail}</p>
                {r.tx && (
                  <p className="mono-data text-[0.78rem] text-ink-2">
                    tx <span className="text-ink">{r.tx}</span>
                  </p>
                )}
              </>
            );
            return r.href ? (
              <a
                key={r.label}
                href={r.href}
                target="_blank"
                rel="noopener noreferrer"
                className="bg-vault-2 p-7 sm:p-8 panel-hover block"
              >
                {body}
              </a>
            ) : (
              <div key={r.label} className="bg-vault-2 p-7 sm:p-8 panel-hover block">
                {body}
              </div>
            );
          })}
        </div>

        <div className="mt-6 panel px-7 py-5 sm:px-8">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
            {STATS.map((s) => (
              <span key={s} className="mono-data text-[0.78rem] text-ink-2">
                {s}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
