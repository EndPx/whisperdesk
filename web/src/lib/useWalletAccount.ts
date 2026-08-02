// useWalletAccount — one wallet connection, shared by every own-wallet mode of the demo console.
//
// WHY THIS EXISTS
// DemoConsole renders WalletMode ("as the taker") and MakerMode ("as the maker") through a
// ternary, so switching modes UNMOUNTS one and mounts the other. While each mode owned its own
// `address` state, that switch threw the connection away and the judge had to press Connect again
// — even though the wallet had never revoked anything. The authorization lives in the wallet, not
// in React, so the fix is to read it back silently rather than re-request it.
//
// WHY THE CHAIN IS CHECKED TOO
// ensureCoston2() only ever runs inside each mode's handleConnect. A restore that skipped
// handleConnect would therefore skip the network switch, and a judge whose wallet sat on some
// other chain would be walked straight to step 2 and sign against the wrong network. So a session
// is only restored when the wallet is genuinely ready: authorized AND already on Coston2.
// Otherwise we leave the flow at step 1, where Connect performs the switch as it always has.
//
// KNOWN GAP (pre-existing, not introduced here): nothing listens for `chainChanged`, so a user who
// switches network mid-flow still sees a connected UI. That was already true before this hook.
import { useEffect, useState } from "react";
import {
  COSTON2_CHAIN_ID_HEX,
  detectProvider,
  getAuthorizedAccount,
  getConnectedChainId,
  onAccountsChanged,
} from "@/lib/wallet-client";

export interface WalletAccount {
  /** null while still checking, then whether an injected wallet exists at all. */
  hasProvider: boolean | null;
  address: string | null;
  setAddress: (address: string | null) => void;
}

export function useWalletAccount(): WalletAccount {
  const [hasProvider, setHasProvider] = useState<boolean | null>(null);
  const [address, setAddress] = useState<string | null>(null);

  // Detection + silent restore. Everything is deferred into a microtask rather than run directly
  // in the effect body, matching the initial-check pattern the console already uses elsewhere
  // (and keeping the react-hooks/set-state-in-effect rule satisfied).
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      const present = !!detectProvider();
      setHasProvider(present);
      if (!present) return;

      const [restored, chainId] = await Promise.all([getAuthorizedAccount(), getConnectedChainId()]);
      if (cancelled || !restored) return;
      if (chainId?.toLowerCase() !== COSTON2_CHAIN_ID_HEX) return; // see "WHY THE CHAIN IS CHECKED"
      setAddress(restored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Stay in step with the wallet: switching accounts re-points the flow at the new one,
  // disconnecting the site clears it.
  useEffect(() => onAccountsChanged(setAddress), []);

  return { hasProvider, address, setAddress };
}
