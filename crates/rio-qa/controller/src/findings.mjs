/** Transport candidates to the trusted host, which owns immutable source
 * attribution, stable identity and cell regression classification. */
const routePattern = (journey, route) => {
  const path = new URL(route, 'http://app').pathname;
  return journey.covers?.routes?.find(pattern => {
    const expression = pattern.split('/').map(part => part.startsWith(':') || /^\[.+\]$/.test(part) ? '[^/]+' : part === '*' ? '.*' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/');
    return new RegExp(`^${expression}$`).test(path);
  }) || path;
};
export function probeCandidates(groups, journeys) {
  return groups.flatMap(group => group.occurrences.flatMap(occurrence => occurrence.observations.map(row => ({
    rule_id: group.rule_id, journey: row.journey, step: row.step, route_pattern: routePattern(journeys[row.journey], row.page), cell: row.cell,
    kind: group.kind, severity: group.severity, trigger: { kind: 'probe', predicate: group.rule_id, role_signature: row.role_signature },
    message: `${group.rule_id} measured at ${row.element_path}`, suggested_fix: null, element_paths: [row.element_path, ...(row.related_paths || [])],
    measurements: { ...row.measurements, ...(group.minority ? { minority: group.minority } : {}) }, evidence: Object.values(row.evidence), attribution: row.attribution || {},
  }))));
}
export function observationCandidates(observations, journeys, rules) {
  const byId = new Map(rules.map(rule => [rule.id, rule]));
  return observations.map(row => ({ rule_id: row.rule_id, journey: row.journey, step: row.step, route_pattern: routePattern(journeys[row.journey], row.route), cell: row.cell,
    kind: row.kind, severity: byId.get(row.rule_id).severity, trigger: { kind: 'observation', expected: row.expected, observed: row.observed, targets: row.targets },
    message: `${row.rule_id}: expected ${JSON.stringify(row.expected)}; observed ${JSON.stringify(row.observed)}`, suggested_fix: row.suggested_fix,
    element_paths: row.element_paths || [], measurements: {}, evidence: row.evidence, attribution: row.attribution || {} }));
}
