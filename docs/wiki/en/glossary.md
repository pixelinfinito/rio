# Glossary

| Term | Meaning |
| --- | --- |
| Profile | YAML review policy: steps, models, budgets, failure rules |
| Endpoint | Your hosted coordinator; dispatches runners and model calls |
| Runner | Isolated execution host for project code/tools |
| Snapshot | Immutable selected base/head source for a review |
| Merge base | Common Git ancestor used by branch review |
| Finding | Issue with identity, location, category, severity and evidence |
| Evidence level | Strength of support, distinct from impact/severity |
| Baseline | Base-side observation used to distinguish introduced problems |
| Pre-existing | Already present in the base, rather than introduced by the change |
| Incomplete | Some analysis could not finish or was skipped; not a clean bill of health |
| Lineage | Related review rounds for a branch or pull request |
| Suppression | Explicit profile policy excluding a matching finding |
| Verifier quorum | Independent assessments evaluated against evidence requirements |
| Council | Additional independent assessments/experiments for unsettled findings |
| Journey | Browser procedure with user goal, steps and success criteria |
| Cell | A journey's viewport/color-scheme execution |
| Seed / fixture | Repeatable synthetic app data / controlled external input or service |
| SARIF | Standard format for code-scanning results |

[Return to Start](start.md) or [Reference](reference.md).
