import { defineSecret, defineString } from 'firebase-functions/params'

// Where every function runs. src/lib/firebase.js (FUNCTIONS_REGION) must name the
// same region, or the browser calls a function that is not there.
export const REGION = 'us-west1'

// The three keys these functions exist to keep out of the browser. Each is set
// with `firebase functions:secrets:set NAME` and reaches only the function that
// lists it; none of them is ever written to a file in this repo.
export const TBA_KEY = defineSecret('TBA_KEY')
export const NEXUS_KEY = defineSecret('NEXUS_KEY')
export const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY')

// Which model answers. A parameter rather than a constant so it can be changed
// without editing code: set it in functions/.env.<project> and redeploy.
// `gpt-5.3-chat-latest` is the chat variant, which follows "restate the numbers,
// do not embellish" instructions well. Pick-list help is the one task that
// reasons, so it can be pointed at a heavier model on its own; left empty it uses
// the same model as everything else.
const DEFAULT_MODEL = 'gpt-5.3-chat-latest'
export const OPENAI_MODEL = defineString('OPENAI_MODEL', { default: DEFAULT_MODEL })
export const OPENAI_MODEL_REASONING = defineString('OPENAI_MODEL_REASONING', { default: '' })

// How many AI requests one member may make, and over how long. Plain environment
// variables (functions/.env.<project>), not parameters: nobody should be asked
// about them at deploy time, and the defaults are what the team has always run.
const DEFAULT_RATE_MAX = 15
const DEFAULT_RATE_WINDOW_SECONDS = 300

function positiveInt(name, fallback) {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/**
 * The AI settings as the function should use them. Call inside a request, not at
 * load.
 *
 * A parameter's default is filled in by the deploy, not by this code: read where
 * no deploy has run (a test importing a module directly) it is empty. An empty
 * model name would break every request quietly, so the default is applied here
 * as well.
 */
export function aiSettings() {
  const model = OPENAI_MODEL.value() || DEFAULT_MODEL
  return {
    model,
    reasoningModel: OPENAI_MODEL_REASONING.value() || model,
    rateMax: positiveInt('AI_RATE_MAX', DEFAULT_RATE_MAX),
    rateWindowSeconds: positiveInt('AI_RATE_WINDOW_SECONDS', DEFAULT_RATE_WINDOW_SECONDS),
  }
}
