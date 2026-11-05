use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Expression {
    Touches(String),
    AddsDependency,
    LinesChangedGreaterThan(u64),
    RiskAtLeast(String),
    Language(String),
    Not(Box<Self>),
    And(Box<Self>, Box<Self>),
    Or(Box<Self>, Box<Self>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BudgetMode {
    Fast,
    Deep,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Action {
    Enable(String),
    Disable(String),
    Budget(BudgetMode),
    RequireHuman,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    pub when: String,
    pub then: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("rule syntax at byte {offset}: {message}")]
pub struct RuleError {
    pub offset: usize,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Word(String),
    String(String),
    Number(u64),
    Left,
    Right,
    Greater,
    GreaterEqual,
    Equal,
}

struct Parser {
    tokens: Vec<(Token, usize)>,
    cursor: usize,
    end: usize,
}

impl Parser {
    fn new(input: &str) -> Result<Self, RuleError> {
        let mut tokens = Vec::new();
        let mut chars = input.char_indices().peekable();
        while let Some((offset, character)) = chars.next() {
            let token = match character {
                c if c.is_whitespace() => continue,
                '(' => Token::Left,
                ')' => Token::Right,
                '>' => {
                    if chars.peek().is_some_and(|(_, c)| *c == '=') {
                        chars.next();
                        Token::GreaterEqual
                    } else {
                        Token::Greater
                    }
                }
                '=' if chars.peek().is_some_and(|(_, c)| *c == '=') => {
                    chars.next();
                    Token::Equal
                }
                '"' | '\'' => {
                    let quote = character;
                    let mut value = String::new();
                    let mut closed = false;
                    while let Some((position, c)) = chars.next() {
                        if c == quote {
                            closed = true;
                            break;
                        }
                        if c == '\\' {
                            let (_, escaped) = chars.next().ok_or_else(|| RuleError {
                                offset: position,
                                message: "unterminated string escape".into(),
                            })?;
                            value.push(match escaped {
                                'n' => '\n',
                                'r' => '\r',
                                't' => '\t',
                                '\\' => '\\',
                                '"' => '"',
                                '\'' => '\'',
                                _ => {
                                    return Err(RuleError {
                                        offset: position,
                                        message: format!("unknown string escape \\{escaped}"),
                                    });
                                }
                            });
                        } else {
                            value.push(c);
                        }
                    }
                    if !closed {
                        return Err(RuleError {
                            offset,
                            message: "unterminated string".into(),
                        });
                    }
                    Token::String(value)
                }
                c if c.is_ascii_digit() => {
                    let mut value = c.to_string();
                    while let Some((_, c)) = chars.peek() {
                        if !c.is_ascii_digit() {
                            break;
                        }
                        value.push(*c);
                        chars.next();
                    }
                    Token::Number(value.parse().map_err(|_| RuleError {
                        offset,
                        message: "integer is too large".into(),
                    })?)
                }
                c if c.is_ascii_alphabetic() || c == '_' => {
                    let mut word = c.to_string();
                    while let Some((_, c)) = chars.peek() {
                        if !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/' | '.')) {
                            break;
                        }
                        word.push(*c);
                        chars.next();
                    }
                    Token::Word(word)
                }
                _ => {
                    return Err(RuleError {
                        offset,
                        message: format!("unexpected character {character:?}"),
                    });
                }
            };
            tokens.push((token, offset));
        }
        Ok(Self {
            tokens,
            cursor: 0,
            end: input.len(),
        })
    }

    fn error(&self, message: impl Into<String>) -> RuleError {
        RuleError {
            offset: self
                .tokens
                .get(self.cursor)
                .map_or(self.end, |(_, offset)| *offset),
            message: message.into(),
        }
    }
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.cursor).map(|(token, _)| token)
    }
    fn take(&mut self) -> Result<Token, RuleError> {
        let token = self
            .peek()
            .cloned()
            .ok_or_else(|| self.error("unexpected end of expression"))?;
        self.cursor += 1;
        Ok(token)
    }
    fn expect(&mut self, expected: Token) -> Result<(), RuleError> {
        if self.peek() != Some(&expected) {
            return Err(self.error(format!("expected {expected:?}")));
        }
        self.cursor += 1;
        Ok(())
    }
    fn word(&mut self, word: &str) -> bool {
        if self.peek() == Some(&Token::Word(word.into())) {
            self.cursor += 1;
            true
        } else {
            false
        }
    }
    fn atom(&mut self) -> Result<String, RuleError> {
        match self.take()? {
            Token::Word(value) | Token::String(value) if !value.is_empty() => Ok(value),
            _ => Err(self.error("expected a name or quoted string")),
        }
    }
    fn finish(&self) -> Result<(), RuleError> {
        if self.peek().is_some() {
            Err(self.error("unexpected trailing input"))
        } else {
            Ok(())
        }
    }
    fn or(&mut self) -> Result<Expression, RuleError> {
        let mut expression = self.and()?;
        while self.word("or") {
            expression = Expression::Or(Box::new(expression), Box::new(self.and()?));
        }
        Ok(expression)
    }
    fn and(&mut self) -> Result<Expression, RuleError> {
        let mut expression = self.unary()?;
        while self.word("and") {
            expression = Expression::And(Box::new(expression), Box::new(self.unary()?));
        }
        Ok(expression)
    }
    fn unary(&mut self) -> Result<Expression, RuleError> {
        if self.word("not") {
            return Ok(Expression::Not(Box::new(self.unary()?)));
        }
        if self.peek() == Some(&Token::Left) {
            self.take()?;
            let inner = self.or()?;
            self.expect(Token::Right)?;
            return Ok(inner);
        }
        let name = self.atom()?;
        match name.as_str() {
            "touches" => {
                self.expect(Token::Left)?;
                let glob = self.atom()?;
                self.expect(Token::Right)?;
                Ok(Expression::Touches(glob))
            }
            "adds_dependency" => {
                self.expect(Token::Left)?;
                self.expect(Token::Right)?;
                Ok(Expression::AddsDependency)
            }
            "lines_changed" => {
                self.expect(Token::Greater)?;
                match self.take()? {
                    Token::Number(n) => Ok(Expression::LinesChangedGreaterThan(n)),
                    _ => Err(self.error("lines_changed requires a non-negative integer")),
                }
            }
            "risk" => {
                self.expect(Token::GreaterEqual)?;
                Ok(Expression::RiskAtLeast(self.atom()?))
            }
            "language" => {
                self.expect(Token::Equal)?;
                Ok(Expression::Language(self.atom()?))
            }
            _ => Err(self.error(format!("unknown predicate {name:?}"))),
        }
    }
}

/// Parse only: local v0.1 never evaluates rule predicates or selects agents.
pub fn parse_expression(input: &str) -> Result<Expression, RuleError> {
    let mut parser = Parser::new(input)?;
    let expression = parser.or()?;
    parser.finish()?;
    Ok(expression)
}

pub fn parse_action(input: &str) -> Result<Action, RuleError> {
    let mut parser = Parser::new(input)?;
    let name = parser.atom()?;
    if !matches!(
        name.as_str(),
        "enable" | "disable" | "budget" | "require_human"
    ) {
        return Err(parser.error(format!("unknown action {name:?}")));
    }
    parser.expect(Token::Left)?;
    let action = match name.as_str() {
        "enable" => Action::Enable(parser.atom()?),
        "disable" => Action::Disable(parser.atom()?),
        "budget" => match parser.atom()?.as_str() {
            "fast" => Action::Budget(BudgetMode::Fast),
            "deep" => Action::Budget(BudgetMode::Deep),
            _ => return Err(parser.error("budget must be fast or deep")),
        },
        "require_human" => Action::RequireHuman,
        _ => unreachable!(),
    };
    parser.expect(Token::Right)?;
    parser.finish()?;
    Ok(action)
}
