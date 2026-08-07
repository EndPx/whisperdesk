// wdClient.ts — the maker-mode sealing seam. Shells out to the compiled `wd-client` Go binary
// (scripts/enclave-loop/cmd/wd-client) for the exactly two operations that cannot safely be
// reimplemented in this server: ECIES-sealing a WD_RFQ plaintext (`encrypt`) and POSTing a sealed
// Quote to /direct (`submit`). See this task's return notes for the full "why" — short version:
//
//   - `encrypt`: ECIES sealing must be byte-compatible with go-ethereum's crypto/ecies
//     (ECIES_AES128_SHA256 — extension/fcewire/PROTOCOL.md's handler decrypts with the same lib).
//     scripts/enclave-loop/onchain-loop.mjs's own header comment states this plainly: "Sealing
//     needs go-ethereum's ECIES (eciesjs is not wire-compatible), which is why this shells out to
//     wd-client" — that finding was verified by this codebase already, not re-derived here.
//   - `submit`: POSTs the sealed Quote to /direct as a `teetypes.DirectInstruction` JSON body. That
//     Go struct lives in the external github.com/flare-foundation/tee-node module (not vendored
//     into this repo — scripts/enclave-loop/go.mod resolves it via a sibling-directory `replace`),
//     so its exact JSON field names/byte-encoding cannot be safely re-derived from inside this repo.
//     onchain-loop.mjs — the only OTHER place in this codebase that drives QUOTE_SUBMIT — shells out
//     to this exact `wd-client submit` command for the same reason, rather than POSTing directly.
//
// Everything else maker mode needs (fetching /info, polling /action/result, calling
// WhisperDeskInstructionSender.submitRfq/triggerMatch, calling DvPEscrow.lock) is plain
// ethers.js/fetch, mirrored from onchain-loop.mjs's own already-proven JS code — see maker.ts.
//
// SECURITY: DIRECT_API_KEY is passed to the child process via its environment, never as a CLI arg
// (which would be visible to other processes on the same host via `ps`/`/proc`) — submit.go already
// falls back to reading it from its own environment when --api-key isn't given.
import { spawn } from "node:child_process";
import type { MakerEnv } from "./makerEnv";

/// Runs `<wdClientBin> <args...>`, optionally piping `input` to its stdin, with EXT_PROXY_URL /
/// DIRECT_API_KEY set on its environment (never as argv). Resolves with trimmed stdout; rejects
/// with a message built from stderr (falling back to stdout) on a non-zero exit, spawn failure, or
/// timeout. Never resolves/rejects with anything from `input` itself, so a caller's plaintext
/// (which may contain order-size-revealing fields) never round-trips into an error message either —
/// only wd-client's own stderr/stdout text does.
function runWdClient(makerEnv: MakerEnv, args: string[], input: string | undefined, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(makerEnv.wdClientBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        EXT_PROXY_URL: makerEnv.extProxyUrl,
        DIRECT_API_KEY: makerEnv.directApiKey,
      },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`wd-client ${args[0]}: timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `wd-client ${args[0]}: failed to spawn "${makerEnv.wdClientBin}" (${err.message}) — set WD_CLIENT_BIN to the compiled binary's path`
        )
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`wd-client ${args[0]} exited ${code}: ${(stderr || stdout).trim()}`));
        return;
      }
      resolve(stdout.trim());
    });

    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

/// ECIES-seals `plaintext` (a JSON-serializable WD_RFQ payload — RfqPlaintext or QuotePlaintext, see
/// extension/fcewire/PROTOCOL.md §3) to the enclave's current pubkey (fetched by wd-client itself
/// from GET /info — this call needs no local pubkey state) and pads it to WD_PAD_SIZE first (the
/// binary's own default behavior, unless --no-pad is passed, which we never do). Returns the 0x-hex
/// ciphertext blob `submitRfq`/`wdSubmitQuote` expect.
export async function wdEncrypt(makerEnv: MakerEnv, plaintext: unknown): Promise<string> {
  const json = JSON.stringify(plaintext);
  const out = await runWdClient(makerEnv, ["encrypt", "-"], json, 20_000);
  if (!/^0x[0-9a-fA-F]+$/.test(out)) {
    throw new Error("wd-client encrypt: unexpected output (not a 0x-hex ciphertext)");
  }
  return out;
}

/// POSTs `messageHex` to /direct under `opCommand` and returns the resulting actionId. Every
/// /direct result is polled with pollActionResult(..., {tag:"submit"}) — the submissionTag the proxy
/// files direct submissions under, regardless of which opCommand they carry.
///
/// The message's shape is per-command and NOT interchangeable (PROTOCOL.md §5):
///   - QUOTE_SUBMIT — a bare ECIES blob (wdEncrypt output).
///   - RFQ_SUBMIT   — abi.encode(address sender, bytes ciphertext), the sender envelope.
///   - RFQ_MATCH    — the bare 32-byte rfqId, unsealed (the trigger carries no secret).
/// Callers build the right one; this function only carries bytes.
async function wdSubmitDirect(makerEnv: MakerEnv, opCommand: string, messageHex: string): Promise<string> {
  const out = await runWdClient(
    makerEnv,
    ["submit", "--op-command", opCommand, "--message", messageHex],
    undefined,
    20_000
  );
  let action: unknown;
  try {
    action = JSON.parse(out);
  } catch {
    throw new Error(`wd-client submit: output was not valid JSON: ${out.slice(0, 200)}`);
  }
  const id =
    (action as { data?: { id?: string }; id?: string })?.data?.id ?? (action as { id?: string })?.id;
  if (!id) {
    throw new Error(`wd-client submit: could not read action id from output: ${out.slice(0, 200)}`);
  }
  return id;
}

/// Submits a QUOTE_SUBMIT with an already-sealed ciphertext (see wdEncrypt).
export async function wdSubmitQuote(makerEnv: MakerEnv, ciphertextHex: string): Promise<string> {
  return wdSubmitDirect(makerEnv, "QUOTE_SUBMIT", ciphertextHex);
}

/// Submits an RFQ_SUBMIT with a sender envelope (see maker.ts's encodeRfqEnvelope).
///
/// This ingress is the demo bypass, gated by WD_ALLOW_DIRECT_RFQ on the enclave and independently by
/// the proxy's API key. The canonical ingress is an onchain WhisperDeskInstructionSender.submitRfq,
/// where the taker is stamped from msg.sender and cannot be claimed; here the sender in the envelope
/// is self-attested. What that does and does not cost is written out in maker.ts's publishTakerRfq —
/// read it before treating the two ingresses as equivalent.
export async function wdSubmitRfq(makerEnv: MakerEnv, envelopeHex: string): Promise<string> {
  return wdSubmitDirect(makerEnv, "RFQ_SUBMIT", envelopeHex);
}

/// Triggers matching for `rfqId` — the message is the bare 32-byte id, raw and unsealed.
///
/// Unlike the RFQ ingress, this one gives nothing away by being direct: RFQ_MATCH is permissionless
/// on both ingresses (PROTOCOL.md §1), carries no secret (the rfqId is already public), and names no
/// party. Whoever fires it, the enclave runs the same matcher over the same sealed book.
export async function wdTriggerMatch(makerEnv: MakerEnv, rfqId: string): Promise<string> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(rfqId)) {
    throw new Error(`wd-client submit: rfqId must be a 32-byte hex string, got ${rfqId.slice(0, 20)}`);
  }
  return wdSubmitDirect(makerEnv, "RFQ_MATCH", rfqId);
}
