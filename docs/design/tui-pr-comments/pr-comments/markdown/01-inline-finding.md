#### 🔴 `parseHeader` calls `.split` on a missing content type
<sub>Error · defect · proven by `tsc` · **matches `fail_on`**</sub>

A request without a `Content-Type` header makes `fields.get('ctype')` return `undefined`. Line 42 calls `.split` on it, the worker throws, and the request returns **500**.

```suggestion
  const [type, params] = (ctype ?? DEFAULT_CTYPE).split(';')
```

<details><summary><b>How rio knows</b> — tsc, on the head commit</summary>

```
src/parser/header.ts:42:26 - error TS18048: 'ctype' is possibly 'undefined'.
```
</details>

<details><summary>Same pattern in 2 more places</summary>

- `src/parser/body.ts:31`
- `src/parser/query.ts:12`
</details>

<sub>`8c1e4a9b` · `ts/null-deref` · Not right? Reply `/rio dismiss 8c1e4a9b wrong` or `fixed` · `intentional` · `irrelevant` · `style`</sub>
<!-- rio:finding:8c1e4a9b… -->
