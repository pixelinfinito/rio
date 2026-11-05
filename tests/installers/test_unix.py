"""Installer contract tests. Run: python3 -m unittest discover -s tests/installers -v."""
from contextlib import contextmanager
import hashlib
import io
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/install.sh"
TARGET = {("Linux", "x86_64"): "x86_64-unknown-linux-musl", ("Linux", "aarch64"): "aarch64-unknown-linux-musl", ("Darwin", "x86_64"): "x86_64-apple-darwin", ("Darwin", "arm64"): "aarch64-apple-darwin"}.get((platform.system(), platform.machine()))

@unittest.skipUnless(TARGET, "Unix installer needs a supported Unix host")
class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.dest = self.root / "bin with ' quote"
        self.config = self.root / "config"
        self.config.mkdir()
        (self.config / "config.toml").write_text("# keep")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("RIO_")}
        self.env.update(RIO_DOWNLOAD_BASE=str(self.source), RIO_VERSION="v0.1.0", RIO_INSTALL_DIR=str(self.dest), RIO_CONFIG_DIR=str(self.config))
        self.package()

    def package(self, binary=b"#!/bin/sh\necho 'rio 0.1.0 test-target test-commit'\n"):
        self.archive = self.source / f"rio-0.1.0-{TARGET}.tar.gz"
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, value in [("rio", binary), ("LICENSE", b"Apache-2.0"), ("README.md", b"Rio")]:
                info = tarfile.TarInfo(name)
                info.size = len(value)
                info.mode = 0o755 if name == "rio" else 0o644
                archive.addfile(info, io.BytesIO(value))
        self.checksums()

    def checksums(self):
        (self.source / "SHA256SUMS").write_text(f"{hashlib.sha256(self.archive.read_bytes()).hexdigest()}  {self.archive.name}\n")

    def run_installer(self, *args, success=True, shell="sh", env=None, script=SCRIPT):
        command = [shell]
        if shell == "bash":
            command.append("--posix")
        result = subprocess.run(command + [str(script), *args], env=env or self.env, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def assert_old_preserved(self):
        self.assertEqual((self.dest / "rio").read_text(), "existing binary")
        self.assertEqual(sorted(p.name for p in self.dest.iterdir()), ["keep", "rio"])

    def existing(self):
        self.dest.mkdir()
        (self.dest / "rio").write_text("existing binary")
        (self.dest / "keep").write_text("unrelated")

    def test_success_reinstall_path_hint_and_shells(self):
        for shell in [s for s in ["dash", "bash"] if shutil.which(s)]:
            result = self.run_installer(shell=shell)
            self.assertIn("Installed rio 0.1.0", result.stdout)
            self.assertIn("export PATH=", result.stdout)
            self.assertEqual(subprocess.run([self.dest / "rio", "--version"], capture_output=True).returncode, 0)
            hint = result.stdout.split("Add to your shell configuration: ")[1].strip()
            resolved = subprocess.check_output(["sh", "-c", hint + '; printf "%s" "$PATH"'], env=self.env, text=True)
            self.assertTrue(resolved.startswith(str(self.dest) + ":"))
            self.assertFalse(list(self.dest.glob(".rio.new.*")))

    def test_checksum_mismatch_preserves_directory(self):
        self.existing()
        self.archive.write_bytes(b"corruption")
        result = self.run_installer(success=False)
        self.assertIn("checksum mismatch", result.stderr)
        self.assert_old_preserved()

    def test_missing_checksum_preserves_directory(self):
        self.existing()
        (self.source / "SHA256SUMS").write_text("0" * 64 + "  unrelated.tar.gz\n")
        self.assertIn("checksum entry missing", self.run_installer(success=False).stderr)
        self.assert_old_preserved()

    def test_smoke_failure_preserves_binary_and_removes_stage(self):
        self.existing()
        self.package(b"#!/bin/sh\nexit 7\n")
        self.assertIn("smoke test failed", self.run_installer(success=False).stderr)
        self.assert_old_preserved()

    def test_unsupported_platform_and_plain_http(self):
        for overrides in [dict(RIO_INSTALL_OS="FreeBSD"), dict(RIO_INSTALL_ARCH="armv7l"), dict(RIO_DOWNLOAD_BASE="http://mirror.invalid/rio")]:
            self.run_installer(env={**self.env, **overrides}, success=False)
            self.assertFalse(self.dest.exists())

    def test_local_latest_needs_no_network(self):
        self.run_installer(env={**self.env, "RIO_VERSION": "latest"})
        self.assertTrue((self.dest / "rio").exists())

    def test_uninstall_and_purge_preserve_other_files(self):
        self.existing()
        (self.dest / ".rio.new.dead").write_text("partial")
        self.run_installer("--uninstall")
        self.assertTrue(self.config.exists())
        self.assertEqual([p.name for p in self.dest.iterdir()], ["keep"])
        self.run_installer("--uninstall", "--purge")
        self.assertFalse(self.config.exists())
        self.assertTrue((self.dest / "keep").exists())

    def test_cli_options_override_environment(self):
        other = self.root / "another"
        self.run_installer("--install-dir", str(other), "--version", "0.1.0")
        self.assertTrue((other / "rio").exists())
        self.assertFalse(self.dest.exists())

    def test_truncated_script_executes_nothing(self):
        truncated = self.root / "truncated.sh"
        truncated.write_text("\n".join(SCRIPT.read_text().splitlines()[:-1]) + "\n")
        self.run_installer(script=truncated)
        self.assertFalse(self.dest.exists())

    @contextmanager
    def other_filesystem(self):
        if platform.system() == "Darwin":
            image = self.root / "installer-volume.dmg"
            mount = self.root / "mounted-volume"
            mount.mkdir()
            subprocess.run(["hdiutil", "create", "-size", "64m", "-fs", "HFS+", "-volname", "RioInstallerTest", str(image)], check=True, capture_output=True, timeout=30)
            subprocess.run(["hdiutil", "attach", "-nobrowse", "-mountpoint", str(mount), str(image)], check=True, capture_output=True, timeout=30)
            try:
                yield mount
            finally:
                subprocess.run(["hdiutil", "detach", str(mount)], check=True, capture_output=True, timeout=30)
        elif Path("/dev/shm").is_dir():
            with tempfile.TemporaryDirectory(dir="/dev/shm") as other:
                yield Path(other)
        else:
            self.skipTest("no second filesystem available")

    def test_destination_filesystem_differs_from_temporary_directory(self):
        with self.other_filesystem() as other:
            if Path(other).stat().st_dev == self.root.stat().st_dev:
                self.fail("the installer test volume must be a different filesystem")
            # Some hosts mount /dev/shm noexec; use a deliberately failing binary
            # to verify that publication does not damage an existing installation.
            dest = Path(other) / "bin"
            dest.mkdir()
            (dest / "rio").write_text("existing binary")
            noexec = bool(os.statvfs(other).f_flag & getattr(os, "ST_NOEXEC", 8))
            result = self.run_installer(env={**self.env, "RIO_INSTALL_DIR": str(dest)}, success=not noexec)
            if noexec:
                self.assertIn("smoke test failed", result.stderr)
                self.assertEqual((dest / "rio").read_text(), "existing binary")
            else:
                self.assertIn("Installed rio 0.1.0", result.stdout)
            self.assertFalse(list(dest.glob(".rio.new.*")))

if __name__ == "__main__":
    unittest.main()
