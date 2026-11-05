"""Replay one preregistered case without altering the evaluation harness."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

setup = Path(__file__).resolve().parent
root = setup.parents[3]
plan = json.loads((setup / "run-plan.json").read_text())
case = plan["cases"][int(sys.argv[1])]
binary = Path(plan["binary"])
assert hashlib.sha256(binary.read_bytes()).hexdigest() == plan["binary_sha256"]
assert subprocess.check_output([str(binary), "--version"], text=True).strip() == plan["version"]
for name in ("install_plan", "profile"):
    assert hashlib.sha256(Path(case[name]).read_bytes()).hexdigest() == case[name + "_sha256"]
argv = ["python3", "eval/runner.py", "--repository", "hynek/structlog",
        "--pr", str(case["pr"]), "--base", case["base_sha"], "--head", case["head_sha"],
        "--languages", "python", "--rio", str(binary),
        "--out", str(root / "eval/runs" / case["output"]),
        "--install-plan", case["install_plan"], "--profile", case["profile"],
        "--case-id", case["case_id"]]
overrides = dict(plan["environment"])
if case["positive_control"]["kind"] == "seeded-mutation":
    overrides["GIT_CONFIG_GLOBAL"] = plan["seed"]["GIT_CONFIG_GLOBAL"]
started = time.monotonic()
result = {"argv": argv, "cwd": str(root), "environment_overrides": overrides,
          "started_utc": datetime.datetime.now(datetime.timezone.utc).isoformat()}
with (setup / (case["output"] + ".stdout.log")).open("wb") as so, (setup / (case["output"] + ".stderr.log")).open("wb") as se:
    proc = subprocess.run(argv, cwd=root, env={**os.environ, **overrides}, stdout=so, stderr=se)
result.update(exit_code=proc.returncode, wall_time_seconds=time.monotonic() - started,
              finished_utc=datetime.datetime.now(datetime.timezone.utc).isoformat())
(setup / (case["output"] + ".invocation.json")).write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
sys.exit(proc.returncode)
