// Takes a stale TEE machine out of rotation.
//
// MachineManager has no deregister — only pause/ban. When the enclave is rebuilt its identity key
// regenerates, orphaning the previous registration; getRandomTeeIds keeps handing onchain
// instructions to that dead machine. Pausing it frees the slot before the live enclave is
// registered (the ABI defines TooMany, and the per-extension cap is unknown).
//
// Refuses to pause the machine that is currently running — that would be a self-inflicted outage.
//
// Usage: node pause-stale-machine.mjs <teeIdToPause>
//   env: PRIVATE_KEY (must be the machine's owner or a pauser), COSTON2_RPC, EXT_PROXY_URL
import { ethers } from "ethers";

const RPC = process.env.COSTON2_RPC ?? "https://coston2-api.flare.network/ext/C/rpc";
const EXT_PROXY = process.env.EXT_PROXY_URL ?? "https://fce.endpx.cloud";
const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";

const target = process.argv[2];
if (!target || !ethers.isAddress(target)) {
  throw new Error("usage: node pause-stale-machine.mjs <teeId>");
}
const pk = process.env.PRIVATE_KEY;
if (!pk) throw new Error("set PRIVATE_KEY (machine owner / pauser)");

const provider = new ethers.JsonRpcProvider(RPC, 114);
const wallet = new ethers.Wallet(pk, provider);

// --- guard: never pause the enclave that is actually serving ---------------------------------
const info = await (await fetch(`${EXT_PROXY}/info`, { signal: AbortSignal.timeout(20_000) })).json();
const pub = info.teeInfo.publicKey;
const liveTeeId = ethers.computeAddress("0x04" + pub.x.slice(2) + pub.y.slice(2));
if (liveTeeId.toLowerCase() === target.toLowerCase()) {
  throw new Error(`refusing: ${target} is the LIVE enclave at ${EXT_PROXY} — pausing it would break the demo`);
}
console.log(`live enclave : ${liveTeeId}  (not the target — safe)`);
console.log(`pausing      : ${target}`);

const mm = new ethers.Contract(
  DIAMOND,
  [
    "function pause(address _teeId)",
    "function getTeeMachine(address) view returns (tuple(address teeId, address owner, string url))",
    "function getRandomTeeIds(uint256,uint256) view returns (address[])",
  ],
  wallet
);

const before = await mm.getTeeMachine(target);
console.log(`owner        : ${before.owner}`);
console.log(`signer       : ${wallet.address}`);

const tx = await mm.pause(target);
console.log(`tx           : ${tx.hash}`);
const receipt = await tx.wait();
console.log(`status       : ${receipt.status === 1 ? "success" : "FAILED"} (block ${receipt.blockNumber})`);

// --- confirm it left the rotation --------------------------------------------------------------
try {
  const ids = await mm.getRandomTeeIds(65641n, 1n);
  console.log(`getRandomTeeIds(65641,1) -> ${ids.length ? ids.join(", ") : "(none)"}`);
  const stillThere = ids.some((a) => a.toLowerCase() === target.toLowerCase());
  console.log(stillThere ? "WARNING: still selectable" : "OK: no longer selectable");
} catch (err) {
  // reverting here means no usable machine remains — expected until the live one is registered
  console.log(`getRandomTeeIds reverted (${err.shortMessage ?? "no usable machine"}) — expected until register-tee runs`);
}
