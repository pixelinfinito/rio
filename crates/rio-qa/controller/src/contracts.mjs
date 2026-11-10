import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020.js';

export function contract(name) {
  for (const url of [new URL(`../schemas/${name}.json`, import.meta.url), new URL(`../../../../schemas/${name}.json`, import.meta.url)]) {
    try { return JSON.parse(readFileSync(url, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`QA contract unavailable: ${name}`);
}
export const validateContract = schema => new Ajv({ strict: false, validateFormats: false }).compile(schema);
const report = contract('report-v1').properties.qa.properties;
export const recommendationSchema = structuredClone(report.recommendations.items);
export const recommendationInput = structuredClone(recommendationSchema);
// Ownership of these fields cannot be delegated to the model.
for (const key of ['id', 'persona', 'goal', 'journey', 'cells', 'verification_status', 'rationale', 'related_finding_id', 'dismissal']) {
  delete recommendationInput.properties[key];
  recommendationInput.required = recommendationInput.required.filter(name => name !== key);
}
export const assessmentInput = structuredClone(report.assessment.items);
for (const key of ['journey', 'cell']) { delete assessmentInput.properties[key]; assessmentInput.required = assessmentInput.required.filter(name => name !== key); }
export const expectationConflictInput = {
  type: 'object', additionalProperties: false,
  properties: {
    step: { type: 'integer', minimum: 1 },
    guidance_refs: { type: 'array', minItems: 1, items: structuredClone(report.guidance.items) },
    conflict: { type: 'string', minLength: 1, maxLength: 4000 },
    observed: { type: 'string', minLength: 1, maxLength: 4000 },
    evidence: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
  },
  required: ['step', 'guidance_refs', 'conflict', 'observed', 'evidence'],
};
