"""Offline provisioning security/contract tests; no broker or real credentials."""

import csv
import json
import os
import re
import stat
from pathlib import Path

import pytest

from cp_emqx_relay import provision


def read_csv(path):
    with path.open(newline="") as source:
        return list(csv.DictReader(source))


def test_private_bundle_has_independent_credentials_and_scoped_rules(tmp_path, capsys):
    bundle = tmp_path / "bundle"
    assert (
        provision.main(
            ["--nodes", "sensor1,sensor2", "--relay-username", "relay1", "--out-dir", str(bundle)]
        )
        == 0
    )
    captured = capsys.readouterr()
    assert captured.err == ""
    assert json.loads(captured.out) == {
        "device_count": 2,
        "credential_count": 3,
        "bundle_directory": str(bundle),
    }
    auth = read_csv(bundle / "authentication.csv")
    assert {row["username"] for row in auth} == {"sensor1", "sensor2", "relay1"}
    passwords = {row["password"] for row in auth}
    assert len(passwords) == 3
    assert all(re.fullmatch(r"[A-Za-z0-9_-]{43}", password) for password in passwords)
    for private_value in passwords | {"sensor1", "sensor2", "relay1", "cp/v1/"}:
        assert private_value not in captured.out + captured.err

    manifest = json.loads((bundle / "manifest.json").read_text())
    assert {entry["node_id"] for entry in manifest["nodes"]} == {"sensor1", "sensor2"}
    for entry in manifest["nodes"]:
        material = json.loads((bundle / entry["credential_file"]).read_text())
        assert material["node_id"] == material["mqtt_username"] == entry["node_id"]
        assert material["mqtt_password"] in passwords
        assert set(material) == {
            "schema_version",
            "kind",
            "node_id",
            "mqtt_username",
            "mqtt_password",
        }
    relay = json.loads((bundle / manifest["relay_credential_file"]).read_text())
    assert relay["mqtt_username"] == "relay1" and relay["mqtt_password"] in passwords
    assert "node_id" not in relay

    rules = read_csv(bundle / "authorization.csv")
    assert len(rules) == 11
    actual = {(r["username"], r["topic"], r["action"], r["access"]) for r in rules}
    for node in ("sensor1", "sensor2"):
        request, reply = f"cp/v1/{node}/+/req/+/+", f"cp/v1/{node}/+/rep/+/+"
        assert (node, request, "pub", "allow") in actual
        assert (node, reply, "sub", "allow") in actual
        assert ("relay1", request, "sub", "allow") in actual
        assert ("relay1", reply, "pub", "allow") in actual
    for username in ("sensor1", "sensor2", "relay1"):
        own = [r for r in rules if r["username"] == username]
        assert own[-1] == {"username": username, "topic": "#", "action": "pubsub", "access": "deny"}
        assert all(r["access"] == "allow" and "#" not in r["topic"] for r in own[:-1])
    plan = json.loads((bundle / "authorization-plan.json").read_text())
    assert plan["state"] == "not_applied"
    assert plan["global_changes"] is False
    assert plan["scope"] == "generated_usernames_only"
    assert plan["per_user_fallback"] == {"topic": "#", "action": "pubsub", "access": "deny"}
    for password in passwords:
        assert password not in json.dumps(manifest) + json.dumps(plan)
    assert stat.S_IMODE(bundle.stat().st_mode) == 0o700
    assert all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in bundle.iterdir())


def test_device_only_bundle_does_not_create_a_relay_identity(tmp_path):
    bundle = tmp_path / "bundle"
    provision.generate_bundle(("sensor1",), bundle)
    assert len(read_csv(bundle / "authentication.csv")) == 1
    assert len(read_csv(bundle / "authorization.csv")) == 3
    assert not (bundle / "relay-credential.json").exists()
    assert "relay_credential_file" not in json.loads((bundle / "manifest.json").read_text())


@pytest.mark.parametrize(
    "nodes",
    [
        (),
        ("sensor1", "sensor1"),
        ("",),
        ("sensor+",),
        ("#",),
        ("a/b",),
        ("UPPER",),
        ("space here",),
        ("a\n",),
        ("x" * 16,),
        ("../outside",),
        tuple(f"n{number}" for number in range(17)),
    ],
)
def test_invalid_nodes_reject_before_creating_output(tmp_path, nodes):
    bundle = tmp_path / "bundle"
    with pytest.raises(provision.ProvisionError):
        provision.generate_bundle(nodes, bundle)
    assert not bundle.exists()


@pytest.mark.parametrize("relay", ["sensor1", "relay/+", "", "x" * 16])
def test_relay_identity_cannot_conflict_or_inject_topics(tmp_path, relay):
    with pytest.raises(provision.ProvisionError):
        provision.generate_bundle(("sensor1",), tmp_path / "bundle", relay)
    assert not (tmp_path / "bundle").exists()


def test_rerun_preserves_every_existing_byte_and_does_not_rotate(tmp_path, capsys):
    bundle = tmp_path / "bundle"
    provision.generate_bundle(("sensor1",), bundle)
    before = {path.name: path.read_bytes() for path in bundle.iterdir()}
    assert provision.main(["--nodes", "sensor2", "--out-dir", str(bundle)]) == 2
    assert "no overwrite or credential rotation" in capsys.readouterr().err
    assert before == {path.name: path.read_bytes() for path in bundle.iterdir()}
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(FileExistsError):
        provision.generate_bundle(("sensor1",), empty)
    assert list(empty.iterdir()) == []


def test_symlinked_ancestor_and_existing_symlink_are_rejected(tmp_path):
    private = tmp_path / "private"
    private.mkdir(mode=0o700)
    alias = tmp_path / "alias"
    alias.symlink_to(private, target_is_directory=True)
    with pytest.raises(OSError):
        provision.generate_bundle(("sensor1",), alias / "bundle")
    assert not (private / "bundle").exists()
    target = private / "target"
    target.write_text("preserve this")
    (private / "bundle").symlink_to(target)
    with pytest.raises(FileExistsError):
        provision.generate_bundle(("sensor1",), private / "bundle")
    assert target.read_text() == "preserve this"


@pytest.mark.parametrize("mode", [0o770, 0o707, 0o777])
def test_writable_parent_is_rejected(tmp_path, mode):
    parent = tmp_path / "unsafe"
    parent.mkdir()
    parent.chmod(mode)
    with pytest.raises(provision.ProvisionError):
        provision.generate_bundle(("sensor1",), parent / "bundle")
    assert not (parent / "bundle").exists()


def test_foreign_owned_parent_is_rejected(tmp_path, monkeypatch):
    actual_uid = os.geteuid()
    monkeypatch.setattr(provision.os, "geteuid", lambda: actual_uid + 1)
    with pytest.raises(provision.ProvisionError):
        provision.generate_bundle(("sensor1",), tmp_path / "bundle")
    assert not (tmp_path / "bundle").exists()


def test_relative_and_parent_traversal_paths_are_rejected(tmp_path):
    for path in (Path("relative-bundle"), tmp_path / ".." / "bundle", Path("/")):
        with pytest.raises(provision.ProvisionError):
            provision.generate_bundle(("sensor1",), path)


def test_cli_failure_does_not_echo_invalid_identity(tmp_path, capsys):
    invalid = "never-print-this/#"
    assert provision.main(["--nodes", invalid, "--out-dir", str(tmp_path / "bundle")]) == 2
    output = capsys.readouterr()
    assert output.out == "" and invalid not in output.err
