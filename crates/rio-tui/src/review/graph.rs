//! 04 — Impact graph: the dependents of the focused finding's symbol by hop,
//! in head, base or delta.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use ratatui::crossterm::event::{KeyCode, KeyEvent};

use super::{hrule, id8, put_in, vrule, wrap};
use crate::{
    app::{Action, Effect, Screen, Session},
    canvas::{Canvas, Run, bold, pad, run},
    chrome::{Board, Key, key, keybar, quiet, status},
    theme::Token,
};

/// What a node is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    /// `ƒ`
    Function,
    /// `◇`
    Method,
    /// `▣`
    Class,
    /// `◎`
    Test,
    /// `▤`
    File,
    /// `?`: found by a text match, not resolved.
    Unresolved,
}

impl NodeKind {
    fn glyph(self) -> (&'static str, Token) {
        match self {
            NodeKind::Function => ("ƒ", Token::Signal),
            NodeKind::Method => ("◇", Token::Signal),
            NodeKind::Class => ("▣", Token::Signal),
            NodeKind::Test => ("◎", Token::Pass),
            NodeKind::File => ("▤", Token::Signal),
            NodeKind::Unresolved => ("?", Token::Warn),
        }
    }

    fn name(self) -> &'static str {
        match self {
            NodeKind::Function => "function",
            NodeKind::Method => "method",
            NodeKind::Class => "class",
            NodeKind::Test => "test",
            NodeKind::File => "file",
            NodeKind::Unresolved => "text match",
        }
    }
}

/// How the change touches a node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeState {
    /// Its body changed (`~`).
    Changed,
    /// It depends on a changed node.
    Dependent,
    /// Neither.
    Unchanged,
}

/// A finding at a node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphFinding {
    /// Its full identity.
    pub id: String,
    /// Its short title.
    pub title: String,
    /// It matches `fail_on`.
    pub failing: bool,
}

/// A symbol of the impact graph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphNode {
    /// Its graph id.
    pub id: String,
    /// Its name, e.g. `parseHeader`.
    pub label: String,
    /// What it is.
    pub kind: NodeKind,
    /// Its file.
    pub path: String,
    /// Its first line.
    pub line: u32,
    /// Its last line.
    pub line_end: u32,
    /// Where it is as the box shows it, e.g. `header.ts:38` or `plugins · text`.
    pub place: String,
    /// Hops from the finding's symbol in the CLI's slice.
    pub hop: u32,
    /// Changed, dependent or unchanged.
    pub state: NodeState,
    /// Present in head.
    pub in_head: bool,
    /// Present in base.
    pub in_base: bool,
    /// No test reaches it.
    pub untested: bool,
    /// How it changed, e.g. `a3f9 → 7c21`.
    pub delta: Option<String>,
    /// Findings located in it.
    pub findings: Vec<GraphFinding>,
}

/// A dependency: `from` depends on `to` (`from` calls, tests or refers to `to`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphEdge {
    /// The dependent node.
    pub from: String,
    /// The node it depends on.
    pub to: String,
    /// `calls`, `tests`, `refs`, `imports`.
    pub kind: String,
    /// Found by a text match (`┄`), not resolved.
    pub probable: bool,
    /// Present in head.
    pub in_head: bool,
    /// Present in base.
    pub in_base: bool,
}

/// The impact graph around a finding's symbol; the CLI fills it from rio-graph.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GraphData {
    /// The header context, e.g. `feature/parser-guards → origin/main`.
    pub context: String,
    /// The node the view starts on (the finding's symbol).
    pub seed: String,
    /// The slice's nodes.
    pub nodes: Vec<GraphNode>,
    /// The slice's edges.
    pub edges: Vec<GraphEdge>,
    /// Nodes in the whole graph.
    pub total_nodes: usize,
    /// Edges in the whole graph.
    pub total_edges: usize,
    /// The node limit the graph was built with.
    pub max_nodes: usize,
    /// The graph was built completely (not truncated at the limit).
    pub complete: bool,
    /// The initial hop count.
    pub hops: u32,
    /// Which edge kinds the slice follows, e.g. `all kinds`.
    pub kinds: String,
}

impl GraphData {
    /// No graph for this symbol.
    pub fn empty(context: &str, symbol: &str) -> Self {
        Self {
            context: context.into(),
            seed: symbol.into(),
            hops: 2,
            kinds: "all kinds".into(),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum View {
    Head,
    Base,
    Delta,
}

const KEYS: &[Key] = &[
    key("←→", "hop"),
    key("↑↓", "node"),
    key("⏎", "focus"),
    key("+/-", "hops"),
    key("v", "head/base/delta"),
    key("esc", "back"),
];

/// A node placed on the grid: hop column and the row of its top border.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Placed {
    id: String,
    col: u16,
    top: u16,
}

/// An edge drawn between columns: from the box at `col` to the one at `col + 1`.
struct Link {
    row: u16,
    col: u16,
    kind: String,
    probable: bool,
}

#[derive(Default)]
struct Layout {
    placed: Vec<Placed>,
    links: Vec<Link>,
    /// The seed's dependents' label rows (the trunk) and their edge kinds.
    trunk: Vec<(u16, String, bool)>,
    seed_top: u16,
    /// The seed's changed callee below it, with the edge kind.
    down: Option<(u16, String)>,
    bottom: u16,
}

pub(crate) struct GraphScreen {
    data: GraphData,
    seed: String,
    selected: String,
    hops: u32,
    view: View,
}

impl GraphScreen {
    pub(crate) fn new(data: GraphData) -> Self {
        let seed = data.seed.clone();
        let hops = data.hops.max(1);
        Self {
            seed: seed.clone(),
            selected: seed,
            hops,
            view: View::Head,
            data,
        }
    }

    fn node(&self, id: &str) -> Option<&GraphNode> {
        self.data.nodes.iter().find(|n| n.id == id)
    }

    fn edge_visible(&self, e: &GraphEdge) -> bool {
        match self.view {
            View::Head => e.in_head,
            View::Base => e.in_base,
            View::Delta => e.in_head != e.in_base,
        }
    }

    /// Nodes of the current view within the hop count, with their hop.
    fn visible(&self) -> BTreeMap<String, u32> {
        let mut keep: BTreeSet<&str> = BTreeSet::new();
        for n in &self.data.nodes {
            let shown = match self.view {
                View::Head => n.in_head,
                View::Base => n.in_base,
                View::Delta => n.state == NodeState::Changed || n.in_head != n.in_base,
            };
            if shown || n.id == self.seed {
                keep.insert(&n.id);
            }
        }
        if self.view == View::Delta {
            for e in self.data.edges.iter().filter(|e| self.edge_visible(e)) {
                keep.insert(&e.from);
                keep.insert(&e.to);
            }
        }
        // Hop 0 is the seed and every changed node; each hop adds dependents.
        let mut hops = BTreeMap::new();
        let mut queue = VecDeque::new();
        for n in &self.data.nodes {
            let source = n.id == self.seed || n.state == NodeState::Changed;
            if source && keep.contains(n.id.as_str()) {
                hops.insert(n.id.clone(), 0);
                queue.push_back(n.id.clone());
            }
        }
        while let Some(id) = queue.pop_front() {
            let hop = hops[&id];
            if hop >= self.hops {
                continue;
            }
            for e in self
                .data
                .edges
                .iter()
                .filter(|e| self.edge_visible(e) && e.to == id)
            {
                if keep.contains(e.from.as_str()) && !hops.contains_key(&e.from) {
                    hops.insert(e.from.clone(), hop + 1);
                    queue.push_back(e.from.clone());
                }
            }
        }
        hops
    }

    fn visible_edges(&self, visible: &BTreeMap<String, u32>) -> Vec<&GraphEdge> {
        self.data
            .edges
            .iter()
            .filter(|e| {
                self.edge_visible(e) && visible.contains_key(&e.from) && visible.contains_key(&e.to)
            })
            .collect()
    }

    fn layout(&self, columns: u16) -> Layout {
        let visible = self.visible();
        let edges = self.visible_edges(&visible);
        let mut layout = Layout::default();
        if !visible.contains_key(&self.seed) {
            return layout;
        }
        let mut used: BTreeSet<String> = BTreeSet::new();
        used.insert(self.seed.clone());
        let dependents = |of: &str, used: &BTreeSet<String>| -> Vec<&GraphEdge> {
            edges
                .iter()
                .filter(|e| e.to == of && !used.contains(&e.from))
                .copied()
                .collect()
        };
        let mut top = 4;
        let first = dependents(&self.seed, &used);
        if columns > 1 {
            for edge in &first {
                if used.contains(&edge.from) {
                    continue;
                }
                used.insert(edge.from.clone());
                layout.placed.push(Placed {
                    id: edge.from.clone(),
                    col: 1,
                    top,
                });
                layout
                    .trunk
                    .push((top + 1, edge.kind.clone(), edge.probable));
                if columns > 2
                    && let Some(next) = dependents(&edge.from, &used).first()
                {
                    used.insert(next.from.clone());
                    layout.placed.push(Placed {
                        id: next.from.clone(),
                        col: 2,
                        top,
                    });
                    layout.links.push(Link {
                        row: top + 1,
                        col: 1,
                        kind: next.kind.clone(),
                        probable: next.probable,
                    });
                }
                top += 5;
            }
        }
        let seed_label = match (layout.trunk.first(), layout.trunk.last()) {
            (Some(a), Some(b)) => (a.0 + b.0) / 2,
            _ => 5,
        };
        layout.seed_top = seed_label - 1;
        layout.placed.push(Placed {
            id: self.seed.clone(),
            col: 0,
            top: layout.seed_top,
        });
        let mut bottom = (layout.seed_top + 3).max(top.saturating_sub(2));
        // The seed's changed callees below it, each with its own dependents.
        let callees: Vec<&GraphEdge> = edges
            .iter()
            .filter(|e| {
                e.from == self.seed
                    && !used.contains(&e.to)
                    && self
                        .node(&e.to)
                        .is_some_and(|n| n.state == NodeState::Changed)
            })
            .copied()
            .collect();
        for (i, edge) in callees.iter().enumerate() {
            let at = bottom + 2;
            if i == 0 {
                layout.down = Some((at, edge.kind.clone()));
            }
            used.insert(edge.to.clone());
            layout.placed.push(Placed {
                id: edge.to.clone(),
                col: 0,
                top: at,
            });
            let mut parent = edge.to.clone();
            for col in 1..columns {
                let Some(next) = dependents(&parent, &used).first().copied() else {
                    break;
                };
                used.insert(next.from.clone());
                layout.placed.push(Placed {
                    id: next.from.clone(),
                    col,
                    top: at,
                });
                layout.links.push(Link {
                    row: at + 1,
                    col: col - 1,
                    kind: next.kind.clone(),
                    probable: next.probable,
                });
                parent = next.from.clone();
            }
            bottom = at + 3;
        }
        layout.bottom = bottom;
        layout
    }

    fn columns(&self, div: u16) -> u16 {
        let fit = (div.saturating_sub(21) / 30 + 1).max(1);
        fit.min(self.hops.min(2) as u16 + 1)
    }

    fn move_in_column(&mut self, delta: i32, div: u16) {
        let layout = self.layout(self.columns(div));
        let Some(me) = layout.placed.iter().find(|p| p.id == self.selected) else {
            return;
        };
        let mut same: Vec<&Placed> = layout.placed.iter().filter(|p| p.col == me.col).collect();
        same.sort_by_key(|p| p.top);
        let at = same.iter().position(|p| p.id == me.id).unwrap_or(0) as i32;
        let next = (at + delta).clamp(0, same.len() as i32 - 1) as usize;
        self.selected = same[next].id.clone();
    }

    fn move_across(&mut self, delta: i32, div: u16) {
        let layout = self.layout(self.columns(div));
        let Some(me) = layout.placed.iter().find(|p| p.id == self.selected) else {
            return;
        };
        let col = me.col as i32 + delta;
        if col < 0 {
            return;
        }
        if let Some(best) = layout
            .placed
            .iter()
            .filter(|p| i32::from(p.col) == col)
            .min_by_key(|p| p.top.abs_diff(me.top))
        {
            self.selected = best.id.clone();
        }
    }
}

const DIV: u16 = 83;

fn div_of(w: u16) -> u16 {
    if w >= 120 {
        DIV
    } else {
        w.saturating_sub(29).max(44)
    }
}

impl Screen for GraphScreen {
    fn title(&self) -> &'static str {
        "Impact graph"
    }
    fn board(&self) -> Board {
        Board::V2
    }
    fn keys(&self) -> &'static [Key] {
        KEYS
    }

    fn draw(&self, c: &mut Canvas<'_>, _session: &Session) {
        c.clear(Token::Bg);
        let data = &self.data;
        super::head(
            c,
            &format!("{} · graph", data.context),
            &[
                status(
                    format!(
                        "graph · {} nodes · {} edges",
                        data.total_nodes, data.total_edges
                    ),
                    Token::Signal,
                ),
                quiet(format!(
                    "{} hop{}",
                    self.hops,
                    if self.hops == 1 { "" } else { "s" }
                )),
            ],
        );
        let (w, h) = (c.width(), c.height());
        let div = div_of(w);
        let bottom = h.saturating_sub(1);
        vrule(c, div, 1, bottom);
        let mut runs = vec![
            run(" ", Token::Fg, Token::Bg),
            bold("Impact graph", Token::Fg, Token::Bg),
            run("  ", Token::Fg, Token::Bg),
        ];
        for (view, name) in [
            (View::Head, "head"),
            (View::Base, "base"),
            (View::Delta, "delta"),
        ] {
            runs.push(if view == self.view {
                bold(format!(" {name} "), Token::Bg, Token::Signal)
            } else {
                run(format!(" {name} "), Token::Dim, Token::Bg)
            });
        }
        runs.push(run("  ", Token::Fg, Token::Bg));
        runs.push(run(
            format!("hops {} · {}", self.hops, data.kinds),
            Token::Faint,
            Token::Bg,
        ));
        let end = put_in(c, 0, 1, div - 1, &runs);
        let size = format!(
            "{}/{} · {}",
            data.total_nodes,
            data.max_nodes,
            if data.complete {
                "complete"
            } else {
                "truncated"
            }
        );
        if end + 2 + (size.len() as u16) < div {
            c.put_right(div - 1, 1, &[run(size, Token::Faint, Token::Bg)]);
        }
        hrule(c, 2, 0, div);
        let legend_y = h.saturating_sub(5);
        hrule(c, legend_y, 0, div);
        put_in(
            c,
            1,
            legend_y + 1,
            div - 1,
            &[run(
                "ƒ fn  ◇ method  ▣ class  ◎ test  ▤ file",
                Token::Faint,
                Token::Bg,
            )],
        );
        put_in(
            c,
            1,
            legend_y + 2,
            div - 1,
            &[
                run("━", Token::Signal, Token::Bg),
                run(" ", Token::Fg, Token::Bg),
                run("selected", Token::Faint, Token::Bg),
                run("  ", Token::Fg, Token::Bg),
                run("─", Token::Dim, Token::Bg),
                run(" ", Token::Fg, Token::Bg),
                run("resolved", Token::Faint, Token::Bg),
                run("  ", Token::Fg, Token::Bg),
                run("┄", Token::Warn, Token::Bg),
                run(" ", Token::Fg, Token::Bg),
                run("probable", Token::Faint, Token::Bg),
                run("   ", Token::Fg, Token::Bg),
                run("~ changed  ● finding  ▲ untested", Token::Faint, Token::Bg),
            ],
        );
        if self.node(&self.seed).is_none() {
            put_in(
                c,
                1,
                4,
                div - 1,
                &[run(
                    format!("no impact graph for {}", self.seed),
                    Token::Faint,
                    Token::Bg,
                )],
            );
            keybar(c, KEYS);
            return;
        }
        let columns = self.columns(div);
        let titles = [
            ("HOP 0", "changed"),
            ("HOP 1", "dependents"),
            ("HOP 2", "transitive"),
        ];
        for (i, (hop, what)) in titles.iter().enumerate().take(usize::from(columns)) {
            put_in(
                c,
                1 + 30 * i as u16,
                3,
                div - 1,
                &[
                    bold(*hop, Token::Fg, Token::Bg),
                    run(" ", Token::Fg, Token::Bg),
                    run(*what, Token::Faint, Token::Bg),
                ],
            );
        }
        let layout = self.layout(columns);
        let limit = legend_y;
        self.draw_edges(c, &layout, limit);
        for p in &layout.placed {
            if p.top + 3 < limit {
                self.draw_node(c, p);
            }
        }
        let drawn = layout.placed.len();
        let hidden = data.total_nodes.saturating_sub(drawn);
        if hidden > 0 && layout.bottom + 2 < limit {
            let x = 1 + 30 * (columns - 1);
            put_in(
                c,
                x,
                layout.bottom + 2,
                div - 1,
                &[run(
                    format!("+{hidden} more · ⏎ expand"),
                    Token::Faint,
                    Token::Bg,
                )],
            );
        }
        self.draw_detail(c, div + 2, w.saturating_sub(1));
        keybar(c, KEYS);
    }

    fn on_key(&mut self, key: KeyEvent, _session: &mut Session) -> Action {
        // The layout depends on the width; keys use the design width.
        let div = DIV;
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.move_in_column(-1, div),
            KeyCode::Down | KeyCode::Char('j') => self.move_in_column(1, div),
            KeyCode::Left | KeyCode::Char('h') => self.move_across(-1, div),
            KeyCode::Right | KeyCode::Char('l') => self.move_across(1, div),
            KeyCode::Enter => self.seed = self.selected.clone(),
            KeyCode::Char('+') | KeyCode::Char('=') => self.hops = (self.hops + 1).min(6),
            KeyCode::Char('-') => {
                self.hops = self.hops.saturating_sub(1).max(1);
                if !self
                    .layout(self.columns(div))
                    .placed
                    .iter()
                    .any(|p| p.id == self.selected)
                {
                    self.selected = self.seed.clone();
                }
            }
            KeyCode::Char('v') => {
                self.view = match self.view {
                    View::Head => View::Base,
                    View::Base => View::Delta,
                    View::Delta => View::Head,
                };
                self.selected = self.seed.clone();
            }
            KeyCode::Char('b') => {
                self.view = View::Base;
                self.selected = self.seed.clone();
            }
            KeyCode::Char('g') => return Action::Pop,
            KeyCode::Char('o') => {
                if let Some(n) = self.node(&self.selected) {
                    return Action::Effect(Effect::Edit {
                        path: n.path.clone(),
                        line: n.line.max(1),
                    });
                }
            }
            _ => {}
        }
        Action::None
    }
}

impl GraphScreen {
    fn draw_node(&self, c: &mut Canvas<'_>, p: &Placed) {
        let Some(n) = self.node(&p.id) else {
            return;
        };
        let x = 1 + 30 * p.col;
        let selected = n.id == self.selected;
        let (border, h, v, corners) = if selected {
            (Token::Signal, "━", "┃", ["┏", "┓", "┗", "┛"])
        } else if n.state == NodeState::Changed {
            (Token::Signal, "─", "│", ["┌", "┐", "└", "┘"])
        } else {
            (Token::Rule, "─", "│", ["┌", "┐", "└", "┘"])
        };
        let bg = if selected { Token::Raise } else { Token::Bg };
        let line = h.repeat(18);
        c.put(
            x,
            p.top,
            &run(
                format!("{}{line}{}", corners[0], corners[1]),
                border,
                Token::Bg,
            ),
        );
        c.put(
            x,
            p.top + 3,
            &run(
                format!("{}{line}{}", corners[2], corners[3]),
                border,
                Token::Bg,
            ),
        );
        for dy in 1..3 {
            c.put(x, p.top + dy, &run(v, border, Token::Bg));
            c.fill(p.top + dy, x + 1, x + 19, bg);
            c.put(x + 19, p.top + dy, &run(v, border, Token::Bg));
        }
        let (glyph, gfg) = n.kind.glyph();
        let label_fg = if n.kind == NodeKind::Unresolved {
            Token::Faint
        } else {
            Token::Fg
        };
        let mut marks: Vec<Run> = Vec::new();
        if n.state == NodeState::Changed {
            marks.push(run("~", Token::Signal, bg));
        }
        if !n.findings.is_empty() {
            marks.push(run("●", Token::Fail, bg));
        }
        if n.untested {
            marks.push(run("▲", Token::Warn, bg));
        }
        let marks_w = marks.len() as u16;
        let label_end = x + 19 - marks_w;
        put_in(
            c,
            x + 2,
            p.top + 1,
            label_end,
            &[
                run(glyph, gfg, bg),
                run(" ", Token::Fg, bg),
                if selected {
                    bold(n.label.clone(), label_fg, bg)
                } else {
                    run(n.label.clone(), label_fg, bg)
                },
            ],
        );
        c.puts(label_end, p.top + 1, &marks);
        // The place may run over the right border, as long paths do.
        let place_fg = if n.kind == NodeKind::Unresolved {
            Token::Faint
        } else {
            Token::Dim
        };
        c.put(x + 2, p.top + 2, &run(n.place.clone(), place_fg, bg));
    }

    fn draw_edges(&self, c: &mut Canvas<'_>, layout: &Layout, limit: u16) {
        let put = |c: &mut Canvas<'_>, x: u16, y: u16, text: &str, fg: Token| {
            if y < limit {
                c.put(x, y, &run(text, fg, Token::Bg));
            }
        };
        // Trunk from the seed to its dependents.
        if let (Some(first), Some(last)) = (layout.trunk.first(), layout.trunk.last()) {
            let seed_label = layout.seed_top + 1;
            put(c, 21, seed_label, "──", Token::Signal);
            let x = 23;
            for y in first.0.min(seed_label)..=last.0.max(seed_label) {
                put(c, x, y, "│", Token::Signal);
            }
            for (i, (row, kind, probable)) in layout.trunk.iter().enumerate() {
                let dash = if *probable { "┄" } else { "─" };
                let junction = if layout.trunk.len() == 1 {
                    dash
                } else if i == 0 {
                    "┌"
                } else if i + 1 == layout.trunk.len() {
                    "└"
                } else {
                    "├"
                };
                let fill = 8usize.saturating_sub(3 + kind.chars().count());
                let text = format!("{junction}{dash}{kind}{}▶", dash.repeat(fill));
                put(
                    c,
                    x,
                    *row,
                    &text,
                    if *probable {
                        Token::Warn
                    } else {
                        Token::Signal
                    },
                );
            }
            // The seed's row joins the trunk unless a dependent sits on it.
            if !layout.trunk.iter().any(|t| t.0 == seed_label) {
                let at_seed = if seed_label < first.0 {
                    "┌"
                } else if seed_label > last.0 {
                    "└"
                } else {
                    "┤"
                };
                put(c, x, seed_label, at_seed, Token::Signal);
            }
        }
        // Between columns.
        for link in &layout.links {
            let x = 1 + 30 * link.col + 20;
            let (dash, fg) = if link.probable {
                ("┄", Token::Warn)
            } else {
                ("─", Token::Dim)
            };
            let len = link.kind.chars().count();
            let left = if link.col == 0 { 3 } else { 2 };
            let right = 9usize.saturating_sub(left + len);
            let text = format!("{}{}{}▶", dash.repeat(left), link.kind, dash.repeat(right));
            put(c, x, link.row, &text, fg);
        }
        // Down to the seed's changed callee.
        if let Some((top, kind)) = &layout.down {
            let from = layout.seed_top + 4;
            let to = top.saturating_sub(1);
            for y in from..to {
                put(c, 3, y, "│", Token::Dim);
            }
            put(c, 3, to, "▼", Token::Dim);
            if to > from && (from + to - 1) / 2 < limit {
                c.put(
                    5,
                    (from + to - 1) / 2,
                    &run(kind.as_str(), Token::Faint, Token::Bg),
                );
            }
        }
    }

    fn draw_detail(&self, c: &mut Canvas<'_>, x: u16, right: u16) {
        let h = c.height();
        let limit = h.saturating_sub(3);
        let Some(n) = self.node(&self.selected) else {
            return;
        };
        let visible = self.visible();
        let edges = self.visible_edges(&visible);
        let mut y = 2;
        let line = |c: &mut Canvas<'_>, y: &mut u16, runs: &[Run]| {
            if *y < limit {
                put_in(c, x, *y, right, runs);
            }
            *y += 1;
        };
        line(c, &mut y, &[bold("SELECTED NODE", Token::Faint, Token::Bg)]);
        let (glyph, gfg) = n.kind.glyph();
        line(
            c,
            &mut y,
            &[
                run(glyph, gfg, Token::Bg),
                run(" ", Token::Fg, Token::Bg),
                bold(n.label.clone(), Token::Fg, Token::Bg),
            ],
        );
        let hop = visible.get(&n.id).copied().unwrap_or(n.hop);
        let mut what = vec![
            n.kind.name().to_owned(),
            if n.in_head { "head" } else { "base" }.to_owned(),
        ];
        if n.id == self.seed {
            what.push("seed".into());
        }
        what.push(format!("hop {hop}"));
        line(c, &mut y, &[run(what.join(" · "), Token::Dim, Token::Bg)]);
        line(c, &mut y, &[]);
        let range = if n.line_end > n.line {
            format!("{}:{}-{}", n.path, n.line, n.line_end)
        } else {
            format!("{}:{}", n.path, n.line)
        };
        let field = |label: &str| run(format!("{label:<7}"), Token::Faint, Token::Bg);
        line(
            c,
            &mut y,
            &[field("path"), run(range, Token::Fg, Token::Bg)],
        );
        let delta = match (n.state, n.in_head, n.in_base) {
            (_, true, false) => run("+ added in head", Token::Pass, Token::Bg),
            (_, false, true) => run("- removed in head", Token::Fail, Token::Bg),
            (NodeState::Changed, _, _) => run(
                format!("~ changed {}", n.delta.clone().unwrap_or_default())
                    .trim_end()
                    .to_owned(),
                Token::Signal,
                Token::Bg,
            ),
            _ => run("unchanged", Token::Dim, Token::Bg),
        };
        line(c, &mut y, &[field("delta"), delta]);
        let inbound: Vec<&&GraphEdge> = edges.iter().filter(|e| e.to == n.id).collect();
        let outbound: Vec<&&GraphEdge> = edges.iter().filter(|e| e.from == n.id).collect();
        line(
            c,
            &mut y,
            &[
                field("edges"),
                run(
                    format!("{} in · {} out", inbound.len(), outbound.len()),
                    Token::Fg,
                    Token::Bg,
                ),
            ],
        );
        let label = |id: &str| {
            self.node(id)
                .map(|n| n.label.clone())
                .unwrap_or_else(|| id.to_owned())
        };
        let edge_row = |arrow: &str, e: &GraphEdge, other: &str| {
            let room = usize::from(right.saturating_sub(x)).saturating_sub(13);
            vec![
                run(arrow.to_owned(), Token::Faint, Token::Bg),
                run(" ", Token::Fg, Token::Bg),
                run(format!("{:<5}", e.kind), Token::Dim, Token::Bg),
                run(
                    format!("  {} ", pad(&label(other), room.saturating_sub(1))),
                    Token::Fg,
                    Token::Bg,
                ),
                if e.probable {
                    run("prob", Token::Warn, Token::Bg)
                } else {
                    run("res", Token::Pass, Token::Bg)
                },
            ]
        };
        if !inbound.is_empty() {
            line(c, &mut y, &[]);
            line(
                c,
                &mut y,
                &[bold(
                    format!("DEPENDENTS · HOP {}", hop + 1),
                    Token::Faint,
                    Token::Bg,
                )],
            );
            for e in &inbound {
                line(c, &mut y, &edge_row("←", e, &e.from));
            }
        }
        if !outbound.is_empty() {
            line(c, &mut y, &[]);
            line(c, &mut y, &[bold("DEPENDS ON", Token::Faint, Token::Bg)]);
            for e in &outbound {
                line(c, &mut y, &edge_row("→", e, &e.to));
            }
        }
        if !n.findings.is_empty() {
            line(c, &mut y, &[]);
            line(c, &mut y, &[bold("FINDINGS", Token::Faint, Token::Bg)]);
            for f in &n.findings {
                if y < limit {
                    let bg = if f.failing {
                        Token::FailTint
                    } else {
                        Token::Raise
                    };
                    c.fill(y, x, right, bg);
                    let fg = if f.failing { Token::Fail } else { Token::Warn };
                    let mark = if f.failing { "FAIL" } else { "" };
                    let mark_x = right.saturating_sub(1 + mark.len() as u16);
                    put_in(
                        c,
                        x,
                        y,
                        mark_x.saturating_sub(1),
                        &[
                            run("▌", fg, bg),
                            run(" ", Token::Fg, bg),
                            run(format!("● {}", id8(&f.id)), fg, bg),
                            run(format!(" {}", f.title), Token::Fg, bg),
                        ],
                    );
                    c.put(mark_x, y, &bold(mark, Token::Fail, bg));
                }
                y += 1;
            }
        }
        // Blast radius of the seed.
        if n.id == self.seed {
            let mut blast: Vec<Vec<Run>> = Vec::new();
            let callers: Vec<&&GraphEdge> = inbound
                .iter()
                .filter(|e| e.kind == "calls")
                .copied()
                .collect();
            let untested: Vec<&GraphNode> = callers
                .iter()
                .filter_map(|e| self.node(&e.from))
                .filter(|n| n.untested)
                .collect();
            for u in &untested {
                let text = format!(
                    "{} has no test path ({} of {} callers)",
                    u.label,
                    untested.len(),
                    callers.len()
                );
                for (i, part) in wrap(&text, 28).into_iter().enumerate() {
                    blast.push(if i == 0 {
                        vec![
                            run("▲", Token::Warn, Token::Bg),
                            run(format!(" {part}"), Token::Fg, Token::Bg),
                        ]
                    } else {
                        vec![
                            run("  ", Token::Fg, Token::Bg),
                            run(part, Token::Dim, Token::Bg),
                        ]
                    });
                }
            }
            let probable: Vec<&GraphEdge> = self
                .visible_edges(&visible)
                .into_iter()
                .filter(|e| e.probable)
                .collect();
            if !probable.is_empty() {
                blast.push(vec![
                    run("?", Token::Warn, Token::Bg),
                    run(
                        format!(
                            " {} probable edge{} (text match)",
                            probable.len(),
                            if probable.len() == 1 { "" } else { "s" }
                        ),
                        Token::Fg,
                        Token::Bg,
                    ),
                ]);
                for e in probable {
                    if let Some(node) = self.node(&e.from) {
                        blast.push(vec![
                            run("  ", Token::Fg, Token::Bg),
                            run(node.path.clone(), Token::Dim, Token::Bg),
                        ]);
                    }
                }
            }
            let tests: Vec<&&GraphEdge> = inbound
                .iter()
                .filter(|e| e.kind == "tests")
                .copied()
                .collect();
            if tests.is_empty() {
                blast.push(vec![
                    run("▲", Token::Warn, Token::Bg),
                    run(" no test covers it", Token::Fg, Token::Bg),
                ]);
            }
            for t in tests {
                blast.push(vec![
                    run("✓", Token::Pass, Token::Bg),
                    run(
                        format!(" {} covers it", label(&t.from)),
                        Token::Fg,
                        Token::Bg,
                    ),
                ]);
            }
            line(c, &mut y, &[]);
            line(c, &mut y, &[bold("BLAST RADIUS", Token::Faint, Token::Bg)]);
            for runs in blast {
                line(c, &mut y, &runs);
            }
        }
        let footer = h.saturating_sub(3);
        let mut fx = x;
        for (i, (k, l)) in [("g", "finding"), ("o", "open"), ("b", "base")]
            .iter()
            .enumerate()
        {
            if i > 0 {
                fx = c.put(fx, footer, &run("  ", Token::Fg, Token::Bg));
            }
            fx = put_in(
                c,
                fx,
                footer,
                right,
                &[
                    bold(*k, Token::Fg, Token::Bg),
                    run(" ", Token::Fg, Token::Bg),
                    run(*l, Token::Faint, Token::Bg),
                ],
            );
        }
    }
}
