#### ↩️ Back again: `getCached` dereferences a missing entry
<sub>Error · defect · proven by `tsc` · **matches `fail_on`**</sub>

| PR | History |
| --- | --- |
| #128 | first reported |
| #131 | fixed in `a1c09e2` by adding the guard on line 86 |
| this PR | **removes that guard** |

```suggestion
  if (!hit) return undefined
  return hit.value.data
```

<sub>`77ab…` · `ts/null-deref` · Not right? Reply `/rio dismiss 77ab… wrong` or `fixed` · `intentional` · `irrelevant` · `style`</sub>
<!-- rio:finding:77ab… -->
