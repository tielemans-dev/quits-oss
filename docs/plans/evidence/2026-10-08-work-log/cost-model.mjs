// Estimates only. Public prices checked 2026-10-08; no provider calls or billing writes.
import assert from 'node:assert/strict';
export const assumptions = {
  checked: '2026-10-08', currency: 'USD', dkkPerUsd: 6.5, vatRate: 0.25,
  fxStatus: 'scenario assumption, not a market quote',
  sttUsdPerMinute: 0.0043, sttModel: 'Deepgram Nova-3 monolingual Danish pre-recorded',
  sttBillingSeconds: 1, sttMinimumSeconds: 1,
  sttMinimumStatus: 'one-second minimum is a conservative scenario assumption; minimum invoice/top-up not confirmed',
  llmModel: 'anthropic/claude-haiku-5.5', llmInputUsdPerMillion: 0.11, llmOutputUsdPerMillion: 0.55,
  llmPriceStatus: 'additional provider rows list 10% uplift, used as planning allowance; exact EU + ZDR route/account not verified',
  llmBusinessCreditFee: 0.08, llmInputLimitPerCall: 100000,
  audioBytesPerMinute: 240000, // 32 kbit/s mono compressed, container overhead excluded.
  transcriptBytesPerCall: 12000, audioRetentionDays: 1, transcriptRetentionDays: 30,
  storageUsdPerGbMonth: 0.03, storageStatus: 'planning allowance, not vendor quote',
  infrastructureDkkPerActive: 2, supportDkkPerActive: 5,
  paymentFractionOfGross: 0.02, paymentFixedDkkPerCharge: 1.8,
  overheadStatus: 'planning allowances; no negotiated payment/hosting/support quote',
};
export const scenarios = [
  { name: 'light', minutes: 20, calls: 20, inputTokensPerCall: 1200, outputTokensPerCall: 300, extraCalls: 2, sttRetryFraction: 0.02 },
  { name: 'typical', minutes: 120, calls: 80, inputTokensPerCall: 2000, outputTokensPerCall: 500, extraCalls: 12, sttRetryFraction: 0.05 },
  { name: 'heavy', minutes: 600, calls: 300, inputTokensPerCall: 3500, outputTokensPerCall: 800, extraCalls: 90, sttRetryFraction: 0.1 },
];
export function cost(s, a = assumptions) {
  assert(s.inputTokensPerCall <= a.llmInputLimitPerCall, 'long-context tariff needs separate input');
  const allCalls = s.calls + s.extraCalls;
  const sttSeconds = Math.ceil(s.minutes * 60 * (1 + s.sttRetryFraction));
  const inputTokens = allCalls * s.inputTokensPerCall;
  const outputTokens = allCalls * s.outputTokensPerCall;
  const sttUsd = sttSeconds / 60 * a.sttUsdPerMinute;
  const llmUsdBeforeFee = (inputTokens * a.llmInputUsdPerMillion + outputTokens * a.llmOutputUsdPerMillion) / 1e6;
  const llmUsd = llmUsdBeforeFee * (1 + a.llmBusinessCreditFee);
  const newAudioBytes = s.minutes * a.audioBytesPerMinute;
  const newTranscriptBytes = s.calls * a.transcriptBytesPerCall;
  // Steady-state rolling retention, uniform arrivals. Retries do not store duplicate blobs.
  const storedByteMonths = newAudioBytes * a.audioRetentionDays / 30 + newTranscriptBytes * a.transcriptRetentionDays / 30;
  const storageUsd = storedByteMonths / 1e9 * a.storageUsdPerGbMonth;
  const providerDkk = (sttUsd + llmUsd + storageUsd) * a.dkkPerUsd;
  return { name: s.name, minutes: s.minutes, calls: allCalls, sttSeconds, inputTokens, outputTokens,
    newAudioBytes, newTranscriptBytes, storedByteMonths, sttUsd, llmUsdBeforeFee, llmUsd,
    storageUsd, providerDkk, operatingDkk: providerDkk + a.infrastructureDkkPerActive + a.supportDkkPerActive };
}
const plans = [
  { name: 'base inclusion', grossDkk: 99, includedMinutesPerOrg: 120, description: 'Hypothetical full base subscription, no incremental feature revenue' },
  { name: 'higher tier increment', grossDkk: 50, includedMinutesPerOrg: 600, description: '149 DKK total, 50 DKK incremental over hypothetical 99 DKK base' },
  { name: 'usage pack', grossDkk: 29, includedMinutesPerOrg: 300, description: 'One explicit prepaid pack, no automatic overage purchase' },
];
function margin(grossDkk, operatingDkk, fixedCharge = 1.8) {
  const netDkk = grossDkk / 1.25;
  const paymentDkk = grossDkk * 0.02 + fixedCharge;
  const contributionDkk = netDkk - paymentDkk - operatingDkk;
  return { grossDkk, netDkk, paymentDkk, operatingDkk, contributionDkk, contributionPercent: 100 * contributionDkk / netDkk };
}
const results = scenarios.map(s => cost(s));
// Break-even keeps typical call/minute and retry ratios, with fixed 7 DKK active-user overhead.
const marginalDkkPerMinute = cost(scenarios[1]).providerDkk / scenarios[1].minutes;
const options = plans.map(plan => ({ ...plan,
  oneActiveUserMargins: results.map(result => ({ scenario: result.name, ...margin(plan.grossDkk, result.operatingDkk) })),
  breakEvenMinutesOneActive: (plan.grossDkk / 1.25 - plan.grossDkk * 0.02 - 1.8 - 7) / marginalDkkPerMinute,
  atIncludedCap: margin(plan.grossDkk, 7 + plan.includedMinutesPerOrg * marginalDkkPerMinute),
}));
const sensitivity = [
  ['twice typical audio, same extraction calls', { ...scenarios[1], minutes: 240 }, assumptions],
  ['four times typical output tokens', { ...scenarios[1], outputTokensPerCall: 2000 }, assumptions],
  ['50 percent extra extraction calls and STT retries', { ...scenarios[1], extraCalls: 40, sttRetryFraction: 0.5 }, assumptions],
  ['30 day audio and 365 day transcript retention', scenarios[1], { ...assumptions, audioRetentionDays: 30, transcriptRetentionDays: 365 }],
  ['FX 20 percent higher', scenarios[1], { ...assumptions, dkkPerUsd: 7.8 }],
  ['STT price doubled', scenarios[1], { ...assumptions, sttUsdPerMinute: 0.0086 }],
  ['Speechmatics calculator Melia 0.24 USD/hour, unverified route', scenarios[1], { ...assumptions, sttUsdPerMinute: 0.24 / 60 }],
  ['Speechmatics Enhanced calculator 0.75 USD/hour, unverified route', scenarios[1], { ...assumptions, sttUsdPerMinute: 0.75 / 60 }],
].map(([name, scenario, inputs]) => ({ name, ...cost({ ...scenario, name }, inputs) }));
const mix = { proportions: { light: 0.5, typical: 0.4, heavy: 0.1 },
  meanOperatingDkk: results[0].operatingDkk * 0.5 + results[1].operatingDkk * 0.4 + results[2].operatingDkk * 0.1,
  heavyShareOfMinutes: 0.1 * 600 / (0.5 * 20 + 0.4 * 120 + 0.1 * 600) };
const organizations = [1, 3, 10].map(activeUsers => ({ activeUsers,
  grossBaseDkk: 99, uncappedTypicalCostDkk: activeUsers * results[1].operatingDkk,
  ...margin(99, activeUsers * results[1].operatingDkk),
  maximumTypicalActiveUsersAtZeroContribution: (99 / 1.25 - 99 * 0.02 - 1.8) / results[1].operatingDkk,
}));
assert.equal(results[1].inputTokens, 184000);
assert.equal(results[1].outputTokens, 46000);
assert.equal(results[1].sttSeconds, 7560);
assert.equal(results[1].storedByteMonths, 1920000);
assert.equal(results[2].newAudioBytes, 144000000);
assert(results[2].operatingDkk > results[1].operatingDkk);
assert(sensitivity[0].providerDkk > results[1].providerDkk);
assert(organizations[2].contributionDkk < 0);
console.log(JSON.stringify({ assumptions, scenarios, results, options, marginalDkkPerMinute, sensitivity, mix, organizations,
  formulas: {
    providerDkk: 'FX * (billedMinutes * STTrate + (inputTokens * inputRate + outputTokens * outputRate) / 1e6 * 1.08 + bytesRetained / 1e9 * storageRate)',
    operatingDkk: 'providerDkk + 2 infrastructure + 5 support per active user',
    contributionDkk: 'grossPrice / 1.25 - grossPrice * 0.02 - 1.8 per charge - operatingDkk',
    organization: 'one organization subscription pays for all active users; sum costs, do not multiply subscription revenue',
  },
  exclusions: ['base invoicing costs', 'engineering and sales', 'corporate tax', 'refunds and chargebacks', 'provider minimum top-ups and credit cash timing', 'unrecoverable input VAT', 'email ingress and attachments', 'egress and request charges beyond infrastructure allowance', 'negotiated contracts'],
  checks: 8, status: 'conditional estimate, no observed customer usage or deployed provider-route verification',
}, null, 2));
