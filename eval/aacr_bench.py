#!/usr/bin/env python3
"""Run Rio on AACR-Bench, then score with the pinned upstream evaluator.

Use the Python environment from AACR-Bench's evaluation directory. Reference
comments are never placed in review checkouts or passed to Rio. Failed reviews
have evidence records but no evaluator result, so they cannot become empty
successful reviews. No benchmark repository dependencies are installed locally;
the configured Rio endpoint owns tool execution and dependency preparation.
"""
from __future__ import annotations

import argparse
import asyncio
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone


def sha256(path):
    """Hash a file without loading the executable or dataset into memory."""
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def write_json(path, value):
    """Atomically replace a UTF-8 JSON artifact in its evidence directory."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def stop_process(proc):
    """Interrupt a child group, escalating if it does not exit promptly."""
    try:
        os.killpg(proc.pid, signal.SIGINT)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()


def execute(argv, cwd, evidence, name, timeout=600, env=None, stop_event=None):
    """Capture commands and streams; propagate cancellation after child cleanup."""
    out, err = evidence / f"{name}.stdout", evidence / f"{name}.stderr"
    started = time.monotonic()
    timed_out = False
    if stop_event is not None and stop_event.is_set():
        raise KeyboardInterrupt
    with out.open("wb") as stdout, err.open("wb") as stderr:
        proc = subprocess.Popen(argv, cwd=cwd, env=env, stdout=stdout,
                                stderr=stderr, start_new_session=True)
        try:
            while True:
                if stop_event is not None and stop_event.is_set():
                    raise KeyboardInterrupt
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(argv, timeout)
                try:
                    proc.wait(timeout=min(0.25, remaining))
                    break
                except subprocess.TimeoutExpired:
                    continue
        except subprocess.TimeoutExpired:
            timed_out = True
            stop_process(proc)
        except KeyboardInterrupt:
            stop_process(proc)
            raise
    record = {"argv": list(map(str, argv)), "cwd": str(cwd),
              "exit_code": proc.returncode, "timed_out": timed_out,
              "duration_seconds": round(time.monotonic() - started, 3),
              "stdout": out.name, "stderr": err.name}
    write_json(evidence / f"{name}.command.json", record)
    return record, out.read_text(encoding="utf-8", errors="replace"), err.read_text(encoding="utf-8", errors="replace")


def load_dataset(path):
    """Validate case identities before using them as evidence filenames."""
    instances, seen = [], set()
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        instance = json.loads(line)
        if not isinstance(instance, dict):
            raise ValueError(f"Dataset line {number}: expected an object")
        identity = instance.get("instance_id", "")
        safe = identity.replace("/", "__") if isinstance(identity, str) else ""
        if not re.fullmatch(r"[\w.@+-]+", safe, flags=re.ASCII) or safe in {".", ".."}:
            raise ValueError(f"Dataset line {number}: unsafe instance_id")
        if safe in seen:
            raise ValueError(f"Dataset line {number}: duplicate evidence filename")
        seen.add(safe)
        if not isinstance(instance.get("repo"), str) or not re.fullmatch(r"[\w.-]+/[\w.-]+", instance["repo"], flags=re.ASCII):
            raise ValueError(f"Dataset line {number}: expected owner/repo")
        for field in ("base_commit", "head_commit"):
            value = instance.get(field)
            if not isinstance(value, str) or not re.fullmatch(r"[a-fA-F0-9]{40}|[a-fA-F0-9]{64}", value):
                raise ValueError(f"Dataset line {number}: {field} must be a full commit SHA")
        if not isinstance(instance.get("reference_comments"), list):
            raise ValueError(f"Dataset line {number}: expected reference_comments array")
        instances.append(instance)
    return instances


def comments_from_report(report):
    """Publishable findings and risks, with one primary location per identity.

    Rio presents plausible risks to users too. Include them rather than choosing
    an evidence threshold after seeing annotations. Exclude fixed/pre-existing
    findings and refuted hypotheses, which are not review comments on this diff.
    """
    comments, seen = [], set()
    for finding in report.get("findings", []) + report.get("risks", []):
        if finding.get("state") in {"fixed", "pre-existing"}:
            continue
        if finding.get("evidence_level") == "refuted":
            continue
        identity = finding["id"]
        if identity in seen:
            continue
        seen.add(identity)
        loc = finding["location"]
        content = "\n".join(str(finding[k]) for k in
                            ["message", "trigger", "impact", "suggested_fix"]
                            if finding.get(k))
        comments.append({"path": loc["path"], "start_line": loc["line_start"],
                         "end_line": loc["line_end"], "content": content,
                         "rio_finding_id": identity})
    return comments


# Footer notes and errors that mean the platform, not the reviewer, cut a case short.
# Timeouts come before executor failures, so a timed-out job that also lost a
# connection on the way counts as a timeout.
INFRA_PATTERNS = [
    ("cpu_limit", ("Worker exceeded CPU time limit",)),
    ("memory_limit", ("Worker exceeded memory limit", "exceeded CPU or memory limits")),
    ("deadline", ("Rio ended this review", "exceeded its wall budget")),
    ("job_timeout", ("WorkflowTimeoutError", "runner wall deadline exceeded",
                     "no runner result within", "runner analysis failed (timed out")),
    ("executor", ("sandbox executor failed", "Network connection lost",
                  "runner analysis failed")),
    ("transport", ("contacting Rio endpoint", "Connection reset", "connection error")),
]


def infra_failure(report, error=""):
    """The first infrastructure cause a case's report or error names, else None.

    A note ending in "; retried" records a runner attempt that a retry recovered,
    so it is not a cause. Such a case is still scored (as whatever comments it
    has); summaries also report scores without these cases, so platform failures
    do not read as reviewer misses.
    """
    notes = [n for n in (report or {}).get("footer", {}).get("notes", [])
             if not n.endswith("; retried")]
    texts = [*notes, error or ""]
    for cause, needles in INFRA_PATTERNS:
        if any(needle in text for text in texts for needle in needles):
            return cause
    return None


def case_infra_failure(evidence, status):
    """A case's recorded cause, or one derived from its saved report and stderr
    when the status predates the field."""
    if "infra_failure" in status:
        return status["infra_failure"]
    report_path, stderr = evidence / "report.json", evidence / "review.stderr"
    report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else None
    tail = stderr.read_text(encoding="utf-8", errors="replace")[-4000:] if stderr.exists() else ""
    return infra_failure(report, f"{status.get('error', '')}\n{tail}")


GIT_LOCATION_VARIABLES = frozenset({
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE",
})


def git_environment():
    """Keep Git operations bound to their cwd rather than an inherited repository."""
    return {key: value for key, value in os.environ.items() if key not in GIT_LOCATION_VARIABLES}


def review_group(repo, instances, args, stop_event=None):
    """Review one repository serially, preserving terminal attempts for resume."""
    env = git_environment()
    for key in list(env):
        if (key.startswith("RIO_") and key not in {"RIO_API_TOKEN", "RIO_ENDPOINT_URL"}) or key.startswith("JUDGE_"):
            del env[key]
    env.update(RIO_CONFIG_DIR=str(args.config_dir), RIO_TUI="0",
               GIT_TERMINAL_PROMPT="0", GIT_LFS_SKIP_SMUDGE="1")
    with tempfile.TemporaryDirectory(prefix="aacr-", dir=args.temp_root) as work:
        checkout = Path(work) / "repo"
        checkout.mkdir()
        initialized = False
        for instance in instances:
            if stop_event is not None and stop_event.is_set():
                raise KeyboardInterrupt
            safe = instance["instance_id"].replace("/", "__")
            evidence = args.out / "cases" / safe
            if (evidence / "status.json").exists():
                continue
            evidence.mkdir(parents=True, exist_ok=True)
            started = time.monotonic()
            status = {"instance_id": instance["instance_id"], "repo": repo,
                      "base_commit": instance["base_commit"],
                      "head_commit": instance["head_commit"], "status": "failed"}
            cache = Path(work) / "cache"
            env["RIO_CACHE_DIR"] = str(cache)
            interrupted = False
            def git(name, *argv, check=True):
                """Record a Git command against this disposable checkout."""
                record, stdout, stderr = execute(["git", *argv], checkout,
                                                evidence, name, env=env, stop_event=stop_event)
                if check and (record["exit_code"] or record["timed_out"]):
                    raise RuntimeError(f"git {name} failed; see {name}.stderr: {stderr[-600:]}")
                return record, stdout.strip()
            try:
                if not initialized:
                    git("init", "init", "--quiet")
                    git("remote", "remote", "add", "origin",
                        instance.get("clone_url") or f"https://github.com/{repo}.git")
                    initialized = True
                git("fetch", "fetch", "--quiet", "--no-tags", "--filter=blob:none",
                    "--depth=1", "origin", instance["base_commit"], instance["head_commit"])
                # Materialize both trees, including promised blobs, before gix reads
                # them. Staged mode avoids --base's merge-base semantics for the
                # dataset's diverged commit pairs, without inventing commits.
                git("checkout-head", "checkout", "--quiet", "--force", "--detach", instance["head_commit"])
                git("checkout-base", "checkout", "--quiet", "--force", "--detach", instance["base_commit"])
                git("clean", "clean", "-fdx")  # Only this runner's disposable checkout.
                git("stage-head", "read-tree", instance["head_commit"])
                _, index_tree = git("index-tree", "write-tree")
                _, head_tree = git("head-tree", "rev-parse", f"{instance['head_commit']}^{{tree}}")
                if index_tree != head_tree:
                    raise RuntimeError("Staged tree differs from dataset target tree")
                status.update(selection="staged", target_tree=head_tree, staged_tree=index_tree)
                record, stdout, _ = execute(
                    [str(args.rio), "review", "--staged",
                     "--profile", str(args.out / "profile.yaml"), "--format", "json"],
                    checkout, evidence, "review", timeout=args.timeout, env=env, stop_event=stop_event)
                status["exit_code"] = record["exit_code"]
                for pattern, filename in [("**/verification/audit.json", "audit.json"),
                                          ("**/endpoint.json", "endpoint.json")]:
                    for path in cache.glob(pattern):
                        shutil.copyfile(path, evidence / filename)
                report = json.loads(stdout)
                write_json(evidence / "report.json", report)
                if report.get("review", {}).get("base") != instance["base_commit"] or not report.get("review", {}).get("head", "").startswith("snapshot:") or report.get("review", {}).get("mode") != "staged":
                    raise RuntimeError("Report commit pins differ from dataset")
                if record["timed_out"] or record["exit_code"] not in {0, 1, 4} or report.get("status") not in {"complete", "incomplete", "partial"}:
                    raise RuntimeError(f"Review did not produce a usable report: {report.get('status')}")
                comments = comments_from_report(report)
                status.update(status=report["status"], comments=len(comments),
                              checks=report.get("checks", []),
                              infra_failure=infra_failure(report))
                duration = record["duration_seconds"]
                write_json(args.out / "results" / f"{safe}.json",
                           {"instance_id": instance["instance_id"], "reviewer": "rio",
                            "duration_seconds": duration, "review": {"comments": comments}})
            except KeyboardInterrupt:
                interrupted = True
                (args.out / "results" / f"{safe}.json").unlink(missing_ok=True)
                raise
            except Exception as error:
                status["error"] = str(error)
                # The saved report (when one was parsed) and stderr name the cause.
                status["infra_failure"] = case_infra_failure(evidence, status)
            finally:
                status["duration_seconds"] = round(time.monotonic() - started, 3)
                if not interrupted:
                    write_json(evidence / "status.json", status)
                if cache.exists():
                    shutil.rmtree(cache)
                with PRINT_LOCK:
                    print(f"{instance['instance_id']}: {'interrupted' if interrupted else status['status']} "
                          f"({status.get('comments', 0)} comments, {status['duration_seconds']}s) "
                          f"{status.get('error', '')}", flush=True)


PRINT_LOCK = threading.Lock()


def run(args):
    """Pin run inputs, dispatch repository workers, and summarize completed attempts."""
    args.out.mkdir(parents=True, exist_ok=True)
    instances = load_dataset(args.dataset)
    if args.instance:
        instances = [x for x in instances if args.instance in x["instance_id"]]
    if args.limit:
        instances = instances[:args.limit]
    if not instances:
        raise SystemExit("No selected instances")
    manifest_path = args.out / "manifest.json"
    identity = {"rio_sha256": sha256(args.rio), "dataset_sha256": sha256(args.dataset),
                "aacr_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=args.aacr, env=git_environment()).decode().strip(),
                "instances": [x["instance_id"] for x in instances]}
    env = dict(git_environment(), RIO_CONFIG_DIR=str(args.config_dir))
    profile = subprocess.check_output([str(args.rio), "profile", "show", args.profile, "--raw"], env=env)
    resolved = subprocess.check_output([str(args.rio), "profile", "show", args.profile], env=env)
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not args.resume or any(manifest[k] != v for k, v in identity.items()):
            raise SystemExit("Existing run: --resume requires matching binary, dataset and instances")
        if sha256(args.out / "profile.yaml") != manifest["profile_sha256"]:
            raise SystemExit("Resolved profile changed since run started")
        if sha256(args.out / "profile.resolved.yaml") != manifest["resolved_profile_sha256"]:
            raise SystemExit("Resolved profile changed since run started")
        if profile != (args.out / "profile.yaml").read_bytes() or resolved != (args.out / "profile.resolved.yaml").read_bytes():
            raise SystemExit("Selected profile or its inherited configuration changed since run started")
    else:
        (args.out / "profile.yaml").write_bytes(profile)
        (args.out / "profile.resolved.yaml").write_bytes(resolved)
        manifest = {**identity, "created_at": datetime.now(timezone.utc).isoformat(),
                    "rio_version": subprocess.check_output([str(args.rio), "--version"]).decode().strip(),
                    "rio": str(args.rio), "dataset": str(args.dataset), "aacr": str(args.aacr),
                    "profile_sha256": sha256(args.out / "profile.yaml"),
                    "resolved_profile_sha256": sha256(args.out / "profile.resolved.yaml"),
                    "concurrency": args.concurrency, "timeout_seconds": args.timeout,
                    "comment_policy": "findings+risks; exclude fixed/pre-existing/refuted; dedupe by id",
                    "reference_comments": sum(len(x["reference_comments"]) for x in instances),
                    "execution": "Configured remote Rio endpoint; no local dependency installs"}
        write_json(manifest_path, manifest)
    args.temp_root.mkdir(parents=True, exist_ok=True)
    # Other work in the Rio checkout may rebuild target/debug/rio during a long
    # run. Execute a private immutable copy, not that shared build output.
    with tempfile.TemporaryDirectory(prefix="aacr-bin-", dir=args.temp_root) as binary_dir:
        pinned_binary = Path(binary_dir) / "rio"
        shutil.copy2(args.rio, pinned_binary)
        if sha256(pinned_binary) != identity["rio_sha256"]:
            raise SystemExit("Pinned Rio binary hash mismatch")
        worker_args = argparse.Namespace(**{**vars(args), "rio": pinned_binary})
        manifest.setdefault("invocations", []).append({
            "started_at": datetime.now(timezone.utc).isoformat(),
            "adapter_sha256": sha256(__file__), "concurrency": args.concurrency,
            "pinned_binary": str(pinned_binary), "temp_root": str(args.temp_root)})
        write_json(manifest_path, manifest)
        groups = defaultdict(list)
        for instance in instances:
            groups[instance["repo"]].append(instance)
        stop_event = threading.Event()
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency)
        try:
            futures = [pool.submit(review_group, repo, rows, worker_args, stop_event)
                       for repo, rows in groups.items()]
            for future in concurrent.futures.as_completed(futures):
                future.result()
        except BaseException:
            stop_event.set()
            raise
        finally:
            pool.shutdown(wait=True, cancel_futures=True)
    statuses = []
    for path in (args.out / "cases").glob("*/status.json"):
        status = json.loads(path.read_text(encoding="utf-8"))
        status["infra_failure"] = case_infra_failure(path.parent, status)
        statuses.append(status)
    summary = {"selected": len(instances), "attempted": len(statuses),
               "statuses": dict(Counter(x["status"] for x in statuses)),
               "generated_comments": sum(x.get("comments", 0) for x in statuses),
               "failed": [x["instance_id"] for x in statuses if x["status"] == "failed"],
               "infra_failures": dict(Counter(x["infra_failure"] for x in statuses
                                           if x.get("infra_failure")))}
    write_json(args.out / "run-summary.json", summary)
    print(json.dumps(summary, indent=2))


def evaluate(args):
    """Score pinned review results with a real upstream judge and reusable cache."""
    if not os.environ.get("JUDGE_API_KEY") or os.environ.get("JUDGE_USE_MOCK", "").lower() == "true":
        raise SystemExit("Real semantic scoring requires JUDGE_API_KEY; mock scores are refused")
    if not os.environ.get("JUDGE_MODEL"):
        raise SystemExit("Set JUDGE_MODEL explicitly to pin the semantic judge")
    manifest = json.loads((args.out / "manifest.json").read_text(encoding="utf-8"))
    if sha256(args.dataset) != manifest["dataset_sha256"]:
        raise SystemExit("Dataset differs from the reviewed run")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=args.aacr, env=git_environment()).decode().strip()
    if commit != manifest["aacr_commit"]:
        raise SystemExit("Upstream evaluator differs from pinned commit")
    sys.path.insert(0, str(args.aacr / "evaluation"))
    from schema import load_instances
    import judge
    import evaluate as upstream
    if judge.USE_MOCK_LLM:
        raise SystemExit("Upstream judge selected mock mode")
    instances = [x for x in load_instances(args.dataset) if x.instance_id in manifest["instances"]]
    # Cache full upstream judge answers, keyed by evaluator identity, model and
    # exact arguments. Re-running scoring as reviews finish does not pay again
    # for earlier judgments, and never reuses errors as negative matches.
    cache = args.out / "judge-cache"
    cache.mkdir(exist_ok=True)
    original_match = judge.match_llm_file_level
    async def cached_match(*params):
        """Reuse successful judgments without caching upstream provider errors."""
        identity = [commit, os.environ.get("JUDGE_MODEL"), os.environ.get("JUDGE_BASE_URL"), params]
        key = hashlib.sha256(json.dumps(identity, ensure_ascii=False).encode()).hexdigest()
        path = cache / f"{key}.json"
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))["answer"]
        answer = await original_match(*params)
        if "评估过程出错" not in answer.get("reason", ""):
            write_json(path, {"identity": identity, "answer": answer})
        return answer
    judge.match_llm_file_level = cached_match
    review_cost = 0.0
    for instance in instances:
        safe = instance.instance_id.replace("/", "__")
        audit_path = args.out / "cases" / safe / "audit.json"
        result_path = args.out / "results" / f"{safe}.json"
        if audit_path.exists() and result_path.exists():
            usage = json.loads(audit_path.read_text(encoding="utf-8")).get("usage", [])
            result = json.loads(result_path.read_text(encoding="utf-8"))
            result["review"]["summary"] = {
                "input_tokens": sum(x.get("input_tokens") or 0 for x in usage),
                "output_tokens": sum(x.get("output_tokens") or 0 for x in usage)}
            review_cost += sum(x.get("cost_usd") or 0 for x in usage)
            write_json(result_path, result)
    result = asyncio.run(upstream.evaluate(instances, args.out / "results", "rio", args.out / "metrics"))
    # Secondary scores without cases the platform cut short; the primary scores
    # above keep every selected case. Judgments are cached, so this costs nothing more.
    infra = {}
    for instance in instances:
        path = args.out / "cases" / instance.instance_id.replace("/", "__") / "status.json"
        cause = case_infra_failure(path.parent, json.loads(path.read_text(encoding="utf-8"))) \
            if path.exists() else "not_attempted"
        if cause:
            infra[instance.instance_id] = cause
    clean = [x for x in instances if x.instance_id not in infra]
    result["infra_failures"] = infra
    result["excluding_infra_failures"] = asyncio.run(upstream.evaluate(
        clean, args.out / "results", "rio", args.out / "metrics-excluding-infra"))["summary"] if clean else None
    errors = [g for row in result["eval_res"] for g in row.get("generated_comments", [])
              if "评估过程出错" in g.get("judge_reason", "")]
    result["provenance"] = {"judge_model": os.environ.get("JUDGE_MODEL"),
                            "judge_base_url": os.environ.get("JUDGE_BASE_URL"),
                            "mock": False, "judge_errors": len(errors),
                            "aacr_commit": commit, "valid": not errors,
                            "coverage_complete": result["summary"]["missing_instances"] == 0,
                            "recorded_review_cost_usd": round(review_cost, 6)}
    write_json(args.out / "metrics.json", result)
    upstream.print_summary("rio", result)
    if errors:
        raise SystemExit("Judge failures recorded: scores are invalid")


def main():
    """Parse and validate paths and execution limits for either adapter stage."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["run", "evaluate"])
    parser.add_argument("--aacr", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--rio", type=Path, default=Path("target/debug/rio"))
    parser.add_argument("--profile", default="rio/openrouter")
    parser.add_argument("--config-dir", type=Path, default=Path(os.environ.get(
        "RIO_CONFIG_DIR", Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "rio")))
    parser.add_argument("--temp-root", type=Path, default=Path(tempfile.gettempdir()))
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--timeout", type=int, default=1200)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--instance")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    for key in ["aacr", "dataset", "out", "rio", "config_dir", "temp_root"]:
        setattr(args, key, getattr(args, key).resolve())
    if args.concurrency < 1 or args.timeout < 1 or (args.limit is not None and args.limit < 1):
        parser.error("concurrency, timeout and limit must be positive")
    (run if args.stage == "run" else evaluate)(args)


if __name__ == "__main__":
    main()
