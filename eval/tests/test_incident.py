"""Eval case schema (task 2.4) and `import-incident` (task 8.4) with a fake fetcher."""
import contextlib
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cases  # noqa: E402
import evaluate as e  # noqa: E402
import gitdiff  # noqa: E402
import incident  # noqa: E402

SHA = {name: (str(i) * 40)[:40] for i, name in enumerate(['b41', 'h41', 'b57', 'h57', 'b58', 'h58'], 1)}

ORIGINAL_DIFF = """diff --git a/src/billing.py b/src/billing.py
index 1111111..2222222 100644
--- a/src/billing.py
+++ b/src/billing.py
@@ -10,1 +10,2 @@ def total(items):
-    return sum(i.price for i in items)
+    subtotal = sum(i.price for i in items)
+    return subtotal - discount(items)
diff --git a/src/util.ts b/src/util.ts
--- a/src/util.ts
+++ b/src/util.ts
@@ -1 +1 @@
-export const x = 1;
+export const x = 2;
"""

FIX_DIFF = """diff --git a/src/billing.py b/src/billing.py
index 2222222..3333333 100644
--- a/src/billing.py
+++ b/src/billing.py
@@ -13,1 +13,1 @@ def total(items):
---    return subtotal - discount(items)
+    return max(subtotal - discount(items), 0)
@@ -2,0 +3,1 @@
+# header comment
diff --git a/tests/test_billing.py b/tests/test_billing.py
new file mode 100644
--- /dev/null
+++ b/tests/test_billing.py
@@ -0,0 +1,2 @@
+def test_total_never_negative():
+    assert total([]) == 0
"""

UNRELATED_DIFF = """diff --git a/docs/readme.md b/docs/readme.md
--- a/docs/readme.md
+++ b/docs/readme.md
@@ -1 +1 @@
-old
+new
"""

BILLING_AT_FIX_BASE = """import math


def discount(items):
    return 0


class Cart:
    pass

def total(items):
    subtotal = sum(i.price for i in items)
    return subtotal - discount(items)
"""


class FakeFetcher:
    def __init__(self):
        self.calls = []
        self.prs = {
            41: {'number': 41, 'title': 'Apply discounts', 'body': '', 'url': 'https://github.com/acme/shop/pull/41',
                 'base': {'ref': 'main', 'sha': SHA['b41']}, 'head': {'ref': 'discounts', 'sha': SHA['h41']}},
            57: {'number': 57, 'title': 'Clamp totals', 'url': 'https://github.com/acme/shop/pull/57',
                 'body': '<!-- template -->\n## Summary\n\nTotals went negative when the discount exceeded the subtotal.\n\nMore text.',
                 'base': {'ref': 'main', 'sha': SHA['b57']}, 'head': {'ref': 'clamp', 'sha': SHA['h57']}},
            58: {'number': 58, 'title': 'Docs', 'body': '', 'url': 'https://github.com/acme/shop/pull/58',
                 'base': {'ref': 'main', 'sha': SHA['b58']}, 'head': {'ref': 'docs', 'sha': SHA['h58']}},
        }
        self.diffs = {41: ORIGINAL_DIFF, 57: FIX_DIFF, 58: UNRELATED_DIFF}

    def pr(self, number):
        self.calls.append(('pr', number))
        return copy.deepcopy(self.prs[number])

    def diff(self, number):
        self.calls.append(('diff', number))
        return self.diffs[number]

    def file(self, sha, path):
        self.calls.append(('file', sha, path))
        return BILLING_AT_FIX_BASE if (sha, path) == (SHA['b57'], 'src/billing.py') else None


class DiffParsing(unittest.TestCase):
    def test_hunk_bodies_starting_with_dashes_are_not_headers(self):
        files = gitdiff.parse(FIX_DIFF)
        self.assertEqual([(f['old'], f['new']) for f in files],
                         [('src/billing.py', 'src/billing.py'), (None, 'tests/test_billing.py')])
        self.assertEqual(files[0]['hunks'], [(13, 1, 13, 1), (2, 0, 3, 1)])


class ImportIncident(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)

    def run_main(self, *argv, fetcher=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = incident.main([*argv, '--repo', str(self.repo)], fetcher=fetcher or FakeFetcher(),
                                 stdin_isatty=False)
        return code, out.getvalue(), err.getvalue()

    def test_counterfactual_and_enclosing_symbols(self):
        code, out, _ = self.run_main('41', '57', '--caught-by', 'none')
        self.assertEqual(code, 0, out)
        path = self.repo / 'eval/cases/incident-41-57.json'
        case = e.read_json(path)
        cases.validate_case(case)
        e.validate(case, e.ROOT / 'schemas/eval-case-v1.json')
        self.assertEqual(case['label'], 'incident')
        self.assertEqual(case['counterfactual_catch'], 'none')
        self.assertEqual(case['repository'], 'acme/shop')
        self.assertEqual(case['input']['base']['sha'], SHA['b41'])
        self.assertEqual(case['input']['head']['sha'], SHA['h41'])
        self.assertEqual(case['provenance']['overlap'], ['src/billing.py'])
        expected = case['expected'][0]
        # Hunk at old line 13 sits inside `def total`; the insertion after line 2
        # precedes every declaration and is file-level. Test files outside the
        # overlap do not become expectations.
        self.assertEqual(expected['locations'], [
            {'path': 'src/billing.py', 'line_start': 2, 'line_end': 2, 'symbol_path': '', 'symbol_line': None},
            {'path': 'src/billing.py', 'line_start': 13, 'line_end': 13, 'symbol_path': 'total', 'symbol_line': 11}])
        self.assertEqual(expected['trigger'], 'Totals went negative when the discount exceeded the subtotal.')
        self.assertEqual(expected['trigger_source'], 'fix-pr-description')

    def test_caught_by_values_are_recorded(self):
        for caught in ('ci', 'human'):
            code, _, _ = self.run_main('41', '57', '--caught-by', caught, '--force')
            self.assertEqual(code, 0)
            self.assertEqual(e.read_json(self.repo / 'eval/cases/incident-41-57.json')['counterfactual_catch'], caught)

    def test_empty_overlap_is_refused_with_report_and_nothing_written(self):
        code, _, err = self.run_main('41', '58', '--caught-by', 'human')
        self.assertEqual(code, 1)
        self.assertIn('PR 58 changes no file changed by PR 41 (overlap: none)', err)
        self.assertIn('src/billing.py, src/util.ts', err)
        self.assertIn('docs/readme.md', err)
        self.assertFalse((self.repo / 'eval').exists())

    def test_caught_by_required_without_a_terminal(self):
        with self.assertRaises(SystemExit) as raised, contextlib.redirect_stderr(io.StringIO()):
            incident.main(['41', '57', '--repo', str(self.repo)], fetcher=FakeFetcher(), stdin_isatty=False)
        self.assertEqual(raised.exception.code, 2)

    def test_existing_case_is_not_overwritten_and_trigger_is_editable(self):
        self.assertEqual(self.run_main('41', '57', '--caught-by', 'none')[0], 0)
        self.assertEqual(self.run_main('41', '57', '--caught-by', 'ci')[0], 1)
        code, _, _ = self.run_main('41', '57', '--caught-by', 'ci', '--force', '--trigger', 'discount > subtotal')
        self.assertEqual(code, 0)
        case = e.read_json(self.repo / 'eval/cases/incident-41-57.json')
        self.assertEqual(case['expected'][0]['trigger'], 'discount > subtotal')
        self.assertEqual(case['expected'][0]['trigger_source'], 'manual')

    def test_enclosing_symbol_heuristic(self):
        text = 'class A:\n    def m(self):\n        x = 1\n\nexport async function f() {\n  y()\n}\npub(crate) fn g() {}\n'
        self.assertEqual(incident.enclosing_symbol(text, 3), ('m', 2))
        self.assertEqual(incident.enclosing_symbol(text, 1), ('A', 1))
        self.assertEqual(incident.enclosing_symbol(text, 6), ('f', 5))
        self.assertEqual(incident.enclosing_symbol(text, 8), ('g', 8))
        self.assertEqual(incident.enclosing_symbol('x = 1\n', 1), (None, None))
        self.assertEqual(incident.enclosing_symbol(None, 1), (None, None))


class CaseSchema(unittest.TestCase):
    def case(self):
        fetcher = FakeFetcher()
        return incident.build_case(41, 57, 'human', fetcher, '.')

    def test_incident_requires_counterfactual_and_overlap(self):
        case = self.case()
        del case['counterfactual_catch']
        with self.assertRaisesRegex(ValueError, 'counterfactual_catch'):
            cases.validate_case(case)
        case = self.case()
        case['counterfactual_catch'] = 'maybe'
        with self.assertRaisesRegex(ValueError, 'invalid enum'):
            cases.validate_case(case)
        case = self.case()
        case['provenance']['overlap'] = []
        with self.assertRaisesRegex(ValueError, 'too few items'):
            cases.validate_case(case)

    def test_rejects_bad_refs_locations_and_placeholders(self):
        case = self.case()
        case['input']['head']['sha'] = 'main'
        with self.assertRaisesRegex(ValueError, 'pattern'):
            cases.validate_case(case)
        case = self.case()
        case['expected'][0]['locations'][0]['line_end'] = 1
        case['expected'][0]['locations'][0]['line_start'] = 5
        with self.assertRaisesRegex(ValueError, 'line_end precedes'):
            cases.validate_case(case)
        case = self.case()
        case['expected'][0]['trigger'] = 'TODO'
        with self.assertRaisesRegex(ValueError, 'TODO'):
            cases.validate_case(case)
        case = self.case()
        case['expected'][0]['locations'][0]['path'] = '../escape.py'
        with self.assertRaisesRegex(ValueError, 'pattern'):
            cases.validate_case(case)

    def test_historical_case_needs_no_counterfactual_and_cli_validates(self):
        case = self.case()
        case.update(id='hist-1', label='historical')
        del case['counterfactual_catch']
        case['provenance'] = {'source': 'manual', 'created_at': '2026-11-06T00:00:00Z', 'tool': 'hand'}
        cases.validate_case(case)
        case['provenance']['created_at'] = 'yesterday'
        with self.assertRaisesRegex(ValueError, 'date-time'):
            cases.validate_case(case)
        with tempfile.TemporaryDirectory() as tmp:
            e.write_json(Path(tmp) / 'a.json', self.case())
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(cases.main(['validate', tmp]), 0)
            self.assertIn('incident incident-41-57', out.getvalue())

    def test_matching_reports_against_expected_locations(self):
        case = self.case()
        finding = e.read_json(e.ROOT / 'crates/rio-core/tests/fixtures/finding.json')
        finding['location'].update(path='src/billing.py', line_start=40, line_end=40, symbol_path='billing.total')
        finding['locations'] = [copy.deepcopy(finding['location'])]
        self.assertEqual(cases.caught(case, {'findings': [finding], 'risks': []}), [[finding['id']]])
        finding['location']['symbol_path'] = 'billing.other'
        finding['locations'] = [copy.deepcopy(finding['location'])]
        self.assertEqual(cases.caught(case, {'findings': [finding], 'risks': []}), [[finding['id']]],
                         'file-level expectation at line 2 matches any location in the file')
        case['expected'][0]['locations'] = [x for x in case['expected'][0]['locations'] if x['symbol_path']]
        self.assertEqual(cases.caught(case, {'findings': [finding], 'risks': []}), [[]])


if __name__ == '__main__':
    unittest.main()
