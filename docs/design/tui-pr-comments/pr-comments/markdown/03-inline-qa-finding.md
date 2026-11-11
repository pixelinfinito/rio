#### 🔴 Pay is hidden under the cookie bar on mobile in dark mode
<sub>Error · QA · journey `checkout` step 4 · 📐 measured by `mobile/fixed-overlap` · regression from main</sub>

| main ✓ (base) | this PR |
| --- | --- |
| ![step 4 on main](<SIGNED_URL_BASE_STEP4>) | ![step 4 on this PR](<SIGNED_URL_HEAD_STEP4>) |
| step 4 · Pay reachable | step 4 · Pay covered 100 % |

| | 📱 mobile | 🖥️ desktop |
| --- | --- | --- |
| light | ✅ passed | ✅ passed |
| dark | ❌ **step 4** | ✅ passed |

Line 212 sets `line-height: 2.4`. With the dark-mode fallback font the bar grows from 64 to 112 px and covers Pay, so the tap at (195, 790) lands on the bar.

```suggestion
  line-height: 1.5;
```

<sub>Evidence: [screenshot](<SIGNED_URL>) · [DOM](<SIGNED_URL>) · [trace](<SIGNED_URL>) — masked before storage, links expire 17 Nov</sub>

<sub>`41d0e7b2` · `mobile/fixed-overlap` · Not right? Reply `/rio dismiss 41d0e7b2 wrong` or `fixed` · `intentional` · `irrelevant` · `style`</sub>
<!-- rio:finding:41d0e7b2… -->
