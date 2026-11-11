## 🌊 rio · 3 to fix before merge
<sub>`a7c41e2` · round 2 of 3 · `rio/security` · 4 m 02 s · risk **high**: touches authorization, changes a public route</sub>

> [!CAUTION]
> **3 findings match this repository's `fail_on` policy.**
> rio's check run stays neutral. Your branch protection decides whether this blocks the merge.

| 🔴 To fix | 🟠 Worth a look | ✅ Fixed | 💤 Remembered | 🧭 QA cells |
| --- | --- | --- | --- | --- |
| **3** | **1** | **2** <sub>since round 1</sub> | **2** <sub>dismissals</sub> | **19** <sub>/ 20 passed</sub> |

### 🔴 To fix before merge

| | Finding | Where | Proof |
| --- | --- | --- | --- |
| 1 | [Guest session can read any order](<THREAD_URL>) | `api/orders.ts:57` | 🧪 reproduced |
| 2 | [Pay hidden under the cookie bar · mobile dark](<THREAD_URL>) | `src/style.css:212` | 📐 QA probe |
| 3 | [`parseHeader` calls `.split` on a missing…](<THREAD_URL>) | `src/parser/header.ts:42` | 📐 tsc |

### 🟠 Worth a look

| | Finding | Where | Proof |
| --- | --- | --- | --- |
| 4 | [Unhandled rejection when the stream closes](<THREAD_URL>) | `parser/body.ts:17` | ❔ plausible |

### 🧭 QA · 5 journeys × 4 cells

| Journey | 📱 light | 📱 dark | 🖥️ light | 🖥️ dark |
| --- | --- | --- | --- | --- |
| `checkout` | ✅ | [❌ step 4](<SCREENSHOT_URL>) | ✅ | ✅ |
| `add-to-cart` | ✅ | ✅ | ✅ | ✅ |
| `payment-recovery` | ✅ | ✅ | ✅ | ✅ |
| `keyboard-shopping` | – | – | ✅ | ✅ |
| `profile-address` | ✅ | ✅ | ✅ | ✅ |

<details><summary>💡 <b>1 UX suggestion</b> — advice only, never blocks the merge</summary>

**A declined card leaves no way to retry without retyping the address** · `ux/error-recovery` · observed friction, benefit untested
Keep the address; show the decline inline next to the card field and move focus there. Guidance: `REVIEW.md` §Recovery, line 18.
</details>

<details><summary><b>Since round 1:</b> 2 fixed · 1 dismissed · 2 already posted, not repeated</summary>

…
</details>

<details><summary><b>What ran:</b> 6 checks · 4 agents · blind verifier · council on 1 finding</summary>

…
</details>

<sub>Re-run `/rio review` · Answer a finding `/rio dismiss <id> <reason>` · Full report `rio review --pr 142`</sub>
<!-- rio:summary:… -->
