# Maintain and publish the documentation

The main Rio repository owns these pages; the Wiki is generated output. Home uses the authored English `start.md`; its Portuguese counterpart is `pt-BR/start.md`. Both go through the same translation and asset checks. Sidebar labels and destinations live in the manifest. Update both languages and the compact English agent topic when behavior changes. Never edit generated command/schema tables by hand.

## Local workflow

1. Edit `docs/wiki/en/TOPIC.md`, `docs/wiki/pt-BR/TOPIC.md` and `docs/agent/TOPIC.md` as applicable. Keep commands/keys unchanged across translations.
2. Update `docs/documentation-manifest.json`: source paths, coverage, related topics, screenshots and availability. Public command options need entries in `docs/argument-descriptions.json` in both languages. Use `COMMAND ARGUMENT_ID` keys when a flag has different meanings in different commands.
3. Install development tools: `python3 -m venv .venv`; `.venv/bin/pip install -r scripts/requirements-docs.txt`. These are never runtime dependencies of Rio.
4. Export parser facts: `RIO_DOCS_INVENTORY="$PWD/docs/command-inventory.json" cargo test -p rio-cli --bin rio docs_inventory::export_documentation_inventory -- --ignored`.
5. Run `.venv/bin/python scripts/documentation_schemas.py`, then `python3 scripts/documentation.py generate`.
6. Review meaning and examples in both languages. Explicitly record review with `python3 scripts/documentation.py review TOPIC_ID` for the affected pairs. This is a review attestation, not an automatic translation tool.
7. Run documentation tests/checks and rebuild the binary before measuring its embedded output.

```sh
python3 scripts/documentation.py check
.venv/bin/python -m unittest discover -s tests/documentation -v
cargo test -p rio-cli --test docs
cargo build -p rio-cli --locked
.venv/bin/python scripts/documentation.py budgets
```

Guides require outcome, prerequisites, steps, expected results, troubleshooting and next steps. Use ordinary words and explain terms. Generated schema reference pages are deliberately concise. [Glossary](glossary.md) fixes shared terminology; preserve the distinction between incomplete, unverified and failed.

## Screenshots

Run `.venv/bin/python scripts/capture-documentation.py` on Linux with Cargo, the built binary and the documented DejaVu Sans Mono font (override `--font` if necessary). The harness captures current CLI output and actual TUI fixture buffers, not old mockups. Keep PNGs, transcripts and `captures.json` together. Review legibility and sanitation, then update translated captions and source-review records. TUI fixtures are demo data, including displayed fixture versions; no live provider execution is implied. A long-output image is a viewport excerpt with a full transcript link.

## Publish

Render a fresh empty staging directory: `python3 scripts/documentation.py render /tmp/rio-wiki-stage`. Inspect the generated links/assets, then publish with `python3 scripts/publish-wiki.py /tmp/rio-wiki-stage --remote https://github.com/pixelinfinito/rio.wiki.git` using an existing Git credential helper. First publication can explicitly adopt an inspected placeholder Home with `--adopt Home.md`.

GitHub must have Wiki enabled and an initial page saved. Use repository-scoped Wiki write credentials; do not assume the standard Actions token works. The manually dispatched publishing workflow uses a dedicated secret. Missing initialization/access stops publication and preserves staging. The publisher preserves unrelated pages, rejects unexpected edits to owned files, checks concurrent changes, and never force-pushes. Unchanged publication is a no-op.

After publishing, verify Home, both language indexes, sidebar, switches, anchors and image URLs. Record source and Wiki commits. Roll back by reverting the publication commit in a Wiki clone and pushing normally, or render/publish a previous reviewed source revision. Do not overwrite another maintainer's intervening edits.

[Return to Reference](reference.md).

[Authoring templates](../../templates/guide-en.md): paired guides/references and compact agent template live in `docs/templates/`. Configure `RIO_WIKI_TOKEN` for the manual **Publish Wiki** workflow; publish a pushed, reviewed source commit. Release checks run embedded-doc smoke tests from installed artifacts.
