#!/usr/bin/env python3
"""Prepare private aggregate-only V3 replay windows from read-only CPRAW segments.

Raw identifiers and payloads are borrowed in memory only. The actual firmware
cp_v3_stats C core computes every compact statistic; Python validates framing,
selects source intervals and records provenance. No network or hardware access.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
MAGIC = b"CPRAW\r\n\x1a"
SAFE_INTEGER = 2**53 - 1


class ReplayError(ValueError):
    """A source cannot safely produce the requested replay."""


def frames(path):
    """Strict streaming decoder; unlike recovery tooling, reject truncated tails."""
    digest = hashlib.sha256()
    with path.open('rb') as source:
        header = source.read(32)
        digest.update(header)
        if len(header) != 32:
            raise ReplayError('incomplete source header')
        if header[:8] != MAGIC or struct.unpack_from('<HH', header, 8) != (1, 32):
            raise ReplayError('invalid source magic/version/header size')
        if zlib.crc32(header[:28]) != struct.unpack_from('<I', header, 28)[0]:
            raise ReplayError('source header CRC mismatch')
        yield 0, header[12:28]
        while True:
            prefix = source.read(4)
            if not prefix:
                break
            if len(prefix) != 4:
                raise ReplayError('truncated source frame tail')
            size = struct.unpack('<I', prefix)[0]
            if not 12 <= size <= 1728:
                raise ReplayError('invalid source frame length')
            rest = source.read(size - 4)
            if len(rest) != size - 4:
                raise ReplayError('truncated source frame tail')
            frame = prefix + rest
            digest.update(frame)
            if zlib.crc32(frame[:-4]) != struct.unpack_from('<I', frame, size - 4)[0]:
                raise ReplayError('source frame CRC mismatch')
            if frame[5:8] != b'\0\0\0':
                raise ReplayError('nonzero source frame reserved bytes')
            kind, body = frame[4], frame[8:-4]
            if kind == 1:
                if len(body) < 43:
                    raise ReplayError('short source report')
                length = struct.unpack_from('<H', body, 16)[0]
                if length > 1650 or len(body) != 43 + length or body[27] > 1:
                    raise ReplayError('invalid source report')
            elif kind == 2:
                if len(body) != 56:
                    raise ReplayError('invalid source stats frame')
            elif kind == 3:
                if len(body) != 16:
                    raise ReplayError('invalid source event frame')
            elif kind == 4:
                if len(body) != 21 or body[20] not in (1, 2):
                    raise ReplayError('invalid source clock anchor')
            else:
                raise ReplayError('unknown source frame type')
            yield kind, body
    yield -1, digest.hexdigest()


def inspect(inputs):
    session, previous_seq, first_report, last_report = None, None, None, None
    last_by_kind, events, anchors, hashes = {}, [], [], []
    totals = {"total_reports": 0, "stats_frames": 0, "event_frames": 0,
              "anchor_frames": 0, "forward_sequence_gaps": 0}
    last_stats = None
    max_mono = 0
    for path in inputs:
        for kind, body in frames(path):
            if kind == 0:
                if session is not None and body != session:
                    raise ReplayError('source segments have different sessions')
                session = body
                continue
            if kind == -1:
                hashes.append(body)
                continue
            mono = struct.unpack_from('<Q', body, 8 if kind == 1 else 0)[0]
            if mono > SAFE_INTEGER:
                raise ReplayError('source monotonic time exceeds exact replay integer range')
            # Writer-side stats/anchors may precede older queued reports. Each
            # timestamp domain is ordered independently, not mixed as RF time.
            if mono < last_by_kind.get(kind, 0):
                raise ReplayError('source monotonic timestamps regress within frame type')
            last_by_kind[kind] = mono
            max_mono = max(max_mono, mono)
            if kind == 1:
                seq = struct.unpack_from('<Q', body)[0]
                if previous_seq is not None:
                    if seq <= previous_seq:
                        raise ReplayError('source report sequence duplicates or regresses')
                    totals['forward_sequence_gaps'] += seq - previous_seq - 1
                previous_seq = seq
                first_report = mono if first_report is None else first_report
                last_report = mono
                totals['total_reports'] += 1
            elif kind == 2:
                values = struct.unpack('<7Q', body)
                if last_stats is not None and any(a < b for a, b in zip(values[1:], last_stats[1:])):
                    raise ReplayError('source cumulative stats counters regress')
                last_stats = values
                totals['stats_frames'] += 1
            elif kind == 3:
                _, event, _ = struct.unpack('<QIi', body)
                # Unknown event codes cannot establish scanning or pause state.
                if event in range(1, 9):
                    events.append((mono, event == 1))
                totals['event_frames'] += 1
            else:
                _, utc, uncertainty, source = struct.unpack('<QQIB', body)
                anchors.append({"mono_us": mono, "utc_epoch_seconds": utc,
                                "uncertainty_us": uncertainty, "source": source})
                totals['anchor_frames'] += 1
    if first_report is None:
        raise ReplayError('sources contain no reports')
    stats_summary = None if last_stats is None else dict(zip(
        ('mono_us', 'received', 'enqueued', 'queue_drops', 'invalid', 'written', 'synced'), last_stats))
    return {**totals, "source_sha256": hashes, "source_count": len(inputs),
            "first_report_mono_us": first_report, "last_report_mono_us": last_report,
            "last_source_mono_us": max_mono, "source_capture_cumulative_last_stats": stats_summary}, events, anchors


class Core:
    def __init__(self, library):
        self.lib = ctypes.CDLL(str(library))
        self.lib.cp_replay_create.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint64]
        self.lib.cp_replay_create.restype = ctypes.c_void_p
        self.lib.cp_replay_free.argtypes = [ctypes.c_void_p]
        self.lib.cp_replay_scan.argtypes = [ctypes.c_void_p, ctypes.c_uint64, ctypes.c_int]
        self.lib.cp_replay_report.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
        self.lib.cp_replay_snapshot.argtypes = [ctypes.c_void_p, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_size_t]

    def check(self, value):
        if not value:
            raise ReplayError('firmware statistics core rejected replay input')
        return value


def build_core(directory):
    library = Path(directory) / 'cpraw-replay.so'
    component = ROOT / 'firmware/components/cp_v3_stats'
    subprocess.run([os.environ.get('CC', 'cc'), '-std=c11', '-Wall', '-Wextra', '-Werror',
                    '-O2', '-fPIC', '-shared', '-I', str(component / 'include'),
                    str(component / 'stats.c'), str(ROOT / 'scripts/lib/v3-cpraw-replay-bridge.c'),
                    '-o', str(library)], check=True, capture_output=True)
    return Core(library)


def prepare(inputs, *, window_ms=1000, windows=10, offset_ms=0, all_reports=False):
    if window_ms not in (1000, 30000, 60000) or not 1 <= windows <= 120 or offset_ms < 0:
        raise ReplayError('unsupported window cadence/count/offset')
    provenance, events, anchors = inspect(inputs)
    width = window_ms * 1000
    if all_reports:
        if offset_ms:
            raise ReplayError('complete replay cannot use an offset')
        start = provenance['first_report_mono_us'] // 1000 * 1000
        end = (provenance['last_source_mono_us'] + 999) // 1000 * 1000
        windows = (end - start + width - 1) // width
        if not 1 <= windows <= 120:
            raise ReplayError('complete replay exceeds 120 windows; select a longer cadence')
    else:
        start = ((provenance['first_report_mono_us'] + 999) // 1000 + offset_ms) * 1000
        end = start + windows * width
    if not all_reports and end > provenance['last_source_mono_us']:
        raise ReplayError('requested closed windows extend beyond recorded source time')
    bin_ms = 1000 if window_ms == 1000 else 5000
    result_windows, handles = [], []
    with tempfile.TemporaryDirectory(prefix='cpraw-v3-core-') as directory:
        core = build_core(directory)
        try:
            event_index, state = 0, None
            for index in range(windows):
                begin, finish = start + index * width, min(end, start + (index + 1) * width)
                handle = core.check(core.lib.cp_replay_create(window_ms, bin_ms, begin))
                handles.append(handle)
                while event_index < len(events) and events[event_index][0] <= begin:
                    state = events[event_index][1]
                    event_index += 1
                if state is not None:
                    core.check(core.lib.cp_replay_scan(handle, begin, int(state)))
                while event_index < len(events) and events[event_index][0] < finish:
                    mono, state = events[event_index]
                    core.check(core.lib.cp_replay_scan(handle, mono, int(state)))
                    event_index += 1
            replayed, second_hashes = 0, []
            for path in inputs:
                for kind, body in frames(path):
                    if kind == -1:
                        second_hashes.append(body)
                    elif kind == 1:
                        mono = struct.unpack_from('<Q', body, 8)[0]
                        if start <= mono < end:
                            index = (mono - start) // width
                            # ctypes borrows these binary bytes only during call.
                            core.check(core.lib.cp_replay_report(handles[index], body, len(body)))
                            replayed += 1
            if second_hashes != provenance['source_sha256']:
                raise ReplayError('source changed between validation and aggregation')
            for index, handle in enumerate(handles):
                begin, finish = start + index * width, min(end, start + (index + 1) * width)
                buffer = ctypes.create_string_buffer(16384)
                core.check(core.lib.cp_replay_snapshot(handle, finish, buffer, len(buffer)))
                value = json.loads(buffer.value)
                value = {"source_start_mono_us": begin, "source_end_mono_us": finish, **value}
                result_windows.append(value)
        finally:
            for handle in handles:
                core.lib.cp_replay_free(handle)
    provenance.update({
        "replayed_reports": replayed,
        "validation": {"headers_crc": "passed", "frames_crc": "passed", "truncated_tails": 0,
                       "matching_session": True, "report_sequence": "strictly_increasing",
                       "monotonic_timestamps": "nondecreasing_within_each_frame_type",
                       "all_source_files_validated_twice": True},
        "time_semantics": "historical_monotonic_windows_rebased_to_new_simulator_runtime_clock",
        "source_utc_semantics": "producer_clock_anchors_only_not_independently_verified",
        "source_clock_anchors": anchors,
        "counter_scope": "r_and_l_ingress_losses_are_replay_delivery_not_original_radio_capture",
        "original_capture_losses_known": False,
        "source_capture_loss_scope": "last_stats_cumulative_counters_only_not_per_window_or_whole_capture",
        "scan_coverage_semantics": "explicit_scanning_event_until_explicit_stop_error_reset_event_otherwise_unknown",
        "offset_ms": offset_ms,
        "complete_source": all_reports,
        "start_rounding": "first_report_floor_ms_last_frame_ceil_ms" if all_reports else "first_report_rounded_up_to_millisecond_then_offset",
    })
    if all_reports and replayed != provenance['total_reports']:
        raise ReplayError('complete replay failed to account for every source report')
    return {"schema": "campuspulse-cpraw-replay/1", "window_ms": window_ms,
            "bin_ms": bin_ms, "provenance": provenance, "windows": result_windows}


def write_private(output, value, inputs):
    output = output.resolve()
    captures = (ROOT / 'captures').resolve()
    if not output.is_relative_to(captures) or output in [p.resolve() for p in inputs]:
        raise ReplayError('output must be a separate ignored captures/ artifact')
    ignored = subprocess.run(['git', 'check-ignore', '-q', str(output)], cwd=ROOT, check=False)
    if ignored.returncode != 0:
        raise ReplayError('output is not ignored by Git')
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    output.parent.chmod(0o700)
    descriptor, name = tempfile.mkstemp(prefix='.replay-', dir=output.parent)
    try:
        with os.fdopen(descriptor, 'w') as destination:
            json.dump(value, destination, separators=(',', ':'), allow_nan=False)
            destination.write('\n')
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(name, output)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, action='append', required=True, help='CPRAW segments in stream order; repeat for a single session')
    parser.add_argument('--output', type=Path, required=True, help='private ignored captures/.../replay.json')
    parser.add_argument('--window-ms', type=int, choices=(1000, 30000, 60000), default=1000)
    parser.add_argument('--windows', type=int, default=10)
    parser.add_argument('--offset-ms', type=int, default=0)
    parser.add_argument('--all', action='store_true', dest='all_reports', help='include every source report with a final partial window (maximum 120 windows)')
    args = parser.parse_args()
    try:
        value = prepare(args.input, window_ms=args.window_ms, windows=args.windows, offset_ms=args.offset_ms, all_reports=args.all_reports)
        write_private(args.output, value, args.input)
    except ReplayError as exc:
        print(f'cpraw replay: {exc}; no replay artifact written', file=sys.stderr)
        return 1
    except (OSError, subprocess.CalledProcessError):
        # Filesystem errors can contain private input paths; do not print them.
        print('cpraw replay: validation/preparation failed; no replay artifact written', file=sys.stderr)
        return 1
    print(json.dumps({"schema": value['schema'], "source_count": len(args.input),
                      "validated_reports": value['provenance']['total_reports'],
                      "replayed_reports": value['provenance']['replayed_reports'],
                      "windows": len(value['windows']), "window_ms": value['window_ms']}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
