'use strict';
/**
 * P5 test — live execution path validation.
 *
 * NO real money sent. Tests full code path with a fresh keypair (0 SOL).
 */

// Set env FIRST, then require
const { Keypair } = require('@solana/web3.js');
const kp = Keypair.generate();
const fakeSecretB64 = Buffer.from(kp.secretKey).toString('base64');
const config = require('../src/config');
// Direct override (avoid env encoding issues)
config.WALLET_PRIVATE_KEY = 'B64:' + fakeSecretB64;
config.LIVE_EXECUTE = true;

const jitoClient = require('../src/jitoClient');
const jupiter = require('../src/jupiterClient');
const safety = require('../src/safety');
const { Connection, VersionedTransaction, Transaction } = require('@solana/web3.js');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function main() {
  console.log('=== P5 LIVE EXECUTION TEST ===\n');

  console.log(`[1] Test wallet: ${kp.publicKey.toBase58().slice(0, 12)}…`);

  console.log(`[2] jitoClient.loadWallet()...`);
  let loaded;
  try {
    loaded = jitoClient.loadWallet();
    console.log(`    ✓ loaded: ${loaded.publicKey.toBase58().slice(0, 12)}…`);
  } catch (e) {
    console.log(`    ✗ ${e.message}`);
    return;
  }

  console.log(`[3] safety.guardTrade (LIVE mode, 0 SOL balance)...`);
  const liveGuard = await safety.guardTrade({
    tradeSizeSol: 0.01,
    expectedProfitSol: 0.0001,
    mintIn: WSOL_MINT,
    mintOut: USDC_MINT,
    connection: new Connection('https://api.mainnet-beta.solana.com', 'confirmed'),
    walletPubkey: kp.publicKey,
  });
  // Should fail balance check
  console.log(`    ${liveGuard.ok ? '✓' : '✗ (expected)'} ${liveGuard.reason}`);

  console.log(`[4] Jupiter getQuote (SOL → USDC, 0.01 SOL)...`);
  const quote = await jupiter.getQuote({
    inputMint: WSOL_MINT,
    outputMint: USDC_MINT,
    amount: 10_000_000,
    slippageBps: 50,
  });
  if (!quote) {
    console.log(`    ✗ quote failed`);
    return;
  }
  console.log(`    ✓ outAmount: ${quote.outAmount} USDC raw (pi ${parseFloat(quote.priceImpactPct || 0).toFixed(4)}%)`);

  console.log(`[5] Jupiter getSwapTransaction...`);
  const txBase64 = await jupiter.getSwapTransaction(quote, kp.publicKey.toBase58());
  if (!txBase64) {
    console.log(`    ✗ tx build failed`);
    return;
  }
  console.log(`    ✓ tx built: ${txBase64.length} chars base64`);

  console.log(`[6] Deserialize + sign...`);
  const txBytes = Buffer.from(txBase64, 'base64');
  let tx;
  try {
    tx = VersionedTransaction.deserialize(txBytes);
    console.log(`    ✓ VersionedTransaction`);
  } catch (e) {
    tx = Transaction.from(txBytes);
    console.log(`    ✓ legacy Transaction`);
  }
  tx.sign([kp]);
  console.log(`    ✓ signed`);

  console.log(`[7] Build Jito tip tx...`);
  const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const tipTx = await jitoClient.buildTipTx(conn);
  tipTx.sign(kp);
  console.log(`    ✓ tip tx built + signed`);

  console.log(`[8] Submit Jito bundle (will not land — empty wallet)...`);
  const result = await jitoClient.submitSignedBundle([tipTx, tx]);
  if (!result) {
    console.log(`    ✗ submit failed (no result)`);
    return;
  }
  console.log(`    ✓ bundleId: ${result.bundleId}`);
  console.log(`    landed: ${result.landed} (expected: false — no SOL)`);
  console.log(`    error: ${result.error || 'none'}`);

  console.log(`\n=== P5 TEST COMPLETE ===`);
  console.log(`Code path: loadWallet → safety → quote → swapTx → sign → bundleSubmit ✓`);
  console.log(`NO real money sent.`);
}

main().catch(e => {
  console.error('TEST FAILED:', e.message);
  process.exit(1);
});
