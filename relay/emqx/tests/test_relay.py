"""Synthetic tests: no DNS, sockets, broker subscription or production credentials."""

import asyncio
import hashlib
import json
import ssl
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

import cp_emqx_relay as relay

BOOT = "12345678-1234-4123-8123-123456789abc"
OLD_BOOT = "87654321-4321-4321-8321-cba987654321"


@pytest.fixture
def config(tmp_path):
    return relay.Config(
        "synthetic.example.invalid",
        "relay-user-synthetic",
        "broker-password-synthetic",
        {"node1": "cf-token-one-synthetic", "node2": "cf-token-two-synthetic"},
        tmp_path / "journal.sqlite",
    )


def request(config, op="config", rpc=1, node="node1", body=None, boot=BOOT):
    if body is None:
        body = b"" if op == "config" else json.dumps({"boot_id": boot, "node_id": node}).encode()
    return relay.Request.parse(f"cp/v1/{node}/{boot}/req/{op}/{rpc}", body, config.nodes)


class Chunks(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk


def response(status=200, body=b'{"receipt":"synthetic-cf-result"}', **kwargs):
    return httpx.Response(status, stream=Chunks([body]), **kwargs)


def test_private_config_and_strict_schema(tmp_path):
    example = (Path(__file__).resolve().parents[1] / "config.example.json").read_text()
    private = tmp_path / "private.json"
    private.write_text(example)
    private.chmod(0o644)
    with pytest.raises(relay.Rejected):
        relay.Config.load(private)
    private.chmod(0o600)
    loaded = relay.Config.load(private)
    assert loaded.broker_port == 8883
    assert loaded.journal_path == tmp_path / "synthetic-state.sqlite"
    assert "password" not in repr(loaded)
    for extra in (
        {"origin": "https://attacker.invalid"},
        {"broker_port": 1883},
        {"cf_proxy": "socks5://localhost:1234"},
        {"workers": True},
        {"nodes": {"node1": "contains newline\n"}},
    ):
        private.write_text(json.dumps({**json.loads(example), **extra}))
        with pytest.raises(relay.Rejected):
            relay.Config.load(private)
    private.write_text(example[:-2] + ', "workers": 3}')
    with pytest.raises(relay.Rejected):
        relay.Config.load(private)
    link = tmp_path / "link.json"
    link.symlink_to(private)
    with pytest.raises(OSError):
        relay.Config.load(link)


def test_tls_never_disables_identity_verification(config):
    context = relay.mqtt_tls(config)
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname
    assert context.minimum_version >= ssl.TLSVersion.TLSv1_2


@pytest.mark.parametrize(
    "suffix",
    [
        "config/0",
        "config/01",
        "config/4294967296",
        "other/1",
        "config/1/extra",
        "config/+",
    ],
)
def test_topic_grammar(config, suffix):
    with pytest.raises(relay.Rejected):
        relay.Request.parse(f"cp/v1/node1/{BOOT}/req/{suffix}", b"", config.nodes)


def test_identity_boundaries_preserve_old_frozen_batches(config):
    frozen = b'{ "node_id": "node1", "boot_id": "' + OLD_BOOT.encode() + b'" }\n'
    req = request(config, "ingest", body=frozen)
    assert req.body == frozen
    assert req.boot == BOOT  # Transport session differs from the frozen batch boot.
    assert req.digest == hashlib.sha256(frozen).hexdigest()
    with pytest.raises(relay.Rejected):
        request(config, "ingest", body=frozen.replace(b"node1", b"node2"))
    with pytest.raises(relay.Rejected):
        request(config, "contact", body=frozen)
    with pytest.raises(relay.Rejected):
        request(config, node="unknown")
    for qos, retained in ((0, False), (2, False), (1, True)):
        with pytest.raises(relay.Rejected):
            relay.Request.parse(req.topic, frozen, config.nodes, qos, retained)
    with pytest.raises(relay.Rejected):
        request(config, "config", body=b"{}")
    with pytest.raises(relay.Rejected):
        request(config, "ingest", body=b'{"node_id":"node1","node_id":"node2"}')
    exact = frozen + b" " * (relay.MAX_REQUEST - len(frozen))
    assert request(config, "ingest", body=exact).body == exact
    with pytest.raises(relay.Rejected):
        request(config, "ingest", body=exact + b" ")


def test_fixed_paths_exact_bytes_and_auth_isolation(config):
    seen = []

    async def handler(req):
        seen.append(req)
        return response(409, b' {"error":"synthetic_conflict"}\n')

    async def scenario():
        forwarder = relay.Forwarder(config, transport=httpx.MockTransport(handler))
        try:
            for node in config.nodes:
                for op, path in relay.PATHS.items():
                    req = request(config, op, node=node)
                    status, body, unknown = await forwarder.forward(req)
                    assert (status, body, unknown) == (
                        409,
                        b' {"error":"synthetic_conflict"}\n',
                        False,
                    )
                    sent = seen[-1]
                    assert str(sent.url) == relay.ORIGIN + path
                    assert sent.method == ("GET" if op == "config" else "POST")
                    assert sent.content == req.body
                    assert sent.headers["authorization"] == "Bearer " + config.nodes[node]
                    assert config.mqtt_password not in str(sent.headers)
                    assert "forwarded" not in sent.headers and "forwardauth" not in sent.headers
                    if op == "ingest":
                        assert sent.headers["x-body-sha256"] == hashlib.sha256(req.body).hexdigest()
                    else:
                        assert "x-body-sha256" not in sent.headers
            assert seen[0].headers["authorization"] != seen[-1].headers["authorization"]
        finally:
            await forwarder.close()

    asyncio.run(scenario())


def test_redirect_is_not_followed_and_prefix_is_unchanged(config):
    seen = []

    async def handler(req):
        seen.append(req)
        return response(
            307,
            b'{"synthetic":"redirect"}',
            headers={"location": "https://attacker.example.invalid/collect"},
        )

    async def scenario():
        forwarder = relay.Forwarder(config, transport=httpx.MockTransport(handler))
        try:
            status, body, unknown = await forwarder.forward(request(config))
            assert not unknown and len(seen) == 1
            assert relay.envelope(status, body) == b'\x013{"synthetic":"redirect"}'
        finally:
            await forwarder.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("mode", ["deadline", "transport", "overflow", "compressed"])
def test_unknown_is_an_error_never_a_receipt(config, mode):
    async def handler(req):
        if mode == "deadline":
            await asyncio.sleep(10)
        if mode == "transport":
            raise httpx.ReadError("synthetic-sensitive-url-must-not-be-logged")
        if mode == "compressed":
            return response(headers={"content-encoding": "gzip"})
        return response(body=b"x" * (relay.MAX_RESPONSE + 1))

    async def scenario():
        fast = replace(config, timeout_seconds=0.01)
        forwarder = relay.Forwarder(fast, transport=httpx.MockTransport(handler))
        try:
            result = await forwarder.forward(request(config))
            assert result == (504, relay.UNKNOWN, True)
            assert relay.envelope(*result[:2]) == b"\x01\xf8" + relay.UNKNOWN
        finally:
            await forwarder.close()

    asyncio.run(scenario())


def test_journal_duplicate_conflict_restart_and_boot_bounds(config, monkeypatch):
    monkeypatch.setattr(relay, "MAX_BOOTS", 2)
    journal = relay.Journal(config.journal_path)
    req = request(config)
    journal.begin(req)
    journal.close()  # Crash before response: a future process must not invent success.
    journal = relay.Journal(config.journal_path)
    assert journal.db.execute("SELECT state,status,response FROM rpc").fetchone() == (
        "outcome_unknown",
        None,
        None,
    )
    journal.begin(req)
    journal.finish(req, 200, b'{"synthetic":"cf"}')
    journal.begin(req)  # Latest exact retry is accepted independent of broker mid/DUP.
    with pytest.raises(relay.Rejected):
        journal.begin(request(config, "contact"))
    journal.begin(request(config, rpc=2))
    with pytest.raises(relay.Rejected):
        journal.begin(req)
    journal.begin(request(config, boot=OLD_BOOT))
    with pytest.raises(relay.Rejected):
        journal.begin(request(config, boot="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
    assert journal.db.execute("SELECT count(*) FROM rpc").fetchone()[0] == 2
    assert config.journal_path.stat().st_mode & 0o777 == 0o600
    journal.close()


def test_exclusive_journal_and_byte_conflict(config):
    journal = relay.Journal(config.journal_path)
    try:
        with pytest.raises(relay.Rejected, match="journal_already_open"):
            relay.Journal(config.journal_path)
        frozen = request(config, "ingest")
        journal.begin(frozen)
        changed = request(config, "ingest", body=frozen.body + b"\n")
        with pytest.raises(relay.Rejected, match="rpc_conflict"):
            journal.begin(changed)
    finally:
        journal.close()


def test_rate_limit_and_response_exact_maximum(config):
    async def scenario():
        engine = relay.Engine(
            config, relay.Journal(config.journal_path), relay.Forwarder(config), lambda *_: None
        )
        try:
            engine.rates["node1"] = (relay.time.monotonic(), 600, 0)
            assert not engine.submit(request(config))
            assert not engine.pending
            engine.rates["node1"] = (relay.time.monotonic() - 61, 600, 0)
            assert engine.submit(request(config))
        finally:
            await engine.close()

    asyncio.run(scenario())
    body = b"x" * relay.MAX_RESPONSE
    assert relay.envelope(200, body) == b"\x00\xc8" + body
    with pytest.raises(relay.Rejected):
        relay.envelope(200, body + b"x")


def test_check_cli_is_offline_and_does_not_create_journal(tmp_path, monkeypatch, capsys):
    private = tmp_path / "private.json"
    private.write_text((Path(__file__).resolve().parents[1] / "config.example.json").read_text())
    private.chmod(0o600)
    monkeypatch.setattr(sys, "argv", ["cp-emqx-relay", "--config", str(private), "--check"])
    monkeypatch.setattr(relay, "run", lambda _: pytest.fail("--check must not run bridge"))
    relay.main()
    assert not (tmp_path / "synthetic-state.sqlite").exists()
    assert capsys.readouterr().out == '{"event": "config_valid"}\n'


def test_pending_duplicate_queue_bounds_parallel_nodes_and_fresh_config(config):
    async def scenario():
        gate, two_started = asyncio.Event(), asyncio.Event()
        calls = []
        replies = []

        async def handler(req):
            calls.append(req)
            if len(calls) == 2:
                two_started.set()
            await gate.wait()
            return response(body=json.dumps({"synthetic_lease": len(calls)}).encode())

        forwarder = relay.Forwarder(config, transport=httpx.MockTransport(handler))
        engine = relay.Engine(
            config,
            relay.Journal(config.journal_path),
            forwarder,
            lambda *args: replies.append(args),
        )
        engine.start()
        try:
            req = request(config)
            assert engine.submit(req)
            assert not engine.submit(req)
            assert not engine.submit(request(config, rpc=2))
            assert engine.submit(request(config, node="node2"))
            await asyncio.wait_for(two_started.wait(), 1)
            assert len(calls) == 2  # Different nodes run concurrently.
            gate.set()
            await asyncio.wait_for(engine.queue.join(), 1)
            assert engine.submit(req)  # Completed duplicate config must fetch a fresh CF lease.
            await asyncio.wait_for(engine.queue.join(), 1)
            assert len(calls) == 3
            assert replies[0][0] == req.reply_topic
            assert replies[0][1][:2] == b"\x00\xc8"
            assert replies[-1][1] != replies[0][1]
        finally:
            await engine.close()

    asyncio.run(scenario())


def test_queue_full_and_auth_revocation(config):
    async def scenario():
        small = replace(config, queue_size=1, workers=1)
        forwarded = []

        async def handler(req):
            forwarded.append(req)
            return response(403, b'{"error":"synthetic_forbidden"}')

        engine = relay.Engine(
            small,
            relay.Journal(config.journal_path),
            relay.Forwarder(small, transport=httpx.MockTransport(handler)),
            lambda *_: None,
        )
        try:
            assert engine.submit(request(config))
            assert not engine.submit(request(config, node="node2"))
            engine.start()
            await asyncio.wait_for(engine.queue.join(), 1)
            assert not engine.submit(request(config, rpc=2))
            assert len(forwarded) == 1
        finally:
            await engine.close()

    asyncio.run(scenario())


def test_mock_mqtt_limits_credentials_topics_and_safe_logs(config, monkeypatch, capsys):
    class Client:
        def __init__(self, *args, **kwargs):
            self.kwargs, self.subscriptions, self.sent, self.acks = kwargs, [], [], []

        def username_pw_set(self, username, password):
            self.credentials = (username, password)

        def tls_set_context(self, context):
            self.context = context

        def max_queued_messages_set(self, _):
            pass

        def max_inflight_messages_set(self, _):
            pass

        def reconnect_delay_set(self, *_):
            pass

        def is_connected(self):
            return True

        def subscribe(self, topic, qos):
            self.subscriptions.append((topic, qos))
            return relay.mqtt.MQTT_ERR_SUCCESS, len(self.subscriptions)

        def publish(self, topic, body, **kwargs):
            self.sent.append((topic, body, kwargs))
            return SimpleNamespace(rc=relay.mqtt.MQTT_ERR_SUCCESS, mid=len(self.sent))

        def ack(self, mid, qos):
            self.acks.append((mid, qos))

    monkeypatch.setattr(relay.mqtt, "Client", Client)

    async def scenario():
        engine = SimpleNamespace(submit=lambda _: True)
        bridge = relay.Bridge(config, asyncio.get_running_loop(), engine)
        client = bridge.client
        assert client.credentials == (config.mqtt_username, config.mqtt_password)
        assert all(token not in client.credentials for token in config.nodes.values())
        bridge.on_connect(client, None, None, SimpleNamespace(is_failure=False), None)
        assert client.subscriptions == [(f"cp/v1/{node}/+/req/+/+", 1) for node in config.nodes]
        req = request(config)
        message = SimpleNamespace(topic=req.topic, payload=req.body, qos=1, retain=False, mid=7)
        bridge.on_message(client, None, message)
        await asyncio.sleep(0)
        assert client.acks == [(7, 1)]
        bridge.publish(req.reply_topic, relay.envelope(200, b"{}"))
        assert client.sent == [(req.reply_topic, b"\x00\xc8{}", {"qos": 0, "retain": False})]
        bridge.on_publish(client, None, 1, None, None)
        await asyncio.sleep(0)
        assert not bridge.publications

    asyncio.run(scenario())
    logs = capsys.readouterr().out
    assert config.mqtt_username not in logs and config.mqtt_password not in logs
    assert BOOT not in logs and "node1" not in logs
    assert all(token not in logs for token in config.nodes.values())
