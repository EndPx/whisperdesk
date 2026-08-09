// wallet-client.ts — "use client"-safe helpers for wallet-mode ("Be the taker"). Plain ethers v6
// BrowserProvider talking directly to window.ethereum (MetaMask or compatible) — no wagmi. Import
// only from Client Components (see web/AGENTS.md's Next.js Server/Client Component boundary).
//
// ABI fragments are imported verbatim from src/lib/demo/abi.ts (not duplicated): that file has zero
// imports of its own and performs no server-only work, so it is safe to pull into the client
// bundle — it just lets wallet-mode transactions target the exact same contract interfaces the
// one-click demo path uses.
import { BrowserProvider, Contract, type Eip1193Provider } from "ethers";
import { DVP_ESCROW_ABI, MOCK_FXRP_ABI } from "@/lib/demo/abi";

declare global {
  interface Window {
    ethereum?: Eip1193Provider & {
      on?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
  }
}

export const COSTON2_CHAIN_ID_HEX = "0x72"; // 114 — matches src/lib/demo/config.ts COSTON2_CHAIN_ID

export const COSTON2_CHAIN_PARAMS = {
  chainId: COSTON2_CHAIN_ID_HEX,
  chainName: "Flare Testnet Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: ["https://coston2-api.flare.network/ext/C/rpc"],
  blockExplorerUrls: ["https://coston2-explorer.flare.network"],
};

/* ---------------------------------------------------------------------------
   Provider / connection
--------------------------------------------------------------------------- */

export function detectProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  return window.ethereum ?? null;
}

/** Requests account access and returns the connected address. Throws WalletRejectionError if the
 *  user declines the MetaMask prompt. */
export async function connect(): Promise<string> {
  const eth = detectProvider();
  if (!eth) throw new Error("no wallet detected");
  return withRejectionSurfaced(async () => {
    const provider = new BrowserProvider(eth);
    const accounts = (await provider.send("eth_requestAccounts", [])) as string[];
    if (!accounts?.[0]) throw new Error("no account returned by wallet");
    return accounts[0];
  });
}

/** Hands the authorization back to the wallet, so "signed out" means signed out.
 *
 *  Clearing React state alone would not do it: getAuthorizedAccount() reads the permission from the
 *  wallet on the next mount and would silently reconnect — exactly the behaviour that makes a
 *  sign-out button feel broken. `wallet_revokePermissions` actually withdraws it.
 *
 *  Not every wallet implements that method, so a failure is swallowed deliberately: the caller
 *  still clears its own state, which at minimum ends the session in this tab. */
export async function disconnect(): Promise<void> {
  const eth = detectProvider();
  if (!eth) return;
  try {
    await eth.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
  } catch {
    /* wallet does not support revocation — clearing local state is the fallback */
  }
}

/** Returns the account this site is ALREADY authorized to use, or null — without prompting.
 *
 *  `eth_accounts` is the silent counterpart to `eth_requestAccounts`: the authorization lives in
 *  the wallet and survives page loads and React unmounts, so this is what lets a mode switch
 *  restore the connection instead of asking the judge to press Connect again. */
export async function getAuthorizedAccount(): Promise<string | null> {
  const eth = detectProvider();
  if (!eth) return null;
  try {
    const accounts = (await eth.request({ method: "eth_accounts", params: [] })) as string[];
    return accounts?.[0] ?? null;
  } catch {
    // A wallet that refuses the silent read is simply treated as "not connected yet" — the user
    // can still connect explicitly. Never surface this as an error.
    return null;
  }
}

/** Returns the wallet's current chain id (hex), or null if it cannot be read. */
export async function getConnectedChainId(): Promise<string | null> {
  const eth = detectProvider();
  if (!eth) return null;
  try {
    return (await eth.request({ method: "eth_chainId", params: [] })) as string;
  } catch {
    return null;
  }
}

/** Subscribes to the wallet's accountsChanged event. Returns an unsubscribe function (a no-op one
 *  if the provider does not support events). */
export function onAccountsChanged(cb: (address: string | null) => void): () => void {
  const eth = typeof window === "undefined" ? null : window.ethereum;
  if (!eth?.on) return () => {};
  const handler = (...args: unknown[]) => {
    const accounts = args[0] as string[] | undefined;
    cb(accounts?.[0] ?? null);
  };
  eth.on("accountsChanged", handler);
  return () => eth.removeListener?.("accountsChanged", handler);
}

/** Switches the wallet to Coston2, adding the network first if the wallet doesn't know it yet
 *  (error code 4902). */
export async function ensureCoston2(): Promise<void> {
  const eth = detectProvider();
  if (!eth) throw new Error("no wallet detected");
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: COSTON2_CHAIN_ID_HEX }],
    });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 4902) {
      await eth.request({ method: "wallet_addEthereumChain", params: [COSTON2_CHAIN_PARAMS] });
      return;
    }
    throw err;
  }
}

/* ---------------------------------------------------------------------------
   User-rejection surfacing — MetaMask reports rejected prompts as error code 4001 (raw
   EIP-1193) or ethers' own ACTION_REJECTED wrapper. Normalize both to one friendly error so the
   UI can show a single "try again" message and retry just the step that was rejected.
--------------------------------------------------------------------------- */

export class WalletRejectionError extends Error {
  constructor() {
    super("Rejected in wallet — try again.");
    this.name = "WalletRejectionError";
  }
}

function isUserRejection(err: unknown): boolean {
  const e = err as { code?: number | string; info?: { error?: { code?: number } } };
  return e?.code === 4001 || e?.code === "ACTION_REJECTED" || e?.info?.error?.code === 4001;
}

async function withRejectionSurfaced<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUserRejection(err)) throw new WalletRejectionError();
    throw err;
  }
}

async function getSigner() {
  const eth = detectProvider();
  if (!eth) throw new Error("no wallet detected");
  const provider = new BrowserProvider(eth);
  return provider.getSigner();
}

/* ---------------------------------------------------------------------------
   Transaction helpers — each takes the exact sub-object POST /api/wallet/prepare returns (see
   web/src/components/WalletMode.tsx), attaches it to a contract call with the connected wallet's
   signer, waits for one confirmation, and returns the tx hash.
--------------------------------------------------------------------------- */

export async function sendApprove(approve: { token: string; spender: string; amount: string }): Promise<string> {
  return withRejectionSurfaced(async () => {
    const signer = await getSigner();
    const token = new Contract(approve.token, MOCK_FXRP_ABI, signer);
    const tx = await token.approve(approve.spender, approve.amount);
    const receipt = await tx.wait();
    return receipt.hash as string;
  });
}

// deposit's target contract is the escrow — prepare's `deposit` sub-object doesn't carry an
// address (it's the same address as `lock.to`), so the caller passes it explicitly.
export async function sendDeposit(
  escrowAddress: string,
  deposit: { amount: string; armedUntil: string | number },
): Promise<string> {
  return withRejectionSurfaced(async () => {
    const signer = await getSigner();
    const escrow = new Contract(escrowAddress, DVP_ESCROW_ABI, signer);
    const tx = await escrow.deposit(deposit.amount, deposit.armedUntil);
    const receipt = await tx.wait();
    return receipt.hash as string;
  });
}

/** Publishes a sealed RFQ from the taker's OWN wallet.
 *
 *  This one cannot be relayed on the visitor's behalf, which is why it lives client-side:
 *  WhisperDeskInstructionSender writes the taker into the instruction envelope from `msg.sender`,
 *  so the transaction has to originate from the wallet that owns the order. Sent from a desk key it
 *  would produce an RFQ attributed to the desk — the exact forgery this ingress exists to prevent.
 *
 *  This was briefly deleted. Instructions reach the enclave through Flare's data providers, which
 *  push to the URL recorded on-chain for our TEE machine — and ours read `http://localhost:6674`,
 *  so nothing ever arrived and every submission 404'd. That was our own stale registration, not
 *  Flare's infrastructure. `updateTeeMachineSettings` corrected it, the machine reached PRODUCTION,
 *  and the path was re-proven before this came back: submitRfq tx 0xe57cb5ff…128e returned an
 *  enclave ack with status 1.
 *
 *  Minimal inline ABI: the sender contract's surface used here is a single method, and importing
 *  the server's full ABI would drag its dependencies into the bundle for no gain. */
const SUBMIT_RFQ_ABI = ["function submitRfq(bytes ciphertext) payable returns (bytes32)"];

export async function sendSubmitRfq(rfq: {
  senderAddress: string;
  ciphertext: string;
  relayFeeWei: string;
}): Promise<string> {
  return withRejectionSurfaced(async () => {
    const signer = await getSigner();
    const sender = new Contract(rfq.senderAddress, SUBMIT_RFQ_ABI, signer);
    const tx = await sender.submitRfq(rfq.ciphertext, { value: rfq.relayFeeWei });
    const receipt = await tx.wait();
    return receipt.hash as string;
  });
}

export async function sendLock(lock: {
  to: string;
  instructionData: string;
  teeSignature: string;
  valueWei: string;
}): Promise<string> {
  return withRejectionSurfaced(async () => {
    const signer = await getSigner();
    const escrow = new Contract(lock.to, DVP_ESCROW_ABI, signer);
    const tx = await escrow.lock(lock.instructionData, lock.teeSignature, { value: lock.valueWei });
    const receipt = await tx.wait();
    return receipt.hash as string;
  });
}
