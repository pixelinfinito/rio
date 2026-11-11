import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("aacr_bench", Path(__file__).parents[1] / "aacr_bench.py")
aacr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(aacr)


class AACRAdapterTests(unittest.TestCase):
    def test_resume_rejects_changed_inherited_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset = root / "dataset.jsonl"
            dataset.write_text(json.dumps({"instance_id": "owner/repo@head", "repo": "owner/repo",
                "base_commit": "a" * 40, "head_commit": "b" * 40,
                "reference_comments": []}), encoding="utf-8")
            binary = root / "rio"
            binary.write_bytes(b"test binary")
            args = argparse.Namespace(out=root / "out", dataset=dataset, rio=binary,
                aacr=root, profile="test", config_dir=root, temp_root=root / "temp",
                instance=None, limit=None, concurrency=1, timeout=1, resume=False)
            resolved = b"original inherited settings\n"
            def check_output(argv, **kwargs):
                if argv[0] == "git":
                    return b"upstream\n"
                if "--version" in argv:
                    return b"rio test\n"
                return b"raw profile\n" if "--raw" in argv else resolved
            with patch.object(aacr.subprocess, "check_output", side_effect=check_output), \
                    patch.object(aacr, "review_group"):
                aacr.run(args)
                args.resume = True
                aacr.run(args)
                before = (args.out / "manifest.json").read_bytes()
                resolved = b"changed inherited settings\n"
                with self.assertRaisesRegex(SystemExit, "inherited configuration changed"):
                    aacr.run(args)
                self.assertEqual((args.out / "manifest.json").read_bytes(), before)

    def test_scoring_reuses_successes_but_retries_judge_failures(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset = root / "dataset.jsonl"
            dataset.write_text("{}\n", encoding="utf-8")
            args = argparse.Namespace(out=root, dataset=dataset, aacr=root)
            aacr.write_json(root / "manifest.json", {
                "dataset_sha256": aacr.sha256(dataset), "aacr_commit": "upstream",
                "instances": ["owner/repo@head"]})
            calls = []
            answer = {"matched": [1], "reason": "Same issue\n[1]"}
            async def match(*params):
                calls.append(params)
                return answer.copy()
            judge = SimpleNamespace(USE_MOCK_LLM=False, match_llm_file_level=match)
            async def evaluate(*unused):
                judged = await judge.match_llm_file_level("generated", "1", ["reference"], ["1"], "a.py")
                return {"summary": {"missing_instances": 0}, "eval_res": [{
                    "generated_comments": [{"judge_reason": judged["reason"]}]}]}
            modules = {"schema": SimpleNamespace(load_instances=lambda path: [
                SimpleNamespace(instance_id="owner/repo@head")]), "judge": judge,
                "evaluate": SimpleNamespace(evaluate=evaluate, print_summary=lambda *args: None)}
            with patch.dict(sys.modules, modules), patch.object(sys, "path", sys.path.copy()), \
                    patch.dict(os.environ, {"JUDGE_API_KEY": "test-key", "JUDGE_MODEL": "test-model",
                                            "JUDGE_BASE_URL": "https://judge.example", "JUDGE_USE_MOCK": "false"}), \
                    patch.object(aacr.subprocess, "check_output", return_value=b"upstream\n"):
                for _ in range(2):
                    judge.match_llm_file_level = match
                    aacr.evaluate(args)
                self.assertEqual(len(calls), 1)
                self.assertTrue(json.loads((root / "metrics.json").read_text())["provenance"]["valid"])
                for entry in (root / "judge-cache").glob("*.json"):
                    entry.unlink()
                answer.update(matched=[], reason="评估过程出错: provider unavailable")
                for _ in range(2):
                    judge.match_llm_file_level = match
                    with self.assertRaisesRegex(SystemExit, "scores are invalid"):
                        aacr.evaluate(args)
                self.assertEqual(len(calls), 3)
                self.assertFalse(list((root / "judge-cache").glob("*.json")))
                self.assertFalse(json.loads((root / "metrics.json").read_text())["provenance"]["valid"])

    def test_dataset_rejects_unsafe_identities_and_collisions(self):
        instance = {"instance_id": "owner/repo@head", "repo": "owner/repo",
                    "base_commit": "a" * 40, "head_commit": "b" * 40,
                    "reference_comments": []}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "dataset.jsonl"
            path.write_text(json.dumps(instance), encoding="utf-8")
            self.assertEqual(aacr.load_dataset(path), [instance])
            for change in [{"instance_id": "bad\\id"}, {"instance_id": ".."},
                           {"repo": "bad"}, {"base_commit": "--option"},
                           {"reference_comments": None}]:
                with self.subTest(change=change):
                    path.write_text(json.dumps(dict(instance, **change)), encoding="utf-8")
                    with self.assertRaises(ValueError):
                        aacr.load_dataset(path)
            path.write_text("\n".join(map(json.dumps, [instance, dict(
                instance, instance_id="owner__repo@head")])), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate evidence filename"):
                aacr.load_dataset(path)

    def test_comments_include_risks_but_exclude_hidden_states_and_dedupe(self):
        finding = {"id": "a", "state": "new", "evidence_level": "static_proven",
                   "location": {"path": "src/a.py", "line_start": 3, "line_end": 4},
                   "message": "Problem", "impact": "Crash", "suggested_fix": "Guard it"}
        report = {"findings": [finding], "risks": [copy.deepcopy(finding)]}
        for i, state in enumerate(["pre-existing", "fixed"]):
            report["findings"].append(dict(finding, id=str(i), state=state))
        report["risks"].append(dict(finding, id="risk", evidence_level="plausible"))
        report["risks"].append(dict(finding, id="refuted", evidence_level="refuted"))
        comments = aacr.comments_from_report(report)
        self.assertEqual([x["rio_finding_id"] for x in comments], ["a", "risk"])
        self.assertEqual(comments[0]["content"], "Problem\nCrash\nGuard it")
        self.assertEqual((comments[0]["start_line"], comments[0]["end_line"]), (3, 4))

    def run_review(self, root, report, *, exit_code=0, timed_out=False):
        args = argparse.Namespace(config_dir=root / "config", temp_root=root,
                                  out=root / "out", rio=root / "rio", timeout=1)
        instance = {"instance_id": "owner__repo@head", "base_commit": "base",
                    "head_commit": "head", "repo": "owner/repo"}
        def execute(argv, *unused, **kwargs):
            if hasattr(self, "check_environment"):
                self.check_environment(kwargs["env"])
            if argv[0] == "git":
                return {"exit_code": 0, "timed_out": False}, "tree", ""
            return {"exit_code": exit_code, "timed_out": timed_out,
                    "duration_seconds": 1}, json.dumps(report), ""
        with patch.object(aacr, "execute", side_effect=execute):
            aacr.review_group("owner/repo", [instance], args)
        return args.out

    def test_review_preserves_endpoint_auth_and_isolates_judge_overrides(self):
        def check_environment(env):
            self.assertEqual(env["RIO_API_TOKEN"], "test-token")
            self.assertEqual(env["RIO_ENDPOINT_URL"], "https://endpoint.example")
            self.assertNotIn("RIO_MODEL", env)
            self.assertNotIn("JUDGE_API_KEY", env)
            self.assertEqual(env["RIO_TUI"], "0")
        self.check_environment = check_environment
        with patch.dict(os.environ, {"RIO_API_TOKEN": "test-token",
                                     "RIO_ENDPOINT_URL": "https://endpoint.example",
                                     "RIO_MODEL": "override", "JUDGE_API_KEY": "test-key"}):
            with tempfile.TemporaryDirectory() as tmp:
                out = self.run_review(Path(tmp), {"status": "complete", "review": {
                    "base": "base", "head": "snapshot:hash", "mode": "staged"}})
                self.assertTrue((out / "results/owner__repo@head.json").exists())

    def test_diverged_commits_review_exact_target_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            source.mkdir()
            def git(*argv, cwd=source):
                return subprocess.check_output(["git", *argv], cwd=cwd,
                                               stderr=subprocess.PIPE, text=True).strip()
            git("init", "--quiet")
            git("config", "user.name", "Adapter test")
            git("config", "user.email", "adapter@example.invalid")
            git("config", "commit.gpgsign", "false")
            (source / "file.txt").write_text("common\n", encoding="utf-8")
            git("add", ".")
            git("commit", "--quiet", "-m", "common")
            common = git("rev-parse", "HEAD")
            (source / "file.txt").write_text("target\n", encoding="utf-8")
            git("commit", "--quiet", "-am", "target")
            head = git("rev-parse", "HEAD")
            git("checkout", "--quiet", "--detach", common)
            (source / "base-only.txt").write_text("base\n", encoding="utf-8")
            git("add", ".")
            git("commit", "--quiet", "-m", "diverged base")
            base = git("rev-parse", "HEAD")
            instance = {"instance_id": "owner__repo@target", "repo": "owner/repo",
                        "clone_url": str(source), "base_commit": base, "head_commit": head}
            args = argparse.Namespace(config_dir=root / "config", temp_root=root,
                                      out=root / "out", rio=root / "rio", timeout=1)
            execute = aacr.execute
            observed = {}
            def fake_review(argv, cwd, *rest, **kwargs):
                if argv[0] == "git":
                    return execute(argv, cwd, *rest, **kwargs)
                observed.update(base=git("rev-parse", "HEAD", cwd=cwd),
                                tree=git("write-tree", cwd=cwd), argv=argv)
                return {"exit_code": 0, "timed_out": False, "duration_seconds": 1}, json.dumps({
                    "status": "complete", "review": {"base": base,
                    "head": "snapshot:hash", "mode": "staged"}}), ""
            with patch.object(aacr, "execute", side_effect=fake_review):
                aacr.review_group("owner/repo", [instance], args)
            self.assertEqual(observed["base"], base)
            self.assertEqual(observed["tree"], git("rev-parse", f"{head}^{{tree}}"))
            self.assertIn(str(args.out / "profile.yaml"), observed["argv"])
            self.assertTrue((args.out / "results/owner__repo@target.json").exists())

    def test_empty_completed_review_is_scored(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = self.run_review(Path(tmp), {"status": "complete", "review": {
                "base": "base", "head": "snapshot:hash", "mode": "staged"}})
            result = json.loads((out / "results/owner__repo@head.json").read_text())
            self.assertEqual(result["review"]["comments"], [])

    def test_failed_or_wrong_diff_reviews_are_not_empty_successes(self):
        for exit_code, timed_out, base in [(3, False, "base"), (0, True, "base"), (0, False, "wrong")]:
            with self.subTest(exit_code=exit_code, timed_out=timed_out, base=base):
                with tempfile.TemporaryDirectory() as tmp:
                    out = self.run_review(Path(tmp), {"status": "complete", "review": {
                        "base": base, "head": "snapshot:hash", "mode": "staged"}},
                        exit_code=exit_code, timed_out=timed_out)
                    self.assertFalse((out / "results/owner__repo@head.json").exists())
                    status = json.loads((out / "cases/owner__repo@head/status.json").read_text())
                    self.assertEqual(status["status"], "failed")


if __name__ == "__main__":
    unittest.main()
