const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { updateListingLlmSignals, getLlmSignalsByDescriptionHash } = require('./database');

// Kill-switch: set ENABLE_LLM_SIGNALS=true to turn this on. Off by default — this makes real API calls.
const LLM_SIGNALS_ENABLED = process.env.ENABLE_LLM_SIGNALS === 'true';
const MIN_DESCRIPTION_LENGTH = 200;
const MODEL = 'claude-haiku-4-5';

// Haiku 4.5 pricing: $1.00 / $5.00 per 1M tokens (in/out)
const PRICE_PER_M_INPUT = 1.0;
const PRICE_PER_M_OUTPUT = 5.0;

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const SIGNAL_KEYS = [
  'requiresEmployerStatement', 'requiresReference', 'requiresGuarantor',
  'prefersWorkingProfessionals', 'prefersExpats', 'excludesStudents', 'excludesCouples',
  'isPrivateLandlord', 'isAgency', 'emphasisesStability', 'emphasisesCare', 'temporaryLease',
];

const SYSTEM_PROMPT = `You extract structured rental-listing signals from Dutch/English real estate descriptions. Only mark a boolean true if the text clearly implies it — including implicit phrasing that simple keyword matching would miss (e.g. a description that reads as clearly aimed at quiet working professionals without using that exact phrase). If nothing in the text supports a field, use false or an empty string. Do not guess beyond what the text supports.

Respond with ONLY a single JSON object, no markdown fences, no other text, with exactly these keys:
${SIGNAL_KEYS.map(k => `- ${k}: boolean`).join('\n')}
- riskNotes: string — one short sentence on any unusual or strict landlord requirement not covered above, or "" if none
- summary: string — one short, plain-language sentence summarizing the listing for a tenant-facing tip, or "" if nothing tip-worthy`;

function hashDescription(description) {
  return crypto.createHash('sha256').update(description).digest('hex');
}

async function callLlm(description) {
  const anthropic = getClient();
  if (!anthropic) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: description.slice(0, 3000) }],
    }, { signal: controller.signal });

    const usage = response.usage || {};
    const cost = ((usage.input_tokens || 0) / 1e6) * PRICE_PER_M_INPUT + ((usage.output_tokens || 0) / 1e6) * PRICE_PER_M_OUTPUT;
    console.log(`[llm-signals] call cost: $${cost.toFixed(5)} (in=${usage.input_tokens || 0}, out=${usage.output_tokens || 0})`);

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) return null;
    const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed;
  } catch (e) {
    console.error('[llm-signals] call failed:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Runs only on newly-saved listings with a description, never retroactively.
// Always returns without throwing — caller never needs its own try/catch.
async function enrichListingSignals(description, url) {
  if (!LLM_SIGNALS_ENABLED) return;
  if (!description || description.length <= MIN_DESCRIPTION_LENGTH) return;
  if (!url) return;

  try {
    const hash = hashDescription(description);

    const cached = getLlmSignalsByDescriptionHash.get(hash);
    if (cached && cached.llm_signals) {
      updateListingLlmSignals.run(cached.llm_signals, hash, url);
      console.log(`[llm-signals] cache hit, no LLM call: ${url.slice(-50)}`);
      return;
    }

    const signals = await callLlm(description);
    if (!signals) return;

    updateListingLlmSignals.run(JSON.stringify(signals), hash, url);
    console.log(`[llm-signals] saved signals for ${url.slice(-50)}`);
  } catch (e) {
    console.error('[llm-signals] enrichListingSignals failed (non-fatal):', e.message);
  }
}

module.exports = { enrichListingSignals, hashDescription, SIGNAL_KEYS };
