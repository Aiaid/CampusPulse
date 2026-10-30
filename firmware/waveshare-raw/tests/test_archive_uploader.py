"""Synthetic-only custody, restart, receipt and private-spool regressions."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid
import zlib

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("archive_uploader", ROOT / "tools/archive_uploader.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)
NODE = "synthetic-node"
POLICY = "synthetic-import"
TOKEN = "synthetic-test-token-never-a-real-credential"


def cpraw():
    header = tool.decoder.MAGIC + struct.pack("<HH", 1, 32) + b"private-session!"
    header += struct.pack("<I", zlib.crc32(header))
    payload = b"private-synthetic-payload"
    body = struct.pack("<QQHH", 1, 100, len(payload), 0) + b"secret" + bytes(9) + b"direct" + b"\xc4\x7f" + payload
    frame = struct.pack("<IB3x", len(body) + 12, 1) + body
    return header + frame + struct.pack("<I", zlib.crc32(frame))


class Server:
    """Actual server response shapes, with explicit deterministic fault injection."""
    def __init__(self, *, crash=None, mutate=None, verifying=False):
        self.raw = None
        self.manifest = None
        self.receipts = {}
        self.receipt = None
        self.calls = []
        self.crash = crash
        self.mutate = mutate
        self.verifying = verifying

    def reply(self, value, code=200, extra=None):
        return tool.Reply(code, {"content-type": "application/json", "cache-control": "no-store", **(extra or {})}, tool.encode(value))

    def identity(self):
        return {"protocol": tool.PROTOCOL, "node_id": NODE, "upload_id": self.manifest["upload_id"],
                "manifest_sha256": tool.sha(self.raw)}

    def final(self):
        data = b"".join(self.chunks[index] for index in range(len(self.chunks)))
        validation = tool.local_validation(data)
        if validation["status"] == "invalid":
            validation["valid_bytes"] = 0
        return {**self.identity(), "archive_policy_id": POLICY,
                "file_sha256": self.manifest["file_sha256"], "file_bytes": len(data),
                "chunk_count": len(self.chunks), "scope": "file", "durability": "committed",
                "receipt_id": str(uuid.uuid4()), "received_at": "2026-10-30T00:00:00.000Z",
                "expires_at": "2026-10-31T00:00:00.000Z", "validation": {**validation, "parser_version": tool.PARSER_VERSION}}

    def request(self, method, url, body, headers):
        self.calls.append((method, url, body, dict(headers)))
        assert headers["Authorization"] == "Bearer " + TOKEN
        suffix = url.split("/uploads/", 1)[1].split("/", 1)
        if method == "PUT" and len(suffix) == 1:
            if self.raw is not None:
                assert self.raw == body
            else:
                self.raw, self.manifest, self.chunks = body, tool.parse(body), {}
            value = {**self.identity(), "archive_policy_id": POLICY, "scope": "manifest",
                     "state": "committed" if self.receipt else "open", "receipt": self.receipt}
            if self.mutate == "manifest-node":
                value["node_id"] = "wrong-node"
            return self.reply(value)
        if method == "GET":
            return self.reply({**self.identity(), "archive_policy_id": POLICY,
                "state": "committed" if self.receipt else "open", "receipt": self.receipt,
                "chunks": list(self.receipts.values())})
        if method == "PUT":
            index = int(suffix[1].split("/")[1])
            chunk = self.manifest["chunks"][index]
            assert tool.sha(body) == chunk["sha256"] and headers["X-Manifest-SHA256"] == tool.sha(self.raw)
            self.chunks[index] = body
            if index not in self.receipts:
                self.receipts[index] = {**self.identity(), **chunk, "scope": "chunk", "durability": "committed",
                    "receipt_id": str(uuid.uuid4()), "received_at": "2026-10-30T00:00:00.000Z"}
            if self.crash in ("chunk", "ack-loss"):
                crash, self.crash = self.crash, None
                if crash == "chunk":
                    raise KeyboardInterrupt()
                raise ConnectionError("synthetic ACK loss")
            value = copy.deepcopy(self.receipts[index])
            if self.mutate == "chunk-hash":
                value["sha256"] = "0" * 64
            if self.mutate == "chunk-durability":
                value["durability"] = "queued"
            return self.reply(value)
        assert method == "POST" and body == b""
        if self.verifying:
            return self.reply({"state": "verifying"}, 202)
        if self.receipt is None:
            self.receipt = self.final()
        if self.crash == "file":
            self.crash = None
            raise KeyboardInterrupt()
        value = copy.deepcopy(self.receipt)
        if self.mutate == "file-node":
            value["node_id"] = "wrong-node"
        return self.reply(value)


class UploaderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="cpraw-synthetic-")
        self.root = Path(self.temporary.name)
        self.source = self.root / "private-original.bin"
        self.source.write_bytes(cpraw())
        self.spool = self.root / "spool"

    def tearDown(self):
        self.temporary.cleanup()

    def prepare(self):
        return tool.prepare(self.source, self.spool, origin="https://synthetic.test", node=NODE, policy=POLICY)

    def send(self, upload_id, server, **kwargs):
        return tool.upload(self.spool, upload_id, TOKEN, transport=server, sleep=lambda _: None, **kwargs)

    def journal(self, upload_id):
        return json.loads((self.spool / upload_id / "journal.json").read_bytes())

    def test_private_snapshot_freezes_and_never_mutates_original(self):
        original = self.source.read_bytes()
        upload_id = self.prepare()
        job = self.spool / upload_id
        self.assertEqual(stat.S_IMODE(self.spool.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(job.stat().st_mode), 0o700)
        for name in ("segment.bin", "manifest.json", "identity.json"):
            self.assertEqual(stat.S_IMODE((job / name).stat().st_mode), 0o400)
        identity, manifest, raw, journal = tool.load_job(job)
        self.assertEqual(raw, (job / "manifest.json").read_bytes())
        self.assertEqual(manifest["file_sha256"], tool.sha(original))
        self.assertFalse(journal["manifest_accepted"])
        for private in (str(self.source), "private-original", "private-session", "private-synthetic", TOKEN):
            self.assertNotIn(private, (job / "identity.json").read_text() + raw.decode())
        receipt = self.send(upload_id, Server())
        self.assertEqual(receipt["validation"]["reports"], 1)
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual((job / "segment.bin").read_bytes(), original)
        self.assertEqual(self.journal(upload_id)["receipt"], receipt)

    def test_chunk_ack_loss_and_crash_resume_exact_identity(self):
        for failure in ("ack-loss", "chunk", "file"):
            with self.subTest(failure=failure):
                upload_id = self.prepare()
                job = self.spool / upload_id
                frozen = (job / "manifest.json").read_bytes()
                server = Server(crash=failure)
                if failure != "ack-loss":
                    with self.assertRaises(KeyboardInterrupt):
                        self.send(upload_id, server)
                    self.assertIsNone(self.journal(upload_id)["receipt"])
                receipt = self.send(upload_id, server)
                self.assertEqual((job / "manifest.json").read_bytes(), frozen)
                self.assertEqual(self.journal(upload_id)["receipt"], receipt)
                manifests = [call[2] for call in server.calls if call[0] == "PUT" and "/chunks/" not in call[1]]
                self.assertTrue(all(body == frozen for body in manifests))
                chunks = [call[2] for call in server.calls if "/chunks/" in call[1]]
                self.assertTrue(all(body == self.source.read_bytes() for body in chunks))

    def test_receipt_spoofing_never_marks_custody(self):
        for mutation in ("manifest-node", "chunk-hash", "chunk-durability", "file-node"):
            with self.subTest(mutation=mutation):
                upload_id = self.prepare()
                with self.assertRaises(tool.ArchiveError):
                    self.send(upload_id, Server(mutate=mutation))
                journal = self.journal(upload_id)
                self.assertIsNone(journal["receipt"])
                if mutation != "file-node":
                    self.assertEqual(journal["chunks"], {})
                self.assertTrue((self.spool / upload_id / "segment.bin").exists())

    def test_202_expiry_and_terminal_conflicts_preserve_local_files(self):
        upload_id = self.prepare()
        with self.assertRaises(tool.ArchiveError):
            self.send(upload_id, Server(verifying=True), polls=2)
        self.assertIsNone(self.journal(upload_id)["receipt"])
        for status in (401, 403, 409, 410, 422):
            server = Server()
            server.request = lambda *_: server.reply({"error": {"retryable": False, "message": "untrusted-private-data"}}, status)
            with self.subTest(status=status), self.assertRaises(tool.ArchiveError):
                self.send(upload_id, server)
        self.assertTrue(self.source.exists())
        self.assertTrue((self.spool / upload_id / "segment.bin").exists())

    def test_empty_interrupted_and_corrupt_evidence_is_not_repaired(self):
        for data, expected in ((b"", "invalid"), (b"bad header", "invalid"), (cpraw()[:-2], "interrupted_tail")):
            self.source.write_bytes(data)
            upload_id = self.prepare()
            receipt = self.send(upload_id, Server())
            self.assertEqual(receipt["validation"]["status"], expected)
            self.assertEqual((self.spool / upload_id / "segment.bin").read_bytes(), data)
            self.assertEqual(self.source.read_bytes(), data)

    def test_tampering_permissions_symlinks_and_lock_fail_before_network(self):
        upload_id = self.prepare()
        server = Server()
        job = self.spool / upload_id
        with tool.locked(job / ".lock"):
            with self.assertRaises(tool.ArchiveError):
                self.send(upload_id, server)
        self.assertEqual(server.calls, [])
        segment = job / "segment.bin"
        segment.chmod(0o600)
        segment.write_bytes(b"changed")
        with self.assertRaises(tool.ArchiveError):
            self.send(upload_id, server)
        self.assertEqual(server.calls, [])
        self.spool.chmod(0o755)
        with self.assertRaises(tool.ArchiveError):
            self.prepare()
        self.spool.chmod(0o700)
        link = self.root / "source-symlink"
        link.symlink_to(self.source)
        with self.assertRaises(OSError):
            tool.prepare(link, self.spool, origin="https://synthetic.test", node=NODE, policy=POLICY)

    def test_retry_budget_frozen_requests_and_cli_redaction(self):
        upload_id = self.prepare()
        server = Server()
        real_request = server.request
        calls = []
        def quota_once(*args):
            calls.append(args)
            if len(calls) == 1:
                return server.reply({"error": {"retryable": True}}, 429, {"retry-after": "60"})
            return real_request(*args)
        server.request = quota_once
        pauses = []
        tool.upload(self.spool, upload_id, TOKEN, transport=server, sleep=pauses.append)
        self.assertEqual(pauses, [60])
        self.assertEqual(calls[0], calls[1])
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(tool.main(["--spool", str(self.root / "private-missing"), "upload", upload_id]), 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn(str(self.root), stderr.getvalue())
        for origin in ("http://example.test", "https://secret@example.test", "https://example.test/path", "https://example.test?token=secret"):
            with self.subTest(origin=origin), self.assertRaises(tool.ArchiveError):
                tool.origin_url(origin)
        with self.assertRaises(tool.ArchiveError):
            tool.origin_url("ftp://localhost", allow_loopback_http=True)

    def test_journal_sync_failure_resumes_remote_chunk_without_reupload(self):
        upload_id = self.prepare()
        server = Server()
        save = tool.write_journal
        def fail_once(job, value):
            if value["chunks"]:
                raise OSError("synthetic local custody interruption")
            save(job, value)
        with patch.object(tool, "write_journal", side_effect=fail_once), self.assertRaises(OSError):
            self.send(upload_id, server)
        self.assertEqual(self.journal(upload_id)["chunks"], {})
        receipt = self.send(upload_id, server)
        self.assertEqual(self.journal(upload_id)["receipt"], receipt)
        self.assertEqual(sum("/chunks/" in call[1] for call in server.calls), 1)

    def test_changed_source_is_left_unpublished_and_original_retained(self):
        source_info = self.source.stat()
        real_stat = os.fstat
        source_reads = 0
        def changed(descriptor):
            nonlocal source_reads
            value = real_stat(descriptor)
            if value.st_ino == source_info.st_ino:
                source_reads += 1
                if source_reads == 2:
                    return SimpleNamespace(st_dev=value.st_dev, st_ino=value.st_ino, st_size=value.st_size,
                        st_mtime_ns=value.st_mtime_ns + 1, st_ctime_ns=value.st_ctime_ns)
            return value
        with patch.object(tool.os, "fstat", side_effect=changed), self.assertRaises(tool.ArchiveError):
            self.prepare()
        self.assertEqual(self.source.read_bytes(), cpraw())
        self.assertEqual([item for item in self.spool.iterdir() if not item.name.startswith(".")], [])
        self.assertEqual(len(list(self.spool.glob(".*.preparing"))), 1)

    def test_maximum_257_chunks_and_expired_receipt_history(self):
        self.source.write_bytes(b"\0" * tool.MAX_FILE_BYTES)
        upload_id = self.prepare()
        server = Server()
        receipt = self.send(upload_id, server)
        self.assertEqual(receipt["chunk_count"], 257)
        self.assertEqual(receipt["validation"]["status"], "invalid")
        server.request = lambda *_: server.reply({"error": {"retryable": False}, "receipt": receipt,
                                                 "evidence_state": "expired"}, 410)
        with self.assertRaises(tool.ArchiveError):
            self.send(upload_id, server)
        self.assertEqual(self.journal(upload_id)["receipt"], receipt)
        self.assertEqual(self.source.stat().st_size, tool.MAX_FILE_BYTES)
        self.assertTrue((self.spool / upload_id / "segment.bin").exists())


if __name__ == "__main__":
    unittest.main()
