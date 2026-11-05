use rio_profile::{Action, BudgetMode, Expression, parse_action, parse_expression};

#[test]
fn every_predicate_and_action_parses() {
    for (input, expected) in [
        ("touches(\"src/**\")", Expression::Touches("src/**".into())),
        ("adds_dependency()", Expression::AddsDependency),
        (
            "lines_changed > 40",
            Expression::LinesChangedGreaterThan(40),
        ),
        ("risk >= high", Expression::RiskAtLeast("high".into())),
        ("language == python", Expression::Language("python".into())),
    ] {
        assert_eq!(parse_expression(input).unwrap(), expected);
    }
    for (input, expected) in [
        ("enable(security)", Action::Enable("security".into())),
        ("disable('style')", Action::Disable("style".into())),
        ("budget(fast)", Action::Budget(BudgetMode::Fast)),
        ("budget(deep)", Action::Budget(BudgetMode::Deep)),
        ("require_human()", Action::RequireHuman),
    ] {
        assert_eq!(parse_action(input).unwrap(), expected);
    }
}

#[test]
fn boolean_precedence_and_parentheses_are_preserved() {
    let a = Expression::AddsDependency;
    let b = Expression::Language("python".into());
    let c = Expression::LinesChangedGreaterThan(0);
    assert_eq!(
        parse_expression("adds_dependency() or language == python and not lines_changed > 0")
            .unwrap(),
        Expression::Or(
            Box::new(a.clone()),
            Box::new(Expression::And(
                Box::new(b.clone()),
                Box::new(Expression::Not(Box::new(c.clone())))
            ))
        )
    );
    assert_eq!(
        parse_expression("not (adds_dependency() or language == python) and lines_changed > 0")
            .unwrap(),
        Expression::And(
            Box::new(Expression::Not(Box::new(Expression::Or(
                Box::new(a),
                Box::new(b)
            )))),
            Box::new(c)
        )
    );
}

#[test]
fn invalid_syntax_and_unknown_names_are_rejected_with_offsets() {
    assert!(
        parse_expression("owns('src/**')")
            .unwrap_err()
            .message
            .contains("unknown predicate")
    );
    assert!(
        parse_action("launch(security)")
            .unwrap_err()
            .message
            .contains("unknown action")
    );
    for input in [
        "",
        "touches()",
        "touches('unterminated)",
        "touches('bad\\q')",
        "adds_dependency(x)",
        "lines_changed > -1",
        "lines_changed > 18446744073709551616",
        "language = python",
        "risk > high",
        "adds_dependency() trailing",
        "(adds_dependency()",
        "not",
    ] {
        let error = parse_expression(input).unwrap_err();
        assert!(error.offset <= input.len(), "{input}");
    }
    for input in [
        "budget(slow)",
        "enable()",
        "require_human(x)",
        "disable(x) trailing",
    ] {
        assert!(parse_action(input).is_err());
    }
}
