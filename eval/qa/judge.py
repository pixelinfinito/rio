"""LLM judge for Rio browser-QA UX review quality.

Grades the model-authored part of one QA report - recommendations and
unverified observations - against grader-only ground truth (frictions.json).
Deterministic probe findings are not part of the UX review and are ignored.
Scores are computed in code from per-item judgments so the rubric stays fixed.
"""
import json
from pathlib import Path

import gateway_client

HERE = Path(__file__).resolve().parent
TRUTH = json.loads((HERE / 'frictions.json').read_text())
JUDGE_MODEL = 'claude-opus-5-5'

ITEM = {
    'type': 'object', 'additionalProperties': False,
    'required': ['id', 'targets_seeded_friction', 'evidence_supported', 'guidance_adherence', 'relevance',
                 'actionability', 'unsupported_benefit_claim', 'reason'],
    'properties': {
        'id': {'type': 'string'},
        'targets_seeded_friction': {'type': 'boolean'},
        'evidence_supported': {'type': 'boolean'},
        'guidance_adherence': {'type': 'integer', 'enum': [0, 1, 2]},
        'relevance': {'type': 'integer', 'enum': [0, 1, 2]},
        'actionability': {'type': 'integer', 'enum': [0, 1, 2]},
        'unsupported_benefit_claim': {'type': 'boolean'},
        'reason': {'type': 'string'},
    },
}
SCHEMA = {
    'type': 'object', 'additionalProperties': False, 'required': ['items', 'summary'],
    'properties': {'items': {'type': 'array', 'items': ITEM}, 'summary': {'type': 'string'}},
}

SYSTEM = """You grade the UX review produced by an automated browser QA agent for one test case.
You receive the app's true behavior, the seeded friction for this case (or a statement that none was seeded), the owner's REVIEW.md, and every item the agent reported. Judge each item independently and literally against the true behavior; the agent's own claims are not evidence.

For each item:
- targets_seeded_friction: true only if the item identifies the specific seeded friction (the same element or behavior and the same problem). A different issue on the same page is false. Always false when no friction was seeded.
- evidence_supported: true if what the item says it observed matches the true behavior of this case. False if it describes something that does not happen, misreads the page, or is a generic concern with no observed basis.
- guidance_adherence (0-2): 2 = consistent with REVIEW.md and cites the applicable requirement or an apt heuristic; 1 = loosely grounded or misses an applicable requirement; 0 = contradicts REVIEW.md (for example flags the stated intentional brand styling) or cites nothing applicable.
- relevance (0-2): 2 = addresses a real, consequential problem for the persona's goal in this journey; 1 = real but minor or tangential; 0 = not a real problem.
- actionability (0-2): 2 = a concrete change a developer could implement directly (what element, what to change it to); 1 = direction without specifics; 0 = no usable proposal.
- unsupported_benefit_claim: true only if the item asserts its proposed benefit was proven, measured or verified. Stating an expected or likely benefit is fine.
- reason: one or two sentences explaining the scores.
Return every item id exactly once. summary: one sentence on how well the review caught the seeded friction (or stayed quiet on a clean case)."""


def review_items(report):
    qa = report.get('qa') or {}
    items = []
    for row in qa.get('recommendations') or []:
        items.append({'id': row['id'], 'type': 'recommendation', **{k: row.get(k) for k in (
            'rule_id', 'journey', 'steps', 'friction_target', 'observed_friction', 'proposed_improvement',
            'expected_benefit', 'trade_offs', 'basis', 'priority', 'confidence')}})
    for index, row in enumerate(qa.get('observations_unverified') or []):
        items.append({'id': row.get('id') or f'observation-{index}', 'type': 'observation', **{k: row.get(k) for k in (
            'rule_id', 'journey', 'step', 'route', 'expected', 'observed', 'suggested_fix')}})
    return items


def journey_outcomes(report):
    qa = report.get('qa') or {}
    return [{'journey': j.get('name'), 'outcome': j.get('outcome'),
             'cells': [{k: c.get(k) for k in ('viewport', 'color_scheme', 'outcome', 'step_reached')} for c in j.get('cells', [])]}
            for j in qa.get('journeys', [])]


def score(case, judged):
    items = judged['items']
    noise = sum(1 for item in items if not item['evidence_supported'] or item['relevance'] == 0)
    claims = sum(item['unsupported_benefit_claim'] for item in items)
    if case['kind'] == 'clean':
        return {'pass': int(noise == 0 and claims == 0), 'score': 1 / (1 + noise + claims), 'found': None,
                'quality': None, 'noise': noise, 'items': len(items)}
    hits = [item for item in items if item['targets_seeded_friction'] and item['evidence_supported']]
    quality = max(((item['guidance_adherence'] + item['relevance'] + item['actionability']) / 6
                   - 0.5 * item['unsupported_benefit_claim'] for item in hits), default=0.0)
    quality = max(quality, 0.0)
    found = int(bool(hits))
    return {'pass': int(found and quality >= 5 / 6), 'score': 0.5 * found + 0.5 * quality, 'found': found,
            'quality': quality, 'noise': noise, 'items': len(items)}


def judge(case, report, review_md, journey_text, client=None):
    """Returns (grade, explanation, judgments, usage)."""
    items = review_items(report)
    truth = TRUTH['frictions'].get(case['id']) or TRUTH['clean'].get(case['id'])
    if truth is None:
        raise KeyError(f'No ground truth for {case["id"]}')
    if not items:
        judged = {'items': [], 'summary': 'The review reported no observations or recommendations.'}
        grade = score(case, judged)
        return grade, {'score': judged['summary']}, judged, None
    prompt = json.dumps({
        'app_true_behavior': TRUTH['app'],
        'case_kind': 'clean control' if case['kind'] == 'clean' else 'seeded UX friction',
        'seeded_friction': truth,
        'review_md': review_md,
        'journey': journey_text,
        'journey_outcomes': journey_outcomes(report),
        # Short aliases: long hash ids are easy for the judge to mangle.
        'agent_items': [{**item, 'id': f'item-{index + 1}'} for index, item in enumerate(items)],
    }, indent=1)
    client = client or gateway_client.client()
    for attempt in range(3):
        try:
            return _judge_once(case, items, prompt, client)
        except RuntimeError:
            if attempt == 2:
                raise


def _judge_once(case, items, prompt, client):
    response = client.messages.create(
        model=JUDGE_MODEL, max_tokens=16000, system=SYSTEM,
        thinking={'type': 'adaptive'},
        output_config={'effort': 'high', 'format': {'type': 'json_schema', 'schema': SCHEMA}},
        messages=[{'role': 'user', 'content': prompt}])
    if response.stop_reason != 'end_turn':
        raise RuntimeError(f'Judge stopped with {response.stop_reason}')
    judged = json.loads(next(block.text for block in response.content if block.type == 'text'))
    aliases = {f'item-{index + 1}': item['id'] for index, item in enumerate(items)}
    if sorted(item['id'] for item in judged['items']) != sorted(aliases):
        raise RuntimeError(f'Judge did not return every item exactly once: {sorted(item["id"] for item in judged["items"])}')
    for item in judged['items']:
        item['id'] = aliases[item['id']]
    usage = {'input_tokens': response.usage.input_tokens, 'output_tokens': response.usage.output_tokens,
             'cache_creation_input_tokens': response.usage.cache_creation_input_tokens or 0,
             'cache_read_input_tokens': response.usage.cache_read_input_tokens or 0}
    grade = score(case, judged)
    explanation = {'score': judged['summary'] + ' ' + ' | '.join(f"{i['id'][:8]}: {i['reason']}" for i in judged['items'])}
    return grade, explanation, judged, {'model': response.model, **usage}
