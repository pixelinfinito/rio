//! Renders the Worker's pinned round-4 lineage report (produced by the recorded
//! end-to-end test in worker/tests/convergence.test.ts) in every format.
use rio_core::*;
use std::collections::BTreeSet;

fn report() -> Report {
    serde_json::from_str(include_str!("fixtures/lineage-round4.json")).unwrap()
}

#[test]
fn worker_round_four_lineage_renders_in_every_format_with_policy_exit() {
    let report = report();
    let lineage = report.lineage.as_ref().unwrap();
    assert!(lineage.capped && lineage.diff_only);
    assert_eq!((lineage.round, lineage.cap, lineage.held_back), (4, 3, 3));
    // Identities posted before round 4: everything except the new `src/e.ts` finding.
    let posted: BTreeSet<String> = report
        .findings
        .iter()
        .filter(|f| f.first_posted_in.is_some())
        .map(|f| f.id.clone())
        .collect();
    assert_eq!(posted.len(), 3);
    let policy = FailOn::default().compile().unwrap();
    let options = RenderOptions {
        width: 160,
        policy: Some(&policy),
        posted: Some(&posted),
        ..Default::default()
    };
    for output in [
        render_terminal(&report, &options),
        render_markdown(&report, &options),
    ] {
        assert!(output.contains("Round 4 of cap 3"), "{output}");
        assert!(
            output.contains("Held back as already posted: 3"),
            "{output}"
        );
        assert!(output.contains("Reconsider"), "{output}");
        assert!(output.contains("3 unresolved finding(s)"), "{output}");
        assert!(output.contains("Author-response ratio: 0"), "{output}");
        assert!(output.contains("(already posted)"), "{output}");
        for title in [
            "The call to a now throws",
            "The call to d now throws",
            "The call to e now throws",
        ] {
            assert!(output.contains(title), "{title}: {output}");
        }
    }
    // JSON keeps the lineage and lifecycle data unchanged and validates.
    let json: serde_json::Value = serde_json::from_slice(&render_json(&report).unwrap()).unwrap();
    assert_eq!(json["lineage"]["round"], 4);
    assert_eq!(json["lineage"]["reconsider"]["unresolved"], 3);
    let dismissed = json["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["status"] == "dismissed")
        .unwrap();
    assert_eq!(dismissed["state"], "new");
    assert_eq!(dismissed["author_response"]["reason"], "intentional");
    // A dismissal does not change policy: the new defects still fail the review.
    assert_eq!(exit_code(&report, &policy, ExitContext::default()), 1);
}
