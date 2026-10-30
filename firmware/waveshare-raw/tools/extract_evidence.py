#!/usr/bin/env python3
"""Extract bounded, private-by-default protocol evidence from one CPRAW segment.

This is an offline evidence baseline, not a device classifier. Addresses are
used only for segment-local address/type counts. Names, session IDs, timestamps,
addresses, payloads and 128-bit UUID values are never emitted. UUID128 presence
is counted because arbitrary UUIDs can contain an individual identifier.
"""
import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path
import struct
import sys

_spec = importlib.util.spec_from_file_location(
    "cpraw_decoder", Path(__file__).with_name("decode.py"))
decoder = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(decoder)

SCHEMA_VERSION = "cpraw-evidence-v1"
EXTRACTOR_VERSION = "1.0.0"
DEFAULT_MAX_BYTES = 64 * 1024 * 1024
HARD_MAX_BYTES = 256 * 1024 * 1024


class CapacityError(ValueError):
    """An explicit bound was exceeded; no partial result is returned."""


def parse_ad(payload):
    """Return evidence occurrences, or reject the complete malformed AD report.

    No prefix salvage, fragment joining, company dictionary, product category,
    manufacturer data template or cross-address association is attempted.
    """
    evidence = Counter()
    offset = 0
    lists = {2: (2, "incomplete_list"), 3: (2, "complete_list"),
             4: (4, "incomplete_list"), 5: (4, "complete_list"),
             6: (16, "incomplete_list"), 7: (16, "complete_list"),
             0x14: (2, "solicitation"), 0x15: (16, "solicitation"),
             0x1f: (4, "solicitation")}
    service_data = {0x16: 2, 0x20: 4, 0x21: 16}

    def service(value, width, role):
        # Advertised service bytes are little endian. Preserve the source role;
        # a solicitation is not a claim that the advertiser provides the service.
        identifier = ("redacted" if width == 16 else
                      f"0x{int.from_bytes(value, 'little'):0{width * 2}x}")
        evidence[("service_uuid", width * 8, role, identifier)] += 1

    while offset < len(payload):
        length = payload[offset]
        if length == 0:
            if any(payload[offset + 1:]):
                raise ValueError("nonzero bytes after AD terminator")
            break
        end = offset + 1 + length
        if end > len(payload):
            raise ValueError("AD length exceeds report")
        typ = payload[offset + 1]
        value = payload[offset + 2:end]
        evidence[("ad_type", f"0x{typ:02x}")] += 1
        if typ == 0xff:
            if len(value) < 2:
                raise ValueError("short manufacturer company identifier")
            evidence[("company_id", f"0x{int.from_bytes(value[:2], 'little'):04x}")] += 1
        elif typ == 0x19:
            if len(value) != 2:
                raise ValueError("invalid Appearance width")
            evidence[("appearance", f"0x{int.from_bytes(value, 'little'):04x}")] += 1
        elif typ in lists:
            width, role = lists[typ]
            if len(value) % width:
                raise ValueError("incomplete service UUID list entry")
            for pos in range(0, len(value), width):
                service(value[pos:pos + width], width, role)
        elif typ in service_data:
            width = service_data[typ]
            if len(value) < width:
                raise ValueError("short service data UUID")
            service(value[:width], width, "service_data")
        offset = end
    return evidence


def extract(data, *, max_bytes=DEFAULT_MAX_BYTES, max_addresses=8192,
            max_features=1024, max_address_features=65536):
    """Validate the whole segment before aggregating a bounded set of evidence.

    Each report is decoded separately after the existing decoder validates the
    full stream, avoiding an unbounded decoded-record list. Bounds fail closed.
    """
    for name, value, hard in (("max_bytes", max_bytes, HARD_MAX_BYTES),
                              ("max_addresses", max_addresses, 65536),
                              ("max_features", max_features, 4096),
                              ("max_address_features", max_address_features, 262144)):
        if not isinstance(value, int) or not 1 <= value <= hard:
            raise ValueError(f"{name} must be between 1 and {hard}")
    if len(data) > max_bytes:
        raise CapacityError("input byte limit exceeded; no summary emitted")
    validated = decoder.decode(data)
    addresses = set()
    evidence = {}
    memberships = 0
    quality = Counter()
    kinds, statuses, event_types = Counter(), Counter(), Counter()
    # A rotated segment can start at any session sequence. Its prefix alone
    # cannot establish that earlier reports were lost.
    sequence = {"forward_missing": 0, "duplicates": 0, "regressions": 0}
    previous_seq = None
    malformed_reasons = Counter()
    offset = decoder.HEADER_SIZE
    while offset < validated["valid_bytes"]:
        size = struct.unpack_from("<I", data, offset)[0]
        if data[offset + 4] != 1:
            offset += size
            continue
        record = decoder.decode(data[:decoder.HEADER_SIZE] + data[offset:offset + size],
                                include_records=True)["records"][0]
        offset += size
        identity = (record["addr_type"], record["addr"])
        addresses.add(identity)
        if len(addresses) > max_addresses:
            raise CapacityError("address/type capacity exceeded; no summary emitted")
        seq = record["seq"]
        if previous_seq is None:
            pass
        elif seq == previous_seq:
            sequence["duplicates"] += 1
        elif seq < previous_seq:
            sequence["regressions"] += 1
        else:
            sequence["forward_missing"] += seq - previous_seq - 1
        previous_seq = seq
        kind, status = record["kind"], record["data_status"]
        kinds["legacy" if kind == 0 else "extended"] += 1
        statuses[f"{kind}:{status}"] += 1
        event_types[f"{kind}:{record['event_type']}"] += 1
        if status != 0:
            label = ("legacy_unexpected_status" if kind == 0 else
                     {1: "extended_fragment_more", 2: "extended_truncated"}.get(
                         status, "extended_unknown_status"))
            quality[label] += 1
            continue
        try:
            features = parse_ad(bytes.fromhex(record["payload"]))
        except ValueError as exc:
            quality["complete_malformed_ad"] += 1
            malformed_reasons[str(exc)] += 1
            continue
        quality["complete_valid_ad"] += 1
        for key, occurrences in features.items():
            if key not in evidence:
                if len(evidence) >= max_features:
                    raise CapacityError("feature capacity exceeded; no summary emitted")
                evidence[key] = {"reports": 0, "occurrences": 0, "addresses": set()}
            item = evidence[key]
            item["reports"] += 1
            item["occurrences"] += occurrences
            if identity not in item["addresses"]:
                memberships += 1
                if memberships > max_address_features:
                    raise CapacityError("address/evidence capacity exceeded; no summary emitted")
                item["addresses"].add(identity)
    rows = []
    for key, item in sorted(evidence.items()):
        row = {"kind": key[0], "reports": item["reports"],
               "occurrences": item["occurrences"], "address_type_keys": len(item["addresses"])}
        if key[0] == "service_uuid":
            row.update(width_bits=key[1], source=key[2], value=key[3])
        else:
            row["value"] = key[1]
        rows.append(row)
    return {
        "schema_version": SCHEMA_VERSION, "extractor_version": EXTRACTOR_VERSION,
        "dictionary_version": None, "classification_rules_version": None,
        "scope": "one_cpraw_segment_address_plus_type_no_cross_address_linking",
        "units": {"reports": validated["reports"], "address_type_keys": len(addresses)},
        "classification": {"status": "not_run", "unknown_address_type_keys": len(addresses),
                           "estimated_total": None},
        "quality": {"report_partition": dict(sorted(quality.items())),
                    "malformed_ad_reasons": dict(sorted(malformed_reasons.items())),
                    "report_kinds": dict(sorted(kinds.items())),
                    "kind_data_status": dict(sorted(statuses.items())),
                    "kind_event_type": dict(sorted(event_types.items())),
                    "sequence": sequence,
                    "valid_bytes": validated["valid_bytes"],
                    "truncated_offset": validated["truncated_offset"],
                    "last_stats": (None if validated["last_stats"] is None else
                                   {key: value for key, value in validated["last_stats"].items()
                                    if key != "mono_us"}),
                    "stats_frames": validated["stats_frames"],
                    "event_frames": validated["event_frames"],
                    "anchor_frames": validated["anchor_frames"]},
        "limits": {"max_bytes": max_bytes, "max_addresses": max_addresses,
                   "max_features": max_features, "max_address_features": max_address_features,
                   "overflow_policy": "fail_without_partial_output"},
        "evidence": rows,
        "limitations": ["SDK-delivered reports do not prove complete radio capture",
                        "Address/type keys are not physical devices or people",
                        "Noncomplete reports are counted but never AD-parsed or reassembled",
                        "Malformed complete AD reports contribute no protocol evidence",
                        "UUID128 values are redacted and distinct UUID128 values collapse",
                        "Company and service identifiers do not establish brand or category",
                        "Stats and sequence gaps are segment-local producer evidence"],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    parser.add_argument("--max-addresses", type=int, default=8192)
    parser.add_argument("--max-features", type=int, default=1024)
    parser.add_argument("--max-address-features", type=int, default=65536)
    args = parser.parse_args(argv)
    try:
        if not 1 <= args.max_bytes <= HARD_MAX_BYTES:
            raise ValueError(f"max_bytes must be between 1 and {HARD_MAX_BYTES}")
        with args.file.open("rb") as source:
            data = source.read(args.max_bytes + 1)
        summary = extract(data, max_bytes=args.max_bytes, max_addresses=args.max_addresses,
                          max_features=args.max_features,
                          max_address_features=args.max_address_features)
        print(json.dumps(summary, indent=2))
    except OSError:
        # Paths can contain private device/placement identifiers.
        print("extract_evidence: unable to read input", file=sys.stderr)
        return 1
    except (ValueError, decoder.FormatError) as exc:
        print(f"extract_evidence: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
