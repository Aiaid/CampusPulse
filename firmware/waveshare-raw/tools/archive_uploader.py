#!/usr/bin/env python3
"""Private CPRAW host archive foundation. Prepare is offline; upload is explicit.

Accepts one already exported/stopped local file. It never opens USB, stops a
recorder, enumerates a card, deletes originals/spool entries or chooses a server
by default. Tokens come from CPRAW_DEVICE_TOKEN or a private token file, never
command arguments, URLs or the journal. All requests retain frozen identities.
"""
import argparse
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import random
import re
import ssl
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

PROTOCOL = "campuspulse/cpraw-archive/1"
CHUNK_BYTES = 65536
MAX_FILE_BYTES = 16780672
MAX_REPLY_BYTES = 262144
PARSER_VERSION = "cpraw/1-validator/1"
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
HASH = re.compile(r"[0-9a-f]{64}\Z")
TOKEN_NAME = re.compile(r"[a-z0-9_-]{1,64}\Z")
_spec = importlib.util.spec_from_file_location("cpraw_archive_decoder", Path(__file__).with_name("decode.py"))
decoder = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(decoder)


class ArchiveError(ValueError):
    """Sanitized protocol/local-custody failure. Originals must be retained."""


def require(condition, message="archive integrity or protocol mismatch"):
    if not condition:
        raise ArchiveError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def parse(data):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, "duplicate JSON field")
            value[key] = item
        return value
    try:
        return json.loads(data, object_pairs_hook=unique, parse_constant=lambda _: require(False))
    except (UnicodeError, json.JSONDecodeError):
        raise ArchiveError("invalid bounded JSON") from None


def private_directory(path, create=False):
    path = Path(path)
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and
            stat.S_IMODE(info.st_mode) & 0o077 == 0, "spool directory must be owned and private (0700)")
    return path


def private_open(path, flags=os.O_RDONLY, mode=0o600):
    descriptor = os.open(path, flags | os.O_NOFOLLOW, mode)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and
                stat.S_IMODE(info.st_mode) & 0o077 == 0, "spool files must be owned and private")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def read_private(path, maximum):
    with os.fdopen(private_open(path), "rb") as source:
        data = source.read(maximum + 1)
    require(len(data) <= maximum, "private file exceeds bound")
    return data


def write_new(path, data, mode=0o600):
    with os.fdopen(private_open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL), "wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
        os.fchmod(output.fileno(), mode)
        os.fsync(output.fileno())


def write_journal(job, value):
    temporary = job / (".journal-" + str(uuid.uuid4()) + ".tmp")
    write_new(temporary, encode(value))
    os.replace(temporary, job / "journal.json")
    sync_directory(job)


@contextmanager
def locked(path):
    descriptor = private_open(path, os.O_RDWR | os.O_CREAT)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ArchiveError("archive spool is already in use") from None
        yield
    finally:
        os.close(descriptor)


def origin_url(value, allow_loopback_http=False):
    try:
        parts = urllib.parse.urlsplit(value)
        port = parts.port
    except ValueError:
        raise ArchiveError("invalid server origin") from None
    require(parts.scheme in ("https", "http") and parts.hostname and parts.username is None and
            parts.password is None and parts.path in ("", "/") and not parts.query and not parts.fragment,
            "provide one explicit server origin without credentials, path or query")
    require(parts.scheme == "https" or (parts.scheme == "http" and allow_loopback_http and
            parts.hostname in ("localhost", "127.0.0.1", "::1")),
            "HTTPS is required except explicitly permitted loopback tests")
    require(port is None or 1 <= port <= 65535)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, "", "", ""))


def local_validation(data):
    try:
        summary = decoder.decode(data)
    except decoder.FormatError:
        return {"status": "invalid", "valid_bytes": None, "truncated_offset": None, "reports": None}
    return {"status": "valid" if summary["truncated_offset"] is None else "interrupted_tail",
            "valid_bytes": summary["valid_bytes"], "truncated_offset": summary["truncated_offset"],
            "reports": summary["reports"]}


def prepare(source_path, spool, *, origin, node, policy, source="tf_card_copy", allow_loopback_http=False):
    """Freeze one stable snapshot. Failed unpublished preparations are retained."""
    root = private_directory(spool, create=True)
    origin = origin_url(origin, allow_loopback_http)
    require(isinstance(node, str) and TOKEN_NAME.fullmatch(node), "invalid registered node identity")
    require(isinstance(policy, str) and TOKEN_NAME.fullmatch(policy), "invalid import policy identity")
    require(source in ("tf_card_copy", "usb_export"), "invalid importer source claim")
    with locked(root / ".prepare.lock"):
        upload_id = str(uuid.uuid4())
        staging = root / ("." + upload_id + ".preparing")
        staging.mkdir(mode=0o700)
        descriptor = os.open(source_path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as original:
            before = os.fstat(original.fileno())
            require(stat.S_ISREG(before.st_mode) and before.st_size <= MAX_FILE_BYTES, "source is not a bounded regular file")
            chunks, total, digest = [], 0, hashlib.sha256()
            with os.fdopen(private_open(staging / "segment.bin", os.O_WRONLY | os.O_CREAT | os.O_EXCL), "wb") as saved:
                while True:
                    block = original.read(CHUNK_BYTES)
                    if not block:
                        break
                    require(total + len(block) <= MAX_FILE_BYTES, "source exceeds archive bound")
                    chunks.append({"index": len(chunks), "offset": total, "bytes": len(block), "sha256": sha(block)})
                    saved.write(block)
                    digest.update(block)
                    total += len(block)
                saved.flush()
                os.fsync(saved.fileno())
                os.fchmod(saved.fileno(), 0o400)
                os.fsync(saved.fileno())
            after = os.fstat(original.fileno())
            stamp = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
            require(stamp(before) == stamp(after) and total == before.st_size, "source changed during snapshot; preparation not published")
        manifest = {"protocol": PROTOCOL, "upload_id": upload_id, "archive_policy_id": policy,
                    "format": "cpraw/1", "file_bytes": total, "file_sha256": digest.hexdigest(),
                    "chunk_bytes": CHUNK_BYTES, "chunks": chunks, "source": source}
        manifest_bytes = encode(manifest)
        require(len(manifest_bytes) <= CHUNK_BYTES)
        frozen = read_private(staging / "segment.bin", MAX_FILE_BYTES)
        require(sha(frozen) == manifest["file_sha256"])
        identity = {"version": 1, "upload_id": upload_id, "node_id": node, "origin": origin,
                    "allow_loopback_http": allow_loopback_http, "manifest_sha256": sha(manifest_bytes),
                    "local_validation": local_validation(frozen)}
        write_new(staging / "manifest.json", manifest_bytes, 0o400)
        write_new(staging / "identity.json", encode(identity), 0o400)
        write_journal(staging, {"version": 1, "manifest_sha256": identity["manifest_sha256"],
                               "manifest_accepted": False, "chunks": {}, "receipt": None})
        sync_directory(staging)
        destination = root / upload_id
        require(not destination.exists(), "upload identity already exists")
        os.rename(staging, destination)
        sync_directory(root)
        return upload_id


def fields(value, expected):
    require(isinstance(value, dict) and set(value) == set(expected), "unexpected archive response or spool fields")


def integer(value, minimum=0, maximum=MAX_FILE_BYTES):
    return type(value) is int and minimum <= value <= maximum


def load_job(job):
    identity = parse(read_private(job / "identity.json", 4096))
    fields(identity, ("version", "upload_id", "node_id", "origin", "allow_loopback_http", "manifest_sha256", "local_validation"))
    require(identity["version"] == 1 and UUID.fullmatch(identity["upload_id"]) and
            TOKEN_NAME.fullmatch(identity["node_id"]) and type(identity["allow_loopback_http"]) is bool)
    require(job.name == identity["upload_id"], "spool directory and frozen identity disagree")
    require(identity["origin"] == origin_url(identity["origin"], identity["allow_loopback_http"]))
    raw = read_private(job / "manifest.json", CHUNK_BYTES)
    require(sha(raw) == identity["manifest_sha256"], "frozen manifest changed")
    manifest = parse(raw)
    fields(manifest, ("protocol", "upload_id", "archive_policy_id", "format", "file_bytes", "file_sha256", "chunk_bytes", "chunks", "source"))
    require(manifest["protocol"] == PROTOCOL and manifest["format"] == "cpraw/1" and
            manifest["upload_id"] == identity["upload_id"] and TOKEN_NAME.fullmatch(manifest["archive_policy_id"]) and
            manifest["chunk_bytes"] == CHUNK_BYTES and integer(manifest["file_bytes"]) and
            HASH.fullmatch(manifest["file_sha256"]) and manifest["source"] in ("tf_card_copy", "usb_export"))
    require(isinstance(manifest["chunks"], list) and len(manifest["chunks"]) == (manifest["file_bytes"] + CHUNK_BYTES - 1) // CHUNK_BYTES)
    for index, item in enumerate(manifest["chunks"]):
        fields(item, ("index", "offset", "bytes", "sha256"))
        require(item["index"] == index and item["offset"] == index * CHUNK_BYTES and
                item["bytes"] == min(CHUNK_BYTES, manifest["file_bytes"] - item["offset"]) and HASH.fullmatch(item["sha256"]))
    data = read_private(job / "segment.bin", MAX_FILE_BYTES)
    require(len(data) == manifest["file_bytes"] and sha(data) == manifest["file_sha256"], "frozen segment changed")
    require(all(sha(data[c["offset"]:c["offset"] + c["bytes"]]) == c["sha256"] for c in manifest["chunks"]), "frozen chunk changed")
    require(identity["local_validation"] == local_validation(data), "local validation changed")
    journal = parse(read_private(job / "journal.json", MAX_REPLY_BYTES))
    fields(journal, ("version", "manifest_sha256", "manifest_accepted", "chunks", "receipt"))
    require(journal["version"] == 1 and journal["manifest_sha256"] == identity["manifest_sha256"] and
            type(journal["manifest_accepted"]) is bool and isinstance(journal["chunks"], dict))
    for key, receipt in journal["chunks"].items():
        require(re.fullmatch(r"0|[1-9][0-9]{0,2}", key) and int(key) < len(manifest["chunks"]))
        check_chunk(receipt, identity, manifest["chunks"][int(key)])
    if journal["receipt"] is not None:
        check_file(journal["receipt"], identity, manifest)
    return identity, manifest, raw, journal


def check_common(value, identity):
    require(value.get("protocol") == PROTOCOL and value.get("node_id") == identity["node_id"] and
            value.get("upload_id") == identity["upload_id"] and value.get("manifest_sha256") == identity["manifest_sha256"],
            "archive receipt identity mismatch")


def timestamp(value):
    require(isinstance(value, str) and len(value) <= 40 and value.endswith("Z"), "invalid receipt time")
    try:
        result = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        raise ArchiveError("invalid receipt time") from None
    return result


def check_chunk(value, identity, chunk):
    fields(value, ("protocol", "node_id", "upload_id", "manifest_sha256", "index", "offset", "bytes", "sha256",
                   "receipt_id", "received_at", "scope", "durability"))
    check_common(value, identity)
    require(value["scope"] == "chunk" and value["durability"] == "committed" and
            all(integer(value[key]) for key in ("index", "offset", "bytes")) and
            all(value[key] == chunk[key] for key in ("index", "offset", "bytes", "sha256")) and
            UUID.fullmatch(value["receipt_id"]), "chunk receipt does not confirm exact durable bytes")
    timestamp(value["received_at"])


def check_file(value, identity, manifest):
    fields(value, ("protocol", "node_id", "upload_id", "archive_policy_id", "manifest_sha256", "file_sha256", "file_bytes",
                   "chunk_count", "scope", "durability", "receipt_id", "received_at", "expires_at", "validation"))
    check_common(value, identity)
    require(value["scope"] == "file" and value["durability"] == "committed" and
            value["archive_policy_id"] == manifest["archive_policy_id"] and
            value["file_sha256"] == manifest["file_sha256"] and value["file_bytes"] == manifest["file_bytes"] and
            integer(value["file_bytes"]) and integer(value["chunk_count"], maximum=257) and
            value["chunk_count"] == len(manifest["chunks"]) and UUID.fullmatch(value["receipt_id"]),
            "file receipt does not confirm exact durable bytes")
    require(timestamp(value["expires_at"]) > timestamp(value["received_at"]), "invalid retention receipt")
    validation = value["validation"]
    fields(validation, ("status", "parser_version", "valid_bytes", "truncated_offset", "reports"))
    require(validation["parser_version"] == PARSER_VERSION and
            validation["status"] == identity["local_validation"]["status"] and
            integer(validation["valid_bytes"], maximum=manifest["file_bytes"]), "CPRAW validation disagrees with frozen input")
    if validation["status"] == "invalid":
        require(validation["reports"] is None and validation["truncated_offset"] is None)
    else:
        require(integer(validation["reports"]) and
                all(validation[key] == identity["local_validation"][key] for key in ("valid_bytes", "truncated_offset", "reports")),
                "CPRAW validation disagrees with frozen input")


@dataclass
class Reply:
    status: int
    headers: dict
    body: bytes


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, newurl):
        return None


class HttpTransport:
    """Direct verified HTTPS; proxy inheritance and credential-bearing redirects are disabled."""
    def __init__(self, timeout=20):
        require(integer(timeout, 1, 60), "timeout must be 1..60 seconds")
        self.timeout = timeout
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def request(self, method, url, body, headers):
        request = urllib.request.Request(url, data=body if method != "GET" else None, method=method, headers=headers)
        try:
            response = self.opener.open(request, timeout=self.timeout)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read(MAX_REPLY_BYTES + 1)
            require(len(data) <= MAX_REPLY_BYTES, "archive response exceeds bound")
            return Reply(response.status, {key.lower(): value for key, value in response.headers.items()}, data)


def exchange(transport, method, url, body, headers, attempts, sleep):
    for attempt in range(attempts):
        try:
            reply = transport.request(method, url, body, headers)
        except (OSError, urllib.error.URLError):
            if attempt + 1 == attempts:
                raise ArchiveError("archive transport unconfirmed; resume the same spool identity") from None
            sleep(min(30, 2 ** attempt + random.random()))
            continue
        require(len(reply.body) <= MAX_REPLY_BYTES and not reply.headers.get("content-encoding"), "invalid archive response encoding/size")
        require(reply.headers.get("content-type", "").split(";")[0].lower() == "application/json" and
                "no-store" in reply.headers.get("cache-control", "").lower(), "archive response must be private JSON")
        value = parse(reply.body)
        if reply.status in (200, 202):
            return reply.status, value
        retryable = isinstance(value, dict) and isinstance(value.get("error"), dict) and value["error"].get("retryable") is True
        if reply.status not in (429, 500, 502, 503, 504) or not retryable or attempt + 1 == attempts:
            raise ArchiveError(f"archive request rejected or unconfirmed (HTTP {reply.status}); retain local copies")
        retry_after = reply.headers.get("retry-after", "")
        delay = min(30, 2 ** attempt + random.random())
        if retry_after:
            require(re.fullmatch(r"[0-9]{1,3}", retry_after) and int(retry_after) <= 60, "retry delay exceeds host budget")
            delay = max(delay, int(retry_after))
        sleep(delay)
    raise ArchiveError("request budget exhausted")


def upload(spool, upload_id, token, *, transport=None, attempts=3, polls=3, sleep=time.sleep):
    require(isinstance(upload_id, str) and UUID.fullmatch(upload_id), "invalid spool identity")
    require(isinstance(token, str) and 1 <= len(token) <= 4096 and all(33 <= ord(c) <= 126 for c in token), "invalid bearer credential")
    require(integer(attempts, 1, 8) and integer(polls, 1, 8), "retry bounds must be 1..8")
    root = private_directory(spool)
    job = private_directory(root / upload_id)
    with locked(job / ".lock"):
        identity, manifest, raw, journal = load_job(job)
        client = transport if transport is not None else HttpTransport()
        base = identity["origin"] + "/api/v1/cpraw/uploads/" + upload_id
        common = {"Authorization": "Bearer " + token, "Cache-Control": "no-store"}

        def request(method, suffix="", body=b"", headers=None):
            return exchange(client, method, base + suffix, body, {**common, **(headers or {})}, attempts, sleep)

        def accept_final(receipt):
            check_file(receipt, identity, manifest)
            require(journal["receipt"] is None or journal["receipt"] == receipt, "final receipt changed on retry")
            journal["receipt"] = receipt
            write_journal(job, journal)
            return receipt

        def envelope(value, scope=None):
            expected = ("protocol", "node_id", "upload_id", "archive_policy_id", "manifest_sha256", "state", "receipt",
                        "scope" if scope else "chunks")
            fields(value, expected)
            check_common(value, identity)
            require(value["archive_policy_id"] == manifest["archive_policy_id"] and value["state"] in ("open", "committed"))
            if scope:
                require(value["scope"] == scope)
            require((value["state"] == "committed") == (value["receipt"] is not None), "unconfirmed final custody")

        code, state = request("PUT", body=raw, headers={"Content-Type": "application/json", "X-Body-SHA256": identity["manifest_sha256"]})
        require(code == 200, "manifest is not durably frozen")
        envelope(state, "manifest")
        journal["manifest_accepted"] = True
        write_journal(job, journal)
        if state["receipt"] is not None:
            return accept_final(state["receipt"])
        require(journal["receipt"] is None, "server lost a previously committed final receipt")
        code, state = request("GET")
        require(code == 200)
        envelope(state)
        require(isinstance(state["chunks"], list) and len(state["chunks"]) <= len(manifest["chunks"]))
        found = {}
        for receipt in state["chunks"]:
            index = receipt.get("index") if isinstance(receipt, dict) else None
            require(integer(index, maximum=len(manifest["chunks"]) - 1) and str(index) not in found, "invalid status chunk index")
            check_chunk(receipt, identity, manifest["chunks"][index])
            key = str(index)
            require(key not in journal["chunks"] or journal["chunks"][key] == receipt, "committed chunk receipt changed")
            found[key] = receipt
        require(set(journal["chunks"]) <= set(found), "server lost a previously committed chunk receipt")
        journal["chunks"] = found
        write_journal(job, journal)
        if state["receipt"] is not None:
            return accept_final(state["receipt"])
        with os.fdopen(private_open(job / "segment.bin"), "rb") as original:
            for chunk in manifest["chunks"]:
                key = str(chunk["index"])
                if key in journal["chunks"]:
                    continue
                original.seek(chunk["offset"])
                body = original.read(chunk["bytes"])
                require(len(body) == chunk["bytes"] and sha(body) == chunk["sha256"], "frozen chunk changed before request")
                code, receipt = request("PUT", "/chunks/" + key, body, {"Content-Type": "application/octet-stream",
                    "X-Body-SHA256": chunk["sha256"], "X-Manifest-SHA256": identity["manifest_sha256"]})
                require(code == 200, "chunk custody is unconfirmed")
                check_chunk(receipt, identity, chunk)
                journal["chunks"][key] = receipt
                write_journal(job, journal)
        for _ in range(polls):
            code, receipt = request("POST", "/commit", headers={"X-Manifest-SHA256": identity["manifest_sha256"]})
            if code == 200:
                return accept_final(receipt)
            require(receipt == {"state": "verifying"}, "unexpected uncommitted verification response")
            sleep(1)
            code, state = request("GET")
            require(code == 200)
            envelope(state)
            if state["receipt"] is not None:
                return accept_final(state["receipt"])
        raise ArchiveError("verification remains unconfirmed; resume the same spool identity")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spool", required=True, type=Path, help="private0700 spool directory")
    sub = parser.add_subparsers(dest="operation", required=True)
    prepare_parser = sub.add_parser("prepare", help="offline snapshot only")
    prepare_parser.add_argument("file", type=Path)
    prepare_parser.add_argument("--origin", required=True)
    prepare_parser.add_argument("--node", required=True)
    prepare_parser.add_argument("--policy", required=True)
    prepare_parser.add_argument("--source", choices=("tf_card_copy", "usb_export"), default="tf_card_copy")
    prepare_parser.add_argument("--allow-loopback-http", action="store_true")
    upload_parser = sub.add_parser("upload", help="explicit network operation using only the frozen spool")
    upload_parser.add_argument("upload_id")
    upload_parser.add_argument("--token-file", type=Path)
    upload_parser.add_argument("--attempts", type=int, default=3)
    upload_parser.add_argument("--polls", type=int, default=3)
    args = parser.parse_args(argv)
    try:
        if args.operation == "prepare":
            upload_id = prepare(args.file, args.spool, origin=args.origin, node=args.node, policy=args.policy,
                source=args.source, allow_loopback_http=args.allow_loopback_http)
            print(json.dumps({"upload_id": upload_id, "prepared": True, "uploaded": False, "local_copies_preserved": True}))
        else:
            token = read_private(args.token_file, 4096).decode().strip() if args.token_file else os.environ.get("CPRAW_DEVICE_TOKEN", "")
            receipt = upload(args.spool, args.upload_id, token, attempts=args.attempts, polls=args.polls)
            print(json.dumps({"upload_id": args.upload_id, "scope": receipt["scope"], "durability": receipt["durability"],
                              "validation_status": receipt["validation"]["status"], "local_copies_preserved": True}))
    except KeyboardInterrupt:
        print("archive_uploader: interrupted; preserve originals and resume the same spool identity", file=sys.stderr)
        return 130
    except Exception:
        # Do not echo paths, URLs, credentials, response bodies or untrusted errors.
        print("archive_uploader: operation unconfirmed; preserve local copies and inspect configuration", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
