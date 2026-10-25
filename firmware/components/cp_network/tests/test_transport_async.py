"""Run actual pinned SDK async-transport regressions with bounded host shims.

Usage: uv run --no-project test_transport_async.py --idf-path /path/to/esp-idf
Only temporary generated sources and binaries are written; the SDK is read-only.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def section(source, start, end):
    if source.count(start) != 1 or source.count(end) != 1:
        raise AssertionError("Pinned regression extraction anchor changed")
    return start + source.split(start, 1)[1].split(end, 1)[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--idf-path", type=Path, required=True)
    args = parser.parse_args()
    tests = Path(__file__).resolve().parent
    patcher = tests.parent / "cmake" / "patch_transport_async.py"
    source_relative = Path("components/tcp_transport/transport_ssl.c")
    original = (args.idf_path / source_relative).read_bytes()
    original_sha = hashlib.sha256(original).hexdigest()
    compiler = os.environ.get("CC") or shutil.which("clang") or shutil.which("cc")
    if not compiler:
        raise SystemExit("A host C compiler is required")
    with tempfile.TemporaryDirectory(prefix="cp-transport-test-") as directory:
        temporary = Path(directory)
        generated = temporary / "generated"
        subprocess.run([sys.executable, str(patcher), "--idf-path", str(args.idf_path), "--output", str(generated)], check=True)
        patched = (generated / "transport_ssl.c").read_text()
        manifest = json.loads((generated / "manifest.json").read_text())
        assert manifest["source_sha256"] == original_sha
        assert manifest["patched_sha256"] == hashlib.sha256(patched.encode()).hexdigest()
        assert manifest["tls_verification_changed"] is False
        assert patched.startswith("/*\n * SPDX-FileCopyrightText:")
        extracted = section(patched, "static inline transport_esp_tls_t *ssl_get_context_data", "static inline int ssl_connect_async")
        extracted += section(patched, "static int ssl_read(", "static int tcp_read(")
        extracted += section(patched, "static int base_close(", "static int base_destroy(")
        (temporary / "transport_async_actual.inc").write_text(extracted)
        binary = temporary / "test_transport_async"
        subprocess.run([compiler, "-std=c11", "-Wall", "-Wextra", "-Werror",
                        "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
                        "-I", str(temporary), str(tests / "test_transport_async.c"),
                        "-o", str(binary)], check=True)
        subprocess.run([str(binary)], check=True)
        # A different SDK is refused before any generated output is created.
        drift_sdk = temporary / "drift-sdk"
        drift_source = drift_sdk / source_relative
        drift_source.parent.mkdir(parents=True)
        drift_source.write_bytes(original + b"\n/* unreviewed drift */\n")
        drift_output = temporary / "must-not-exist"
        rejected = subprocess.run([sys.executable, str(patcher), "--idf-path", str(drift_sdk),
                                   "--output", str(drift_output)], capture_output=True, text=True)
        assert rejected.returncode != 0 and "fingerprint" in rejected.stderr
        assert not drift_output.exists()
        assert (args.idf_path / source_relative).read_bytes() == original
    print("Fingerprint drift rejected; upstream notices retained; installed SDK unchanged")


if __name__ == "__main__":
    main()
