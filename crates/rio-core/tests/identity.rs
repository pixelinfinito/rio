use proptest::prelude::*;
use rio_core::{
    Finding, OccurrenceState, State, classify_and_group, finding_id, normalized_location,
    normalized_message,
};

fn diagnostic(line: u32) -> Finding {
    let mut finding: Finding = serde_json::from_str(include_str!("fixtures/finding.json")).unwrap();
    finding.location.line_start = line;
    finding.location.line_end = line;
    finding.locations = vec![finding.location.clone()];
    finding
}

#[test]
fn normalization_preserves_semantics() {
    assert_eq!(
        normalized_location("/repo/./src/a.ts", "a.Class.run", "/repo"),
        "src/a.ts::a.Class.run"
    );
    assert_eq!(
        normalized_location(r"C:\repo\src\a.ts", "a.run", r"C:\repo"),
        "src/a.ts::a.run"
    );
    assert_eq!(
        normalized_message(
            "/repo/src/a.ts(12,5): line 42, column 7: tmp_abcdef12 Type '1'",
            "/repo"
        ),
        "src/a.ts(line,column): line <n>, column <n>: <tool-id> Type '1'"
    );
    assert_eq!(
        normalized_message("/tmp/cache/a.ts: Type 'One' is not 'one'", "/repo"),
        "a.ts: Type 'One' is not 'one'"
    );
    let id = |rule, message| finding_id(rule, "src/a.ts", "a.run", message, "/repo");
    assert_ne!(
        id("tsc/TS2322", "Type '1' is not '2'"),
        id("tsc/TS2322", "Type '3' is not '2'")
    );
    assert_ne!(id("lint/a", "same"), id("lint/b", "same"));
    assert_ne!(id("lint/a", "Type One"), id("lint/a", "Type one"));
    assert_eq!(
        id("lint/a", "line 2: tmp_abcdef"),
        id("lint/a", "line 20: tmp_123abc")
    );
}

#[test]
fn an_extra_occurrence_is_worsened_and_losing_one_is_pre_existing() {
    let result = classify_and_group(
        Some(vec![diagnostic(8)]),
        vec![diagnostic(8), diagnostic(12)],
        |_, line| Some(line),
    )
    .unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].state, State::Worsened);
    assert_eq!(
        result[0]
            .locations
            .iter()
            .filter(|l| l.occurrence_state == OccurrenceState::New)
            .count(),
        1
    );
    assert_eq!(result[0].location.line_start, 12);
    let result = classify_and_group(
        Some(vec![diagnostic(8), diagnostic(10), diagnostic(12)]),
        vec![diagnostic(8), diagnostic(12)],
        |_, line| Some(line),
    )
    .unwrap();
    assert_eq!(result[0].state, State::PreExisting);
    assert_eq!(
        result[0]
            .locations
            .iter()
            .filter(|l| l.occurrence_state == OccurrenceState::Fixed)
            .count(),
        1
    );
    assert_eq!(result[0].locations.last().unwrap().line_start, 10);
}

#[test]
fn moved_occurrences_pair_in_order_after_exact_mapping() {
    let result = classify_and_group(
        Some(vec![diagnostic(4), diagnostic(8)]),
        vec![diagnostic(1), diagnostic(12), diagnostic(20)],
        |_, line| (line == 8).then_some(12),
    )
    .unwrap();
    assert_eq!(
        result[0].locations[0].occurrence_state,
        OccurrenceState::PreExisting
    );
    assert_eq!(
        result[0].locations[1].occurrence_state,
        OccurrenceState::PreExisting
    );
    assert_eq!(
        result[0].locations[2].occurrence_state,
        OccurrenceState::New
    );
}

#[test]
fn absent_baseline_is_unclassified_empty_baseline_is_new_and_removed_is_fixed() {
    assert_eq!(
        classify_and_group(None, vec![diagnostic(8)], |_, _| None).unwrap()[0].state,
        State::Unclassified
    );
    assert_eq!(
        classify_and_group(Some(vec![]), vec![diagnostic(8)], |_, _| None).unwrap()[0].state,
        State::New
    );
    assert_eq!(
        classify_and_group(Some(vec![diagnostic(8)]), vec![], |_, _| None).unwrap()[0].state,
        State::Fixed
    );
}

proptest! {
    #[test]
    fn identity_survives_insertions_and_function_reordering(inserted in 0usize..100, reorder in any::<bool>()) {
        let function = "function run() {\n  const value: number = 'bad';\n}";
        let other = "function unrelated() { return 0; }";
        let original = format!("{function}\n{other}");
        let moved = format!("{}{}", "\n".repeat(inserted), if reorder {format!("{other}\n{function}")} else {original.clone()});
        let original_line = original.lines().position(|l| l.contains("'bad'")).unwrap() + 1;
        let moved_line = moved.lines().position(|l| l.contains("'bad'")).unwrap() + 1;
        let before = finding_id("typecheck/tsc/TS2322", "src/a.ts", "a.run", &format!("line {original_line}: Type 'string' is not 'number'"), "/repo");
        let after = finding_id("typecheck/tsc/TS2322", "src/a.ts", "a.run", &format!("line {moved_line}: Type 'string' is not 'number'"), "/repo");
        prop_assert_eq!(before, after);
    }
}

#[test]
fn missing_baseline_annotates_scope_without_hiding_any_occurrence() {
    use rio_core::classify_and_group_scoped;
    let head = vec![diagnostic(2), diagnostic(8)];
    let result =
        classify_and_group_scoped(None, head.clone(), |_, _| None, |l| l.line_start == 8).unwrap();
    assert_eq!(result[0].state, State::Unclassified);
    assert_eq!(result[0].location.line_start, 2);
    assert_eq!(
        result[0].locations[0].occurrence_state,
        OccurrenceState::Unclassified
    );
    assert_eq!(
        result[0].locations[1].occurrence_state,
        OccurrenceState::Unclassified
    );
    assert!(
        result[0]
            .evidence
            .iter()
            .any(|e| e.contains("baseline unavailable"))
    );
    let result = classify_and_group_scoped(None, head.clone(), |_, _| None, |_| false).unwrap();
    assert_eq!(result[0].state, State::Unclassified);
    let result = classify_and_group_scoped(Some(vec![]), head, |_, _| None, |_| false).unwrap();
    assert_eq!(
        result[0].state,
        State::New,
        "a successful baseline retains cross-file regressions"
    );
}
