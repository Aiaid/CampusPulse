#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyserial==3.5"]
# ///
"""Check one physical USB setup channel without sending enrollment credentials.

Use --begin explicitly to enter USB setup. No Flash erase, Wi-Fi candidate,
credential issuance, reset, or raw serial logging is performed. Output excludes
node identity, nonces and all setup secrets.
"""
import argparse
import json
import re
import time
import uuid

import serial

PREFIX = b"\x1eCPSETUP/1 "
MAX_JSON = 1024
MAX_FRAME = len(PREFIX) + 36 + 1 + MAX_JSON
FORBIDDEN = {"password", "proof", "pin", "device_token", "setup_secret", "ap_password",
             "setup_proof", "master_secret", "eap_username", "eap_identity", "eap_password"}


class DeviceCheckError(Exception):
    """A deliberately non-sensitive diagnostic suitable for console output."""


class Channel:
    def __init__(self, port):
        self.port = port
        self.buffer = bytearray()
        self.discarded = 0

    def request(self, body, timeout=5):
        request_id = str(uuid.uuid4()).encode("ascii")
        encoded = json.dumps({"v": 1, **body}, separators=(",", ":")).encode()
        if len(encoded) > MAX_JSON:
            raise DeviceCheckError("request exceeds USB payload bound")
        frame = PREFIX + request_id + b" " + encoded + b"\n"
        if self.port.write(frame) != len(frame):
            raise DeviceCheckError("incomplete USB write")
        self.port.flush()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            chunk = self.port.read(256)
            for value in chunk:
                if value == 0x1E:
                    self.buffer.clear()
                if not self.buffer and value != 0x1E:
                    self.discarded += 1
                    continue
                self.buffer.append(value)
                if len(self.buffer) > MAX_FRAME + 1:
                    self.buffer.clear()
                    continue
                if value != 0x0A:
                    continue
                line = bytes(self.buffer[:-1]).rstrip(b"\r")
                self.buffer.clear()
                expected = PREFIX + request_id + b" "
                if not line.startswith(expected):
                    continue
                payload = line[len(expected):]
                if len(payload) > MAX_JSON:
                    raise DeviceCheckError("oversized device reply")
                try:
                    result = json.loads(payload)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    raise DeviceCheckError("invalid device JSON reply") from None
                if not isinstance(result, dict) or result.get("v") != 1:
                    raise DeviceCheckError("invalid device protocol version")
                self.check_secrets(result)
                return result
        raise DeviceCheckError("USB reply timed out")

    @staticmethod
    def check_secrets(value):
        if isinstance(value, dict):
            if FORBIDDEN.intersection(value):
                raise DeviceCheckError("device reply unexpectedly contains secret fields")
            for child in value.values():
                Channel.check_secrets(child)
        elif isinstance(value, list):
            for child in value:
                Channel.check_secrets(child)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="Explicit connected USB serial port")
    parser.add_argument("--begin", action="store_true", help="Explicitly enter USB setup")
    parser.add_argument("--exercise-parser", action="store_true", help="Send bounded malformed frames, then verify recovery")
    args = parser.parse_args()
    port = serial.Serial(port=None, baudrate=115200, timeout=0.1, write_timeout=2)
    # Match ESP-IDF monitor's --no-reset sequence. On this native USB/JTAG
    # interface, opening with False/False can briefly clear DTR before RTS and
    # trigger USB_UART_CHIP_RESET. Pre-assert both, then release RTS first.
    port.dtr = True
    port.rts = True
    port.port = args.port
    try:
        port.open()
        port.rts = False
        port.dtr = False
        channel = Channel(port)
        if args.begin:
            started = channel.request({"op": "begin"})
            if started.get("ok") is not True or started.get("state") != "starting":
                raise DeviceCheckError("device did not queue USB setup")
            deadline = time.monotonic() + 20
            identity = None
            while time.monotonic() < deadline:
                candidate = channel.request({"op": "info"})
                if candidate.get("ok") is True:
                    identity = candidate
                    break
                time.sleep(0.2)
            if identity is None:
                raise DeviceCheckError("USB setup did not become ready")
            if not re.fullmatch(r"cp_[a-f0-9]{12}", identity.get("node_id", "")):
                raise DeviceCheckError("invalid factory node identity")
            if identity.get("transport") != "usb":
                raise DeviceCheckError("device did not identify USB transport")
            if identity.get("security") != "physical-usb":
                raise DeviceCheckError("invalid USB security profile")
            for field in ("board", "firmware_version"):
                if not isinstance(identity.get(field), str) or not 1 <= len(identity[field]) <= 80:
                    raise DeviceCheckError("missing device board or firmware identity")
            if not re.fullmatch(r"[a-f0-9]{32}", identity.get("nonce", "")):
                raise DeviceCheckError("invalid USB session nonce")
        if args.exercise_parser:
            # Neither payload contains secrets; malformed input must not be
            # reflected and must not prevent the next correctly framed request.
            port.write(b"unframed-noise\n" + PREFIX + b"x" * (MAX_FRAME + 32) + b"\n")
            port.write(PREFIX + b"not-a-uuid {}\n")
            port.flush()
        status = channel.request({"op": "status"})
        if status.get("ok") is not True or not isinstance(status.get("state"), str):
            raise DeviceCheckError("device status unavailable")
        print(json.dumps({"usb_reply": "passed", "setup_begin": args.begin,
                          "framing_recovery": args.exercise_parser,
                          "credentials_sent": False, "flash_erased": False}))
    finally:
        port.close()


if __name__ == "__main__":
    try:
        main()
    except (DeviceCheckError, serial.SerialException, OSError) as error:
        # OS/serial exception text can include port/host-specific paths. Keep the
        # public diagnostic bounded; never dump the serial buffer or traceback.
        message = str(error) if isinstance(error, DeviceCheckError) else "USB port operation failed"
        raise SystemExit(message) from None
