'use strict';
const j = require('../src/jupiterClient');

(async () => {
  // Simple SOL -> USDC test on Whirlpool only (real test pair)
  console.log('Test 1: SOL -> USDC on Whirlpool');
  const q1 = await j.getQuote({
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amount: 10000000,  // 0.01 SOL
    slippageBps: 50,
    dexes: ['Whirlpool'],
  });
  console.log('  result:', q1 ? `${q1.outAmount} outAmount via ${q1.routePlan?.[0]?.swapInfo?.label}` : 'NULL');
  console.log('  wasNoRoute:', j.wasLastCallNoRoute());

  // Wait for throttle
  await new Promise(r => setTimeout(r, 500));

  // Reverse: USDC -> SOL on Raydium CPMM
  console.log('\nTest 2: USDC -> SOL on Raydium CPMM');
  const q2 = await j.getQuote({
    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    outputMint: 'So11111111111111111111111111111111111111112',
    amount: q1?.outAmount || 1500000,
    slippageBps: 50,
    dexes: ['Raydium CPMM'],
  });
  console.log('  result:', q2 ? `${q2.outAmount} outAmount via ${q2.routePlan?.[0]?.swapInfo?.label}` : 'NULL');
  console.log('  wasNoRoute:', j.wasLastCallNoRoute());

  // Stats
  console.log('\nJupiter stats:', j.getStats());
})();
