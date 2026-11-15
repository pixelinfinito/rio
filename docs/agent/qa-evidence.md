# QA evidence and UX

QA evidence can contain application data; use synthetic fixtures and masks. Hosted evidence operations require endpoint/API token. Prune deletes evidence and revokes download links.

## inspect
QA captures masked screenshots, DOM and traces per journey/viewport/color scheme and base/head. Open cell detail in TUI to inspect artifacts and guidance citations; image viewing support depends on terminal capability. Local downloaded endpoint screenshots are cached seven days with a 200 MB limit.
Deterministic probes and owner-guided UX judgment are separate. A journey can pass while producing UX recommendations. Reports distinguish observation from suggested benefit and verified from unverified; recommendations cannot fail the review.

## troubleshoot
Validate contracts first, then inspect seed/app readiness, blocked-host diagnostics and browser step artifacts. A dependency failure marks dependent journeys precondition_failed while unrelated journeys continue. A harness/model timeout is incomplete evidence, not proof of no issue. Check report status and per-cell outcomes before exporting.

## retention
`rio qa evidence prune --review REVIEW_ID` deletes hosted evidence for that review and revokes signed downloads. Confirm the report no longer needs those artifacts before running. Review cache retention and raw-output policies separately: deleting a downloaded image does not delete hosted objects, and uninstall does not scan repositories for caches.
