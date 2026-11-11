#### 🔴 Guest session can read any order
<sub>Error · security · A01 Broken Access Control · 🧪 reproduced by experiment · **matches `fail_on`**</sub>

`getOrder` validates the id but never compares the order's owner with the session. Any session, a guest included, can read another shopper's order by its number.

| | Step | Where |
| --- | --- | --- |
| 1 | input `req.params.id` | `orders.ts:52` |
| 2 | validated `Number(id) > 0` | `orders.ts:53` |
| 3 | ❌ **no owner check** | — |
| 4 | sensitive read `db.orders.get` | `orders.ts:57` |

```http
GET /api/orders/1042      as guest session B
head  a7c41e2  → 200  returns shopper A's order
base  main     → 404  not visible
```

```suggestion
  const order = await db.orders.get(id)
  if (order?.ownerId !== session.user?.id) return res.sendStatus(404)
```

<details open><summary><b>Council</b> — reproduced · 4 of 5 members answered</summary>

| Member | Family | Round 1 | Round 2 |
| --- | --- | --- | --- |
| skeptic | claude | ❌ not real | ✅ real ¹ |
| exploit-author | gpt | ✅ real | ✅ real |
| code-owner | gemini | abstained | ✅ real ¹ |
| maintainer | mistral | ✅ real | ✅ real |
| tester | qwen (self-hosted) | ⏳ timed out | — |

<sub>¹ changed position citing the experiment above. Decided by evidence tier: the request fails on head and passes on base. Votes are not counted.</sub>
</details>

<details><summary>OWASP Top 10:2025 coverage — 8 assessed, 2 not, with reasons</summary>

…
</details>

<sub>`a7f3c210` · `sec/owner-check` · Not right? Reply `/rio dismiss a7f3c210 wrong` or `fixed` · `intentional` · `irrelevant` · `style`</sub>
<!-- rio:finding:a7f3c210… -->
