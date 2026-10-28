"""Local verification bridge. Only an unchanged CF response can establish CF commit."""

from __future__ import annotations

import argparse
import asyncio
import fcntl
import hashlib
import json
import os
import re
import secrets
import signal
import sqlite3
import ssl
import stat
import struct
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import paho.mqtt.client as mqtt

ORIGIN = "https://pulse.anend.net"
PATHS = {
    "contact": "/api/v2/device/contact",
    "config": "/api/v2/device/config",
    "activation": "/api/v2/device/config/ack",
    "ingest": "/api/v2/ingest",
}
NODE = r"[a-z0-9_-]{1,15}"
BOOT = r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
TOPIC = re.compile(
    rf"cp/v1/({NODE})/({BOOT})/req/(contact|config|activation|ingest)/([1-9][0-9]{{0,9}})"
)
MAX_REQUEST = 8192
MAX_RESPONSE = 2048
MAX_NODES = 16
MAX_BOOTS = 64
UNKNOWN = b'{"error":"gateway_outcome_unknown"}'


class Rejected(Exception):
    """Safe enum only; never include configuration, topic, payload or exceptions."""


def event(code: str) -> None:
    # All callers pass static enums, never exception text or any external strings.
    print(json.dumps({"event": code}), flush=True)


def private_open(path: Path, *, create: bool = False) -> int:
    flags = os.O_RDWR | os.O_NOFOLLOW
    if create:
        flags |= os.O_CREAT
    fd = os.open(path, flags, 0o600)
    info = os.fstat(fd)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_uid != os.getuid()
        or info.st_nlink != 1
    ):
        os.close(fd)
        raise Rejected("private_file_required")
    return fd


def strict_json(body: bytes) -> object:
    def pairs(items: list[tuple[str, object]]) -> dict:
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate_key")
            result[key] = value
        return result

    def invalid_constant(_: str) -> None:
        raise ValueError("invalid_constant")

    return json.loads(body, object_pairs_hook=pairs, parse_constant=invalid_constant)


@dataclass(frozen=True)
class Config:
    broker_host: str
    mqtt_username: str = field(repr=False)
    mqtt_password: str = field(repr=False)
    nodes: dict[str, str] = field(repr=False)
    journal_path: Path
    broker_port: int = 8883
    ca_file: str | None = None
    cf_proxy: str | None = field(default=None, repr=False)
    workers: int = 4
    queue_size: int = 16
    timeout_seconds: int = 15

    @classmethod
    def load(cls, path: Path) -> Config:
        with os.fdopen(private_open(path), "rb") as source:
            data = source.read(65537)
        try:
            if len(data) > 65536:
                raise ValueError()
            raw = strict_json(data)
            required = {"broker_host", "mqtt_username", "mqtt_password", "nodes", "journal_path"}
            optional = {
                "broker_port",
                "ca_file",
                "cf_proxy",
                "workers",
                "queue_size",
                "timeout_seconds",
            }
            if (
                not isinstance(raw, dict)
                or not required <= raw.keys()
                or raw.keys() - required - optional
            ):
                raise ValueError()
            host = raw["broker_host"]
            if (
                not isinstance(host, str)
                or len(host) > 253
                or "." not in host
                or not all(
                    re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?", p)
                    for p in host.split(".")
                )
            ):
                raise ValueError()
            for name in ("mqtt_username", "mqtt_password"):
                if not isinstance(raw[name], str) or not 1 <= len(raw[name]) <= 2048:
                    raise ValueError()
            nodes = raw["nodes"]
            if not isinstance(nodes, dict) or not 1 <= len(nodes) <= MAX_NODES:
                raise ValueError()
            for node, token in nodes.items():
                if (
                    not re.fullmatch(NODE, node)
                    or not isinstance(token, str)
                    or not re.fullmatch(r"[\x21-\x7e]{1,2048}", token)
                ):
                    raise ValueError()
                if token in (raw["mqtt_username"], raw["mqtt_password"]):
                    raise ValueError()
            for key, low, high, default in (
                ("broker_port", 8883, 8883, 8883),
                ("workers", 1, 8, 4),
                ("queue_size", 1, 64, 16),
                ("timeout_seconds", 1, 15, 15),
            ):
                value = raw.get(key, default)
                if type(value) is not int or not low <= value <= high:
                    raise ValueError()
            if "cf_proxy" in raw:
                if not isinstance(raw["cf_proxy"], str):
                    raise ValueError()
                proxy = urlsplit(raw["cf_proxy"])
                if (
                    proxy.scheme not in ("http", "https")
                    or not proxy.hostname
                    or proxy.query
                    or proxy.fragment
                ):
                    raise ValueError()
            for key in ("journal_path", "ca_file"):
                if key in raw:
                    if not isinstance(raw[key], str) or not raw[key]:
                        raise ValueError()
                    value = Path(raw[key]).expanduser()
                    resolved = value if value.is_absolute() else path.absolute().parent / value
                    raw[key] = resolved if key == "journal_path" else str(resolved)
            return cls(**raw)
        except (ValueError, TypeError, KeyError, RecursionError) as exc:
            raise Rejected("invalid_config") from exc


@dataclass(frozen=True)
class Request:
    node: str
    boot: str
    op: str
    rpc: int
    topic: str
    body: bytes = field(repr=False)
    digest: str

    @property
    def reply_topic(self) -> str:
        return self.topic.replace("/req/", "/rep/")

    @classmethod
    def parse(cls, topic: str, body: bytes, nodes: dict[str, str], qos=1, retain=False) -> Request:
        match = TOPIC.fullmatch(topic)
        if not match or len(body) > MAX_REQUEST or qos != 1 or retain:
            raise Rejected("invalid_request")
        node, boot, op, rpc = match.groups()
        if node not in nodes or int(rpc) > 0xFFFFFFFF or (op == "config" and body):
            raise Rejected("invalid_request")
        # Inspect identity without changing even one byte of the frozen batch.
        if op != "config":
            try:
                value = strict_json(body)
                if not isinstance(value, dict):
                    raise ValueError()
                if op != "ingest" and value.get("boot_id") != boot:
                    raise ValueError()
                if op == "ingest" and value.get("node_id") != node:
                    raise ValueError()
                if "node_id" in value and value["node_id"] != node:
                    raise ValueError()
            except (ValueError, UnicodeError, RecursionError) as exc:
                raise Rejected("invalid_identity") from exc
        return cls(node, boot, op, int(rpc), topic, body, hashlib.sha256(body).hexdigest())


class Journal:
    """Bounded restart safety and audit, NOT a device or Cloudflare receipt."""

    def __init__(self, path: Path):
        path = Path(path)
        parent = path.absolute().parent
        info = parent.stat()
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022:
            raise Rejected("private_directory_required")
        # Separate inode: on macOS flock on the DB itself conflicts with SQLite's locks.
        self.lock_fd = private_open(Path(str(path) + ".lock"), create=True)
        try:
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(self.lock_fd)
            raise Rejected("journal_already_open") from None
        os.close(private_open(path, create=True))
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=DELETE")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS rpc (
            node TEXT NOT NULL, boot TEXT NOT NULL, rpc INTEGER NOT NULL,
            op TEXT NOT NULL, digest TEXT NOT NULL, body BLOB NOT NULL,
            state TEXT NOT NULL, status INTEGER, response BLOB,
            PRIMARY KEY(node,boot))""")
        # A crash could occur before/after CF commit; never promote pending to success.
        with self.db:
            self.db.execute("UPDATE rpc SET state='outcome_unknown' WHERE state='pending'")

    def begin(self, request: Request) -> None:
        row = self.db.execute(
            "SELECT rpc,op,digest,body FROM rpc WHERE node=? AND boot=?",
            (request.node, request.boot),
        ).fetchone()
        if row:
            rpc, op, digest, body = row
            if request.rpc < rpc or (
                request.rpc == rpc
                and (request.op != op or request.digest != digest or request.body != body)
            ):
                raise Rejected("rpc_conflict")
        else:
            if (
                self.db.execute(
                    "SELECT count(*) FROM rpc WHERE node=?", (request.node,)
                ).fetchone()[0]
                >= MAX_BOOTS
            ):
                raise Rejected("boot_limit")
            if self.db.execute("SELECT count(*) FROM rpc").fetchone()[0] >= MAX_BOOTS * MAX_NODES:
                raise Rejected("journal_limit")
        with self.db:
            self.db.execute(
                """INSERT INTO rpc VALUES(?,?,?,?,?,?,'pending',NULL,NULL)
                ON CONFLICT(node,boot) DO UPDATE SET rpc=excluded.rpc,op=excluded.op,
                digest=excluded.digest,body=excluded.body,state='pending',status=NULL,response=NULL""",
                (request.node, request.boot, request.rpc, request.op, request.digest, request.body),
            )

    def finish(self, request: Request, status: int, body: bytes, unknown=False) -> None:
        with self.db:
            self.db.execute(
                "UPDATE rpc SET state=?,status=?,response=? WHERE node=? AND boot=?",
                (
                    "outcome_unknown" if unknown else "cf_response",
                    status,
                    body,
                    request.node,
                    request.boot,
                ),
            )

    def close(self) -> None:
        self.db.close()
        os.close(self.lock_fd)


class Forwarder:
    def __init__(self, config: Config, *, transport: httpx.AsyncBaseTransport | None = None):
        self.config = config
        # Ignore HTTPX environment routing; proxy is explicit CF leg only.
        self.http = httpx.AsyncClient(
            verify=ssl.create_default_context(),
            proxy=config.cf_proxy,
            trust_env=False,
            follow_redirects=False,
            timeout=config.timeout_seconds,
            transport=transport,
            limits=httpx.Limits(
                max_connections=config.workers, max_keepalive_connections=config.workers
            ),
        )

    async def forward(self, request: Request) -> tuple[int, bytes, bool]:
        headers = {
            "Authorization": "Bearer " + self.config.nodes[request.node],
            "Accept-Encoding": "identity",
        }
        if request.op != "config":
            headers["Content-Type"] = "application/json"
        if request.op == "ingest":
            headers["X-Body-SHA256"] = request.digest
        try:
            # Overall deadline includes pool wait, TLS, headers and full body consumption.
            async with asyncio.timeout(self.config.timeout_seconds):
                async with self.http.stream(
                    "GET" if request.op == "config" else "POST",
                    ORIGIN + PATHS[request.op],
                    headers=headers,
                    content=request.body if request.op != "config" else None,
                ) as response:
                    body = bytearray()
                    # Raw avoids content decompression changing receipt bytes or a zip bomb.
                    async for chunk in response.aiter_raw():
                        if len(body) + len(chunk) > MAX_RESPONSE:
                            raise ValueError("response_limit")
                        body.extend(chunk)
                    if response.headers.get("content-encoding", "identity") != "identity":
                        raise ValueError("encoded_response")
                    return response.status_code, bytes(body), False
        except (TimeoutError, httpx.HTTPError, ValueError):
            return 504, UNKNOWN, True

    async def close(self) -> None:
        await self.http.aclose()


def envelope(status: int, body: bytes) -> bytes:
    if not 100 <= status <= 599 or len(body) > MAX_RESPONSE:
        raise Rejected("invalid_response")
    return struct.pack("!H", status) + body


class Engine:
    """Async loop owns journal and one pending request per allowlisted node."""

    def __init__(self, config: Config, journal: Journal, forwarder: Forwarder, publish):
        self.config, self.journal, self.forwarder, self.publish = (
            config,
            journal,
            forwarder,
            publish,
        )
        self.pending: dict[str, Request] = {}
        self.blocked: set[str] = set()
        self.rates: dict[str, tuple[float, int, int]] = {}
        self.queue: asyncio.Queue[Request] = asyncio.Queue(config.queue_size)
        self.tasks: list[asyncio.Task] = []

    def submit(self, request: Request) -> bool:
        now = time.monotonic()
        started, attempts, size = self.rates.get(request.node, (now, 0, 0))
        if now - started >= 60:
            started, attempts, size = now, 0, 0
        attempts += 1
        size += len(request.body)
        self.rates[request.node] = (started, attempts, size)
        if attempts > 600 or size > 4 * 1024 * 1024:
            event("rate_limit")
            return False
        if request.node in self.blocked:
            event("auth_blocked")
            return False
        previous = self.pending.get(request.node)
        if previous:
            if previous == request:
                event("duplicate_pending")
            else:
                event("node_busy")
            return False
        if self.queue.full():
            event("queue_full")
            return False
        try:
            self.journal.begin(request)
        except (Rejected, sqlite3.Error):
            event("journal_rejected")
            return False
        self.pending[request.node] = request
        self.queue.put_nowait(request)
        return True

    async def worker(self) -> None:
        while True:
            request = await self.queue.get()
            try:
                status, body, unknown = await self.forwarder.forward(request)
                try:
                    self.journal.finish(request, status, body, unknown)
                except sqlite3.Error:
                    # A journal failure never turns uncertain local state into a successful reply.
                    status, body, unknown = 504, UNKNOWN, True
                    event("journal_failed")
                if status in (401, 403):
                    self.blocked.add(request.node)
                self.publish(request.reply_topic, envelope(status, body))
                event("outcome_unknown" if unknown else "cf_response")
            finally:
                self.pending.pop(request.node, None)
                self.queue.task_done()

    def start(self) -> None:
        self.tasks = [asyncio.create_task(self.worker()) for _ in range(self.config.workers)]

    async def close(self) -> None:
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.forwarder.close()
        self.journal.close()


def mqtt_tls(config: Config) -> ssl.SSLContext:
    context = ssl.create_default_context()
    if config.ca_file:
        # Add the operator-downloaded broker CA to system roots. Never fetch arbitrary CA URLs.
        context.load_verify_locations(cafile=config.ca_file)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    return context


class Bridge:
    def __init__(self, config: Config, loop: asyncio.AbstractEventLoop, engine: Engine):
        self.config, self.loop, self.engine = config, loop, engine
        self.slots = threading.BoundedSemaphore(config.queue_size + config.workers)
        self.publications: set[int] = set()
        self.ready = False
        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id="cp-relay-" + secrets.token_hex(8),
            clean_session=True,
            protocol=mqtt.MQTTv311,
            manual_ack=True,
        )
        self.client.username_pw_set(config.mqtt_username, config.mqtt_password)
        self.client.tls_set_context(mqtt_tls(config))
        self.client.max_queued_messages_set(config.queue_size)
        self.client.max_inflight_messages_set(1)
        self.client.reconnect_delay_set(1, 30)
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message
        self.client.on_publish = self.on_publish
        self.client.on_disconnect = self.on_disconnect
        self.client.on_subscribe = self.on_subscribe

    def on_connect(self, client, _userdata, _flags, reason, _properties) -> None:
        if reason.is_failure:
            event("mqtt_connect_rejected")
            return
        for node in self.config.nodes:
            result, _ = client.subscribe(f"cp/v1/{node}/+/req/+/+", qos=1)
            if result != mqtt.MQTT_ERR_SUCCESS:
                event("mqtt_subscribe_failed")
                client.disconnect()
                return

        def ready() -> None:
            # Paho drops queued QoS0 packets before its new on_connect callback.
            self.publications.clear()
            self.ready = True

        self.loop.call_soon_threadsafe(ready)
        event("mqtt_connected")

    def on_subscribe(self, client, _userdata, _mid, reasons, _properties) -> None:
        if not reasons or any(reason.is_failure for reason in reasons):
            event("mqtt_subscribe_rejected")
            client.disconnect()
        else:
            event("mqtt_subscribed")

    def on_disconnect(self, _client, _userdata, _flags, _reason, _properties) -> None:
        self.ready = False
        event("mqtt_disconnected")

    def on_message(self, client, _userdata, message) -> None:
        # Bound cross-thread scheduled callbacks before touching the asyncio queue.
        if not self.slots.acquire(blocking=False):
            client.ack(message.mid, message.qos)
            event("admission_full")
            return
        try:
            request = Request.parse(
                message.topic,
                bytes(message.payload),
                self.config.nodes,
                message.qos,
                message.retain,
            )
        except (Rejected, UnicodeError):
            self.slots.release()
            client.ack(message.mid, message.qos)
            event("request_rejected")
            return

        def admit() -> None:
            try:
                self.engine.submit(request)
                # Transport ACK only. Device→broker PUBACK has already happened independently.
                client.ack(message.mid, message.qos)
            finally:
                self.slots.release()

        self.loop.call_soon_threadsafe(admit)

    def publish(self, topic: str, body: bytes) -> None:
        # Paho's max_queued_messages is QoS>0 only. Bound QoS0 packets until on_publish too.
        if len(self.publications) >= self.config.queue_size:
            event("reply_queue_full")
            return
        if not self.ready or not self.client.is_connected():
            event("reply_not_sent")
            return
        info = self.client.publish(topic, body, qos=0, retain=False)
        if info.rc == mqtt.MQTT_ERR_SUCCESS:
            self.publications.add(info.mid)
        else:
            event("reply_not_sent")

    def on_publish(self, _client, _userdata, mid, _reason, _properties) -> None:
        # Schedule on the owner loop even if Paho invokes this synchronously in publish().
        self.loop.call_soon_threadsafe(self.publications.discard, mid)

    def start(self) -> None:
        self.client.connect_async(self.config.broker_host, self.config.broker_port, keepalive=30)
        self.client.loop_start()

    def stop(self) -> None:
        self.client.disconnect()
        self.client.loop_stop()


async def run(config: Config) -> None:
    journal = Journal(config.journal_path)
    forwarder = Forwarder(config)
    engine = Engine(config, journal, forwarder, lambda *_: None)
    bridge = Bridge(config, asyncio.get_running_loop(), engine)
    engine.publish = bridge.publish
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, stopped.set)
    engine.start()
    bridge.start()
    event("relay_started")
    try:
        await stopped.wait()
    finally:
        bridge.stop()
        await engine.close()
        event("relay_stopped")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--check", action="store_true", help="Validate config/TLS only; no network")
    args = parser.parse_args()
    try:
        config = Config.load(args.config)
        if args.check:
            mqtt_tls(config)
            event("config_valid")
        else:
            asyncio.run(run(config))
    except (Rejected, OSError, sqlite3.Error, ssl.SSLError, ValueError):
        # Never stringify exceptions: network/library errors can contain URLs or secrets.
        event("relay_failed")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
