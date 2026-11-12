import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("aacr_bench", Path(__file__).parents[1] / "aacr_bench.py")
aacr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(aacr)


class AACRAdapterTests(unittest.TestCase):
    def test_execute_propagates_interrupt_after_stopping_child(self):
        """An interrupted command exits its child group and remains resumable."""
        proc = Mock(pid=12345, returncode=-signal.SIGINT)
        proc.wait.side_effect = [KeyboardInterrupt, 0]
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(aacr.subprocess, "Popen", return_value=proc), \
                patch.object(aacr.os, "killpg") as killpg:
            with self.assertRaises(KeyboardInterrupt):
                aacr.execute(["tool"], Path(tmp), Path(tmp), "review")
            killpg.assert_called_once_with(proc.pid, signal.SIGINT)
            self.assertEqual(proc.wait.call_count, 2)
            self.assertFalse((Path(tmp) / "review.command.json").exists())

    def test_execute_timeout_still_records_failure_and_escalates(self):
        """Timeouts stay terminal failures and kill a child that ignores SIGINT."""
        proc = Mock(pid=12345, returncode=-signal.SIGKILL)
        proc.wait.side_effect = [subprocess.TimeoutExpired("tool", 30), 0]
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(aacr.subprocess, "Popen", return_value=proc), \
                patch.object(aacr.os, "killpg") as killpg:
            record, _, _ = aacr.execute(["tool"], Path(tmp), Path(tmp), "review", timeout=0)
            self.assertTrue(record["timed_out"])
            self.assertEqual([call.args[1] for call in killpg.call_args_list],
                             [signal.SIGINT, signal.SIGKILL])

    def test_interrupted_review_does_not_persist_terminal_status(self):
        """Resume must retry a case interrupted before it produces a usable report."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaises(KeyboardInterrupt):
                self.run_review(root, {}, interrupt=True)
            self.assertFalse((root / "out/cases/owner__repo@head/status.json").exists())
            self.assertFalse((root / "out/results/owner__repo@head.json").exists())

    @patch.dict(os.environ, dict.fromkeys(aacr.GIT_LOCATION_VARIABLES, "/invalid-inherited-git-location"))
    def test_resume_rejects_changed_inherited_profile(self):
        """Resume verifies inherited settings and uses a fresh private binary copy."""
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
            binaries = []
            def review_group(repo, rows, worker_args, stop_event):
                """Assert each worker uses a verified executable in a private directory."""
                binaries.append(worker_args.rio)
                self.assertEqual(worker_args.rio.parent.stat().st_mode & 0o777, 0o700)
                self.assertEqual(worker_args.rio.read_bytes(), b"test binary")
            def check_output(argv, **kwargs):
                """Supply pinned CLI metadata without invoking a model or endpoint."""
                if argv[0] == "git":
                    self.assertTrue(aacr.GIT_LOCATION_VARIABLES.isdisjoint(kwargs["env"]))
                    return b"upstream\n"
                if "--version" in argv:
                    return b"rio test\n"
                return b"raw profile\n" if "--raw" in argv else resolved
            with patch.object(aacr.subprocess, "check_output", side_effect=check_output), \
                    patch.object(aacr, "review_group", side_effect=review_group):
                aacr.run(args)
                args.resume = True
                aacr.run(args)
                before = (args.out / "manifest.json").read_bytes()
                resolved = b"changed inherited settings\n"
                with self.assertRaisesRegex(SystemExit, "inherited configuration changed"):
                    aacr.run(args)
                self.assertEqual((args.out / "manifest.json").read_bytes(), before)
                self.assertEqual(len(binaries), 2)
                self.assertNotEqual(binaries[0], binaries[1])
                self.assertTrue(all(not path.exists() for path in binaries))
                self.assertEqual(args.rio, binary)

    def test_coordinator_interrupt_cancels_active_workers_before_cleanup(self):
        """A main-thread interrupt signals workers before waiting for their shutdown."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset = root / "dataset.jsonl"
            dataset.write_text(json.dumps({"instance_id": "owner/repo@head", "repo": "owner/repo",
                "base_commit": "a" * 40, "head_commit": "b" * 40,
                "reference_comments": []}), encoding="utf-8")
            binary = root / "rio"
            binary.write_bytes(b"test binary")
            args = argparse.Namespace(out=root / "out", dataset=dataset, rio=binary,
                aacr=root, profile="test", config_dir=root, temp_root=root,
                instance=None, limit=None, concurrency=1, timeout=1, resume=False)
            started, stopped = threading.Event(), threading.Event()
            binaries = []
            def worker(repo, rows, worker_args, stop_event):
                """Wait for coordinator cancellation while retaining executable ownership."""
                binaries.append(worker_args.rio)
                started.set()
                if not stop_event.wait(5):
                    return
                if worker_args.rio.exists():
                    stopped.set()
            def interrupt(futures):
                """Raise in the coordinator after its worker has started."""
                self.assertTrue(started.wait(5))
                raise KeyboardInterrupt
            with patch.object(aacr.subprocess, "check_output", return_value=b"metadata"), \
                    patch.object(aacr, "review_group", side_effect=worker), \
                    patch.object(aacr.concurrent.futures, "as_completed", side_effect=interrupt):
                with self.assertRaises(KeyboardInterrupt):
                    aacr.run(args)
            self.assertTrue(stopped.is_set())
            self.assertFalse(binaries[0].exists())
            self.assertFalse((args.out / "run-summary.json").exists())

    def test_scoring_reuses_successes_but_retries_judge_failures(self):
        """Cache successful Unicode answers, but invalidate and retry provider errors."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset = root / "dataset.jsonl"
            dataset.write_text("{}\n", encoding="utf-8")
            args = argparse.Namespace(out=root, dataset=dataset, aacr=root)
            aacr.write_json(root / "manifest.json", {
                "dataset_sha256": aacr.sha256(dataset), "aacr_commit": "upstream",
                "instances": ["owner/repo@head"]})
            calls = []
            answer = {"matched": [1], "reason": "同一问题\n[1]"}
            async def match(*params):
                """Track paid-call equivalents while returning the selected test answer."""
                calls.append(params)
                return answer.copy()
            judge = SimpleNamespace(USE_MOCK_LLM=False, match_llm_file_level=match)
            async def evaluate(*unused):
                """Emulate upstream's propagation of a file-level judgment to metrics."""
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
                self.assertTrue(json.loads((root / "metrics.json").read_text(encoding="utf-8"))["provenance"]["valid"])
                for entry in (root / "judge-cache").glob("*.json"):
                    entry.unlink()
                answer.update(matched=[], reason="评估过程出错: provider unavailable")
                for _ in range(2):
                    judge.match_llm_file_level = match
                    with self.assertRaisesRegex(SystemExit, "scores are invalid"):
                        aacr.evaluate(args)
                self.assertEqual(len(calls), 3)
                self.assertFalse(list((root / "judge-cache").glob("*.json")))
                self.assertFalse(json.loads((root / "metrics.json").read_text(encoding="utf-8"))["provenance"]["valid"])

    def test_dataset_rejects_unsafe_identities_and_collisions(self):
        """Validate identities before using dataset fields as evidence filenames."""
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
        """Keep publishable risks and findings once per identity, with their locations."""
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

    def run_review(self, root, report, *, exit_code=0, timed_out=False, interrupt=False, stdout=None):
        """Run one isolated case using a fake Git and review subprocess boundary."""
        args = argparse.Namespace(config_dir=root / "config", temp_root=root,
                                  out=root / "out", rio=root / "rio", timeout=1)
        instance = {"instance_id": "owner__repo@head", "base_commit": "base",
                    "head_commit": "head", "repo": "owner/repo"}
        def execute(argv, *unused, **kwargs):
            """Return deterministic tree and report data, or emulate user cancellation."""
            if hasattr(self, "check_environment"):
                self.check_environment(kwargs["env"])
            if argv[0] == "git":
                return {"exit_code": 0, "timed_out": False}, "tree", ""
            if interrupt:
                raise KeyboardInterrupt
            return {"exit_code": exit_code, "timed_out": timed_out,
                    "duration_seconds": 1}, json.dumps(report) if stdout is None else stdout, ""
        with patch.object(aacr, "execute", side_effect=execute):
            aacr.review_group("owner/repo", [instance], args)
        return args.out

    def test_review_preserves_endpoint_auth_and_isolates_judge_overrides(self):
        """Retain endpoint credentials while removing review and Git location overrides."""
        def check_environment(env):
            """Check the environment shared by Git and Rio child processes."""
            self.assertEqual(env["RIO_API_TOKEN"], "test-token")
            self.assertEqual(env["RIO_ENDPOINT_URL"], "https://endpoint.example")
            self.assertNotIn("RIO_MODEL", env)
            self.assertNotIn("JUDGE_API_KEY", env)
            self.assertEqual(env["RIO_TUI"], "0")
            self.assertTrue(aacr.GIT_LOCATION_VARIABLES.isdisjoint(env))
        self.check_environment = check_environment
        with patch.dict(os.environ, {"RIO_API_TOKEN": "test-token",
                                     "RIO_ENDPOINT_URL": "https://endpoint.example",
                                     "RIO_MODEL": "override", "JUDGE_API_KEY": "test-key",
                                     **dict.fromkeys(aacr.GIT_LOCATION_VARIABLES, "unrelated-repo")}):
            with tempfile.TemporaryDirectory() as tmp:
                out = self.run_review(Path(tmp), {"status": "complete", "review": {
                    "base": "base", "head": "snapshot:hash", "mode": "staged"}})
                self.assertTrue((out / "results/owner__repo@head.json").exists())

    @patch.dict(os.environ, dict.fromkeys(aacr.GIT_LOCATION_VARIABLES, "/invalid-inherited-git-location"))
    def test_diverged_commits_review_exact_target_tree(self):
        """Stage the exact target even with divergent history and inherited Git overrides."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            source.mkdir()
            def git(*argv, cwd=source):
                """Run fixture Git operations against their explicit temporary cwd."""
                return subprocess.check_output(["git", *argv], cwd=cwd,
                                               stderr=subprocess.PIPE, text=True,
                                               env=aacr.git_environment()).strip()
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
                """Use real Git commands but inspect the staged tree instead of calling Rio."""
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
        """A successful empty review must still count in evaluator denominators."""
        with tempfile.TemporaryDirectory() as tmp:
            out = self.run_review(Path(tmp), {"status": "complete", "review": {
                "base": "base", "head": "snapshot:hash", "mode": "staged"}})
            result = json.loads((out / "results/owner__repo@head.json").read_text(encoding="utf-8"))
            self.assertEqual(result["review"]["comments"], [])

    def test_failed_or_wrong_diff_reviews_are_not_empty_successes(self):
        """Timeouts, invocation failures and wrong snapshots cannot become clean reviews."""
        for exit_code, timed_out, base in [(3, False, "base"), (0, True, "base"), (0, False, "wrong")]:
            with self.subTest(exit_code=exit_code, timed_out=timed_out, base=base):
                with tempfile.TemporaryDirectory() as tmp:
                    out = self.run_review(Path(tmp), {"status": "complete", "review": {
                        "base": base, "head": "snapshot:hash", "mode": "staged"}},
                        exit_code=exit_code, timed_out=timed_out)
                    self.assertFalse((out / "results/owner__repo@head.json").exists())
                    status = json.loads((out / "cases/owner__repo@head/status.json").read_text(encoding="utf-8"))
                    self.assertEqual(status["status"], "failed")

    def test_error_envelopes_keep_rios_error_and_are_not_wrong_commits(self):
        """An error envelope has no review identity; the case fails with Rio's own
        error and its cause, as in aacr-bench-rerun-20261111T181340Z."""
        envelope = lambda message: {"status": "error", "review": {"rio_version": "0.3.0"},
                                    "error": {"code": "internal_error", "details": [], "message": message}}
        cases = [
            ("endpoint review cancelled; partial evidence is retained at review 85aa6905", "deadline"),
            ("endpoint review cancelled: no report within the 1740 s the client waits; "
             "partial evidence is retained at review 85aa6905", "deadline"),
            ("endpoint review did not complete: 85aa6905: Too many API requests by single Worker invocation.",
             "subrequest_limit"),
            ("profile is invalid", None),
        ]
        for message, cause in cases:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as tmp:
                out = self.run_review(Path(tmp), envelope(message), exit_code=3)
                self.assertFalse((out / "results/owner__repo@head.json").exists())
                status = json.loads((out / "cases/owner__repo@head/status.json").read_text(encoding="utf-8"))
                self.assertEqual(status["status"], "failed")
                self.assertEqual(status["error"], f"Rio reported an error (internal_error): {message}")
                self.assertEqual(status["infra_failure"], cause)
                self.assertEqual(status["infra_failures"], [cause] if cause else [])

    def test_usable_reports_still_need_the_exact_identity(self):
        """Only an error envelope is excused from the identity check."""
        for review in [{"rio_version": "0.3.0"}, {"base": "wrong", "head": "snapshot:hash", "mode": "staged"},
                       {"base": "base", "head": "head", "mode": "staged"},
                       {"base": "base", "head": "snapshot:hash", "mode": "base"}]:
            for state in ["complete", "partial", "incomplete"]:
                with self.subTest(review=review, state=state), tempfile.TemporaryDirectory() as tmp:
                    out = self.run_review(Path(tmp), {"status": state, "review": review,
                                                      "footer": {"notes": ["Worker exceeded memory limit."]}},
                                          exit_code=4 if state != "complete" else 0)
                    self.assertFalse((out / "results/owner__repo@head.json").exists())
                    status = json.loads((out / "cases/owner__repo@head/status.json").read_text(encoding="utf-8"))
                    self.assertEqual((status["status"], status["error"]),
                                     ("failed", "Report commit pins differ from dataset"))

    def test_an_adapter_timeout_and_a_missing_report_say_so(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = self.run_review(Path(tmp), {}, timed_out=True, exit_code=None)
            status = json.loads((out / "cases/owner__repo@head/status.json").read_text(encoding="utf-8"))
            self.assertEqual((status["error"], status["infra_failure"]),
                             ("Review exceeded the adapter's 1 s limit", "deadline"))
        with tempfile.TemporaryDirectory() as tmp:
            out = self.run_review(Path(tmp), None, exit_code=101, stdout="thread 'main' panicked")
            status = json.loads((out / "cases/owner__repo@head/status.json").read_text(encoding="utf-8"))
            self.assertEqual((status["error"], status["infra_failure"]),
                             ("Review printed no report (exit code 101)", None))

    def test_infra_failures_are_classified_from_notes_and_errors(self):
        """Platform causes seen in aacr-bench-final-20261111 and the rerun map to stable labels."""
        notes = lambda *n: {"footer": {"notes": list(n)}}
        cases = [
            (notes("Impact graph truncated at max_nodes", "Worker exceeded CPU time limit."), "cpu_limit"),
            (notes("WorkflowTimeoutError: Execution timed out after 240000ms"), "job_timeout"),
            # A recovered retry is not a cause; the later timeout is.
            (notes("graph: runner attempt 1 failed (runner backend: Network connection lost.); retried",
                   "WorkflowTimeoutError: Execution timed out after 240000ms"), "job_timeout"),
            (notes("checks: runner attempt 1 failed (runner backend: sandbox executor failed: ); retried"), None),
            (notes("graph: runner analysis failed (timed out); the review uses the submitted graph"), "job_timeout"),
            (notes("checks: runner analysis failed (timed out during transfer (transfer 240 s)); "
                   "deterministic checks did not run"), "job_timeout"),
            (notes("graph: runner analysis failed (exit code 2); the review uses the submitted graph"), "executor"),
            (notes("Rio ended this review: runtime stopped: WorkflowFatalError."), "deadline"),
            (notes("Rio ended this review: cancelled."), "deadline"),
            (notes("Review cancelled before it finished."), "deadline"),
            (notes("graph: runner analysis failed (timed out); the review uses the submitted graph",
                   "cancelled"), "deadline"),
            (notes("WorkflowInternalError: Attempt failed due to internal workflows error"), "workflow_internal"),
            (notes("Too many API requests by single Worker invocation."), "subrequest_limit"),
            # The sweep names the limit that ended a workflow (aacr-bench-fix3-20261112T004450Z:
            # three such reviews carried only "runtime stopped: Error", read as a deadline).
            (notes("Rio ended this review: runtime stopped: Too many API requests by single Worker "
                   "invocation."), "subrequest_limit"),
            (notes("Rio ended this review: runtime stopped: Worker exceeded memory limit."), "memory_limit"),
            # The review's own request budget, kept below the platform's limit.
            (notes("correctness agent failed: review request budget exhausted; its findings are missing "
                   "from this review."), "subrequest_limit"),
            (notes("Request budget: 3 tree searches were not run, because the review had used its share of "
                   "the 50000 requests the platform allows one review on searching; what a search would "
                   "have found is missing from this review."), "subrequest_limit"),
            (notes("Request budget: 1 model turn was not started, because the review had used its share "
                   "of the 50000 requests the platform allows one review; the agents and verifier votes "
                   "they belonged to did not complete."), "subrequest_limit"),
            (notes("correctness agent failed: The operation was aborted due to timeout; its findings are "
                   "missing from this review."), "model_timeout"),
            (notes("Agent result cache not updated for correctness: D1_ERROR: D1 DB is overloaded. Too many "
                   "resources consumed within a 10 second window."), "storage"),
            (notes("D1_ERROR: Network connection lost."), "storage"),
            (notes("Hypothesis board coordination is deferred; agents and verifier voters run independently."), None),
            # Skipped and failed checks are the review's outcome, and a finding may quote anything.
            (notes("dependencies skipped offline", "tests: skipped (no test command is configured)",
                   "3 verifier votes did not complete; inspect the vote audit. Missing votes do not reduce quorum.",
                   "the cancelled order is charged twice"), None),
        ]
        for report, cause in cases:
            self.assertEqual(aacr.infra_failure(report), cause)
        self.assertEqual(aacr.infra_failure(None, "contacting Rio endpoint: error sending request: "
                                                  "Connection reset by peer (os error 104)"), "transport")
        # The fix2 canary: a status poll answered with the database's overload ended two cases.
        self.assertEqual(aacr.infra_failure(
            None, "Rio reported an error (internal_error): endpoint error: D1_ERROR: D1 DB is overloaded. "
                  "Too many resources consumed within a 10 second window.: Rio endpoint returned HTTP 400"),
            "storage")
        self.assertIsNone(aacr.infra_failure(None, "Report commit pins differ from dataset"))
        # Every cause is kept, in a stable order.
        self.assertEqual(aacr.infra_failures(notes(
            "graph: runner analysis failed (runner backend: Network connection lost.); the review uses the submitted graph",
            "WorkflowInternalError: Attempt failed due to internal workflows error")),
            ["executor", "workflow_internal"])

    def test_failures_recorded_only_in_the_audit_are_causes(self):
        """FreeCAD@82fef4a: three votes ended on the Worker's memory limit, under a
        report that says only that votes did not complete."""
        report = {"footer": {"notes": [
            "checks: runner analysis failed (timed out); deterministic checks did not run",
            "3 verifier votes did not complete; inspect the vote audit. Missing votes do not reduce quorum."]}}
        execution = lambda **fields: {"attempt": 1, "kind": "run", "version": "head", "command": ["sh"],
                                      "outcome": "exited", "exit_code": 0, "timed_out": False,
                                      "stderr": "", **fields}
        audit = {"votes": [
            {"status": "failed", "error": "Worker exceeded memory limit.", "voter": 0},
            {"status": "completed", "answer": {"reasoning": "Worker exceeded CPU time limit"}, "voter": 1}],
            "executions": [
                execution(kind="checks", command=["rio-internal", "rio/checks"], exit_code=124,
                          timed_out=True, stderr="runner wall deadline exceeded during transfer"),
                # A repository command's own output and its own timeout are not causes.
                execution(exit_code=2, stderr="curl: Connection reset by peer"),
                execution(command=["sleep", "900"], exit_code=124, timed_out=True,
                          stderr="runner wall deadline exceeded during command")]}
        self.assertEqual(aacr.infra_failures(report, audit=audit), ["memory_limit", "job_timeout"])
        self.assertEqual(aacr.infra_failures({"footer": {"notes": []}}, audit=audit),
                         ["memory_limit", "job_timeout"])
        # A runner that failed and whose retry ran is not a cause; one that never ran is.
        lost = execution(kind="graph", command=["rio-internal", "rio/graph"], outcome="runner_failed",
                         exit_code=1, stderr="runner backend: Network connection lost.")
        self.assertEqual(aacr.infra_failures(None, audit={"executions": [
            lost, execution(kind="graph", command=["rio-internal", "rio/graph"], attempt=2)]}), [])
        self.assertEqual(aacr.infra_failures(None, audit={"executions": [lost, {**lost, "attempt": 2}]}),
                         ["executor"])
        self.assertEqual(aacr.infra_failures(None, audit={}), [])

    def test_saved_evidence_is_classified_under_the_current_rules(self):
        """A status written before a cause had a label is classified from its
        report, audit and stderr; a recorded cause the evidence no longer names stays."""
        with tempfile.TemporaryDirectory() as tmp:
            evidence = Path(tmp)
            (evidence / "report.json").write_text(json.dumps(
                {"footer": {"notes": ["Worker exceeded CPU time limit."]}}), encoding="utf-8")
            self.assertEqual(aacr.case_infra_failure(evidence, {"status": "partial"}), "cpu_limit")
            self.assertEqual(aacr.case_infra_failure(evidence, {"status": "partial", "infra_failure": None}),
                             "cpu_limit")
            (evidence / "audit.json").write_text(json.dumps(
                {"votes": [{"status": "failed", "error": "Worker exceeded memory limit."}]}), encoding="utf-8")
            self.assertEqual(aacr.case_infra_failures(evidence, {"status": "partial"}),
                             ["cpu_limit", "memory_limit"])
            (evidence / "audit.json").unlink()
            (evidence / "report.json").unlink()
            self.assertEqual(aacr.case_infra_failures(evidence, {"status": "partial", "infra_failure": "executor"}),
                             ["executor"])
            (evidence / "review.stderr").write_text(
                "contacting Rio endpoint: connection error: Connection reset by peer", encoding="utf-8")
            self.assertEqual(aacr.case_infra_failure(evidence, {"status": "failed"}), "transport")
            # A usable report's stderr holds retried polls, not causes.
            self.assertIsNone(aacr.case_infra_failure(evidence, {"status": "complete"}))
            # The rerun's mislabelled envelope: the saved report names the cause.
            (evidence / "report.json").write_text(json.dumps({"status": "error", "error": {
                "code": "internal_error", "message": "endpoint review cancelled; partial evidence is retained"}}),
                encoding="utf-8")
            (evidence / "review.stderr").write_text("", encoding="utf-8")
            self.assertEqual(aacr.case_infra_failure(evidence, {
                "status": "failed", "infra_failure": None, "error": "Report commit pins differ from dataset"}),
                "deadline")


if __name__ == "__main__":
    unittest.main()
