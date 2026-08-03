// Mint REAL FAssets FXRP on Coston2 via v1.3 direct minting, so WhisperDesk can prove one
// settlement against the genuine asset rather than only against MockFXRP.
//
// Lives beside the e2e runners on purpose: it reuses lib/fdc.mjs verbatim. Direct minting consumes
// an FDC `XRPPayment` proof whose RequestBody is { bytes32 transactionId; address proofOwner } —
// byte-for-byte the same attestation DvPEscrow already consumes, so there is nothing new to build
// on the proof side.
//
// The XRPL payment and the attestation are INDEPENDENT. If executeDirectMinting reverts because
// proofOwner was bound to the wrong consumer, the XRP is still sitting in the Core Vault and the
// proof can simply be re-requested for the same transactionId. Re-run with --tx=<hash> to do that
// instead of paying again.
//
// Usage (from the repo root, so dotenv finds .env):
//   node scripts/e2e/fassets-direct-mint.mjs
//   node scripts/e2e/fassets-direct-mint.mjs --tx=<xrplTxHash>     re-prove an existing payment
import "dotenv/config";
import { ethers } from "ethers";
import xrpl from "xrpl";
import { requestAndAwaitProof, buildProofTuple } from "./lib/fdc.mjs";

const RPC = process.env.COSTON2_RPC ?? "https://coston2-api.flare.network/ext/C/rpc";
const XRPL_WSS = process.env.XRPL_TESTNET_WSS ?? "wss://s.altnet.rippletest.net:51233";
const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

// 8-byte DIRECT_MINTING PaymentReference prefix + 4 zero bytes + 20-byte recipient.
const DIRECT_MINTING_PREFIX = "4642505266410018";

const AM_ABI = [
  "function fAsset() view returns (address)",
  "function lotSize() view returns (uint256)",
  "function directMintingPaymentAddress() view returns (string)",
  "function getDirectMintingFeeBIPS() view returns (uint256)",
  "function getDirectMintingMinimumFeeUBA() view returns (uint256)",
  "function getDirectMintingExecutorFeeUBA() view returns (uint256)",
  // Proof tuple copied verbatim from lib/abi.mjs's release() — the same IXRPPayment.Proof our
  // escrow already consumes, so buildProofTuple() output drops straight in. Do not re-derive it
  // by hand: the responseBody has 15 fields and guessing a shorter one silently fails to encode.
  "function executeDirectMinting((bytes32[] merkleProof,(bytes32 attestationType,bytes32 sourceId,uint64 votingRound,uint64 lowestUsedTimestamp,(bytes32 transactionId,address proofOwner) requestBody,(uint64 blockNumber,uint64 blockTimestamp,string sourceAddress,bytes32 sourceAddressHash,bytes32 receivingAddressHash,bytes32 intendedReceivingAddressHash,int256 spentAmount,int256 intendedSpentAmount,int256 receivedAmount,int256 intendedReceivedAmount,bool hasMemoData,bytes firstMemoData,bool hasDestinationTag,uint256 destinationTag,uint8 status) responseBody) data) payment) payable",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (set it in the repo-root .env)`);
  return v;
}

function buildMemoHex(recipient) {
  const addr = recipient.toLowerCase().replace(/^0x/, "");
  if (addr.length !== 40) throw new Error(`bad recipient address: ${recipient}`);
  const memo = DIRECT_MINTING_PREFIX + "00000000" + addr;
  if (memo.length !== 64) throw new Error(`memo must be 32 bytes, got ${memo.length / 2}`);
  return memo.toUpperCase();
}

/// Sends the direct-minting XRPL payment: destination is the Core Vault, and the 32-byte
/// PaymentReference rides in a Memo (NOT a destination tag — that is the MintingTagManager flow).
async function payCoreVault({ seed, destination, amountDrops, memoHex, onProgress }) {
  const client = new xrpl.Client(XRPL_WSS);
  await client.connect();
  try {
    const wallet = xrpl.Wallet.fromSeed(seed);
    onProgress?.(`paying from ${wallet.address}`);
    const prepared = await client.autofill({
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: destination,
      Amount: String(amountDrops),
      Memos: [{ Memo: { MemoData: memoHex } }],
    });
    const signed = wallet.sign(prepared);
    onProgress?.(`submitting ${signed.hash}`);
    const res = await client.submitAndWait(signed.tx_blob);
    const code = res.result.meta?.TransactionResult;
    if (code !== "tesSUCCESS") throw new Error(`XRPL payment failed: ${code}`);
    onProgress?.(`validated in ledger ${res.result.ledger_index}`);
    return signed.hash;
  } finally {
    await client.disconnect();
  }
}

async function main() {
  const txArg = process.argv.find((a) => a.startsWith("--tx="));
  const provider = new ethers.JsonRpcProvider(RPC, 114);
  const wallet = new ethers.Wallet(requireEnv("PRIVATE_KEY"), provider);

  const registry = new ethers.Contract(
    REGISTRY,
    ["function getContractAddressByName(string) view returns (address)"],
    provider
  );
  const amAddress = await registry.getContractAddressByName("AssetManagerFXRP");
  const am = new ethers.Contract(amAddress, AM_ABI, wallet);

  const [fxrpAddress, lot, coreVault, feeBips, minFee, execFee] = await Promise.all([
    am.fAsset(),
    am.lotSize(),
    am.directMintingPaymentAddress(),
    am.getDirectMintingFeeBIPS(),
    am.getDirectMintingMinimumFeeUBA(),
    am.getDirectMintingExecutorFeeUBA(),
  ]);
  const fxrp = new ethers.Contract(fxrpAddress, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([fxrp.symbol(), fxrp.decimals()]);
  const fmt = (v) => ethers.formatUnits(v, decimals);

  console.log("=== FAssets direct minting (Coston2) ===");
  console.log(`AssetManagerFXRP : ${amAddress}`);
  console.log(`FXRP (${symbol})   : ${fxrpAddress}`);
  console.log(`recipient        : ${wallet.address}`);
  console.log(`Core Vault XRPL  : ${coreVault}`);

  const pct = (lot * feeBips) / 10000n;
  const fee = pct > minFee ? pct : minFee;
  const gross = lot + fee + execFee;
  console.log(
    `minting 1 lot    : ${fmt(lot)} ${symbol}  (pay ${fmt(gross)} XRP = ${fmt(lot)} + fee ${fmt(fee)} + exec ${fmt(execFee)})`
  );

  const before = await fxrp.balanceOf(wallet.address);
  console.log(`balance before   : ${fmt(before)} ${symbol}`);

  let xrplTx;
  if (txArg) {
    xrplTx = txArg.slice("--tx=".length);
    console.log(`\n[xrpl] reusing existing payment ${xrplTx}`);
  } else {
    const memoHex = buildMemoHex(wallet.address);
    console.log(`\n[xrpl] memo: ${memoHex}`);
    xrplTx = await payCoreVault({
      seed: requireEnv("XRPL_MAKER_SEED"),
      destination: coreVault,
      amountDrops: gross, // FXRP has 6 decimals, exactly matching XRP drops
      memoHex,
      onProgress: (m) => console.log(`[xrpl] ${m}`),
    });
    console.log("[xrpl] waiting 15s for FDC finality window...");
    await new Promise((r) => setTimeout(r, 15000));
  }

  // proofOwner binds the proof to the contract that will consume it — here the AssetManager.
  console.log(`\n[fdc] requesting XRPPayment attestation (proofOwner=${amAddress})`);
  const proof = await requestAndAwaitProof({
    provider,
    wallet,
    txHashHex: `0x${xrplTx.replace(/^0x/, "")}`,
    proofOwner: amAddress,
    onProgress: (m) => console.log(`[fdc] ${m}`),
  });
  if (!proof) throw new Error("no FDC proof within the timeout");

  console.log("\n[mint] calling executeDirectMinting()...");
  const tx = await am.executeDirectMinting(buildProofTuple(proof));
  const receipt = await tx.wait();
  console.log(`[mint] confirmed: ${receipt.hash}`);

  const after = await fxrp.balanceOf(wallet.address);
  console.log(`\nbalance after    : ${fmt(after)} ${symbol}  (+${fmt(after - before)})`);
  console.log(`\nGO: minted real FAssets ${symbol}.`);
  console.log(`  xrpl payment : ${xrplTx}`);
  console.log(`  mint tx      : ${receipt.hash}`);
}

main().catch((err) => {
  console.error(`\nNO-GO: direct minting failed — ${err}`);
  console.error("\nIf the XRPL payment already went through, re-run with --tx=<hash> to re-prove it");
  console.error("without paying again.");
  process.exit(1);
});
