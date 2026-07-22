// run.mjs — orchestrator for the Step 2 FDC spike: pay -> attest -> verify, in sequence.
// NOT executed by this task run (dry-validation phase only). Run with `npm run run` once the
// human/CI phase-2 trigger fires the live XRPL payment.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function run(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
      stdio: "inherit",
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`))));
  });
}

async function main() {
  console.log("=== Step 2 FDC spike: pay -> attest -> verify ===\n");
  console.log("[1/3] pay.mjs");
  await run("pay.mjs");
  console.log("\n[2/3] attest.mjs");
  await run("attest.mjs");
  console.log("\n[3/3] verify.mjs");
  await run("verify.mjs");
  console.log("\n=== Spike complete: GO ===");
}

main().catch((err) => {
  console.error(`\n=== Spike failed: NO-GO candidate — ${err.message} ===`);
  process.exit(1);
});
