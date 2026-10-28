"""Generate private, offline MQTT credential/import material; never contact a broker."""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import secrets
import stat
import sys
from pathlib import Path

IDENTITY = re.compile(r"[a-z0-9_-]{1,15}\Z")
MAX_NODES = 16


class ProvisionError(ValueError):
    """Static, safe-to-print rejection without credential or identity values."""


def validate_nodes(nodes: tuple[str, ...]) -> None:
    if not 1 <= len(nodes) <= MAX_NODES:
        raise ProvisionError("device count must be between 1 and 16")
    if any(not IDENTITY.fullmatch(node) for node in nodes):
        raise ProvisionError("invalid device identity")
    if len(set(nodes)) != len(nodes):
        raise ProvisionError("duplicate device identity")


def _open_parent(path: Path) -> int:
    """Walk without following symlinks; return an anchored, private parent FD."""
    if not path.is_absolute() or ".." in path.parts or path == Path("/"):
        raise ProvisionError("output must be an absolute new directory path")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open("/", flags)
    try:
        # System-owned, sticky temporary ancestors are allowed. The immediate
        # parent must still be user-owned and not group/other-writable.
        for part in path.parent.parts[1:]:
            child = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = child
            info = os.fstat(directory)
            sticky_system = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
            if info.st_uid not in (0, os.geteuid()) or (info.st_mode & 0o022 and not sticky_system):
                raise ProvisionError("unsafe output ancestor")
        parent = os.fstat(directory)
        if parent.st_uid != os.geteuid() or parent.st_mode & 0o022:
            raise ProvisionError("output parent must be user-owned and not group/other-writable")
        return directory
    except BaseException:
        os.close(directory)
        raise


def _write_private(directory: int, filename: str, content: str) -> None:
    descriptor = os.open(
        filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory
    )
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(content)
        output.flush()
        os.fsync(output.fileno())


def _json(value: object) -> str:
    return json.dumps(value, indent=2, ensure_ascii=True) + "\n"


def _csv(columns: tuple[str, ...], rows: list[tuple[str, ...]]) -> str:
    result = io.StringIO(newline="")
    writer = csv.writer(result)
    writer.writerow(columns)
    writer.writerows(rows)
    return result.getvalue()


def generate_bundle(
    nodes: tuple[str, ...], out_dir: Path, relay_username: str | None = None
) -> dict[str, int | str]:
    """Create a new bundle, returning only safe counts and the directory path.

    Existing directories are always rejected, including empty ones. This is
    deliberately not a rotation or incremental registry operation.
    """
    validate_nodes(nodes)
    if relay_username is not None and (
        not IDENTITY.fullmatch(relay_username) or relay_username in nodes
    ):
        raise ProvisionError("invalid or conflicting relay identity")
    out_dir = Path(out_dir)
    parent = _open_parent(out_dir)
    directory = None
    try:
        os.mkdir(out_dir.name, 0o700, dir_fd=parent)
        directory = os.open(
            out_dir.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent
        )
        os.fchmod(directory, 0o700)
        auth_rows: list[tuple[str, ...]] = []
        acl_rows: list[tuple[str, ...]] = []
        manifest: dict[str, object] = {"schema_version": 1, "nodes": []}
        issued: set[str] = set()

        def issue(username: str, filename: str, node: str | None = None) -> None:
            password = secrets.token_urlsafe(32)
            while password in issued:
                password = secrets.token_urlsafe(32)
            issued.add(password)
            auth_rows.append((username, password))
            material = {
                "schema_version": 1,
                "kind": "mqtt-runtime-provisioning-material",
                "mqtt_username": username,
                "mqtt_password": password,
            }
            if node is not None:
                material["node_id"] = node
            _write_private(directory, filename, _json(material))

        entries = []
        for node in nodes:
            filename = f"device-{node}.json"
            issue(node, filename, node)
            entries.append({"node_id": node, "credential_file": filename})
            request = f"cp/v1/{node}/+/req/+/+"
            reply = f"cp/v1/{node}/+/rep/+/+"
            acl_rows.extend(((node, request, "pub", "allow"), (node, reply, "sub", "allow")))
            acl_rows.append((node, "#", "pubsub", "deny"))
            if relay_username is not None:
                acl_rows.extend(
                    (
                        (relay_username, request, "sub", "allow"),
                        (relay_username, reply, "pub", "allow"),
                    )
                )
        manifest["nodes"] = entries
        if relay_username is not None:
            issue(relay_username, "relay-credential.json")
            manifest["relay_credential_file"] = "relay-credential.json"
            acl_rows.append((relay_username, "#", "pubsub", "deny"))
        _write_private(directory, "authentication.csv", _csv(("username", "password"), auth_rows))
        _write_private(
            directory,
            "authorization.csv",
            _csv(("username", "topic", "action", "access"), acl_rows),
        )
        _write_private(
            directory,
            "authorization-plan.json",
            _json(
                {
                    "schema_version": 1,
                    "state": "not_applied",
                    "import_template_review_required": True,
                    "scope": "generated_usernames_only",
                    "global_changes": False,
                    "per_user_fallback": {"topic": "#", "action": "pubsub", "access": "deny"},
                    "manual_review": [
                        "Do not change All Users rules; each generated username has its own deny.",
                        "Review rule precedence and remove conflicting broad existing allows.",
                        "Verify scoped allows precede the catch-all deny in this deployment.",
                        "Verify cross-node, reverse-direction and unlisted-topic rejection.",
                        "Review broker QoS, retained-message and packet limits separately.",
                        "No account, ACL, device storage or administrator role was changed.",
                    ],
                }
            ),
        )
        # Written last: a partial bundle without a manifest is not ready for review/import.
        _write_private(directory, "manifest.json", _json(manifest))
        os.fsync(directory)
        os.fsync(parent)
    finally:
        if directory is not None:
            os.close(directory)
        os.close(parent)
    return {
        "device_count": len(nodes),
        "credential_count": len(nodes) + int(relay_username is not None),
        "bundle_directory": str(out_dir),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nodes", required=True, help="comma-separated new device identities")
    parser.add_argument(
        "--out-dir", required=True, type=Path, help="new absolute private directory"
    )
    parser.add_argument("--relay-username", help="optional independent scoped relay identity")
    arguments = parser.parse_args(argv)
    try:
        result = generate_bundle(
            tuple(arguments.nodes.split(",")), arguments.out_dir, arguments.relay_username
        )
    except ProvisionError as error:
        print(str(error), file=sys.stderr)
        return 2
    except FileExistsError:
        print(
            "output already exists; no overwrite or credential rotation performed", file=sys.stderr
        )
        return 2
    except OSError:
        print(
            "bundle generation failed; keep any partial directory private and do not import it",
            file=sys.stderr,
        )
        return 2
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
