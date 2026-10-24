#!/usr/bin/env python3
"""按**固件真实语义**回放一份 LOG ON 逐包日志，回答"屏幕上那个数是怎么来的"。

    python tools/analyze_sniff.py _lab5.log

为什么不直接看日志：日志是逐包的，屏幕上的车数是"每台设备累积出来的一个状态"
（在场、dwell、证据位、硬条件）。同一份日志按不同口径回放能得出 0 台、3 台、
24 台三个完全不同的结论，所以这套逻辑必须和固件一一对应。

**先看 [BIKE] 行**：固件自己在 LOG ON 时每 5 秒打一坨 `[BIKE] ...`，那是权威
答案（它知道真实 dwell）。本脚本用于"固件没开 LOG ON"或"追溯历史日志"。

⚠ 一个真实翻车教训：这份脚本原来用**一个大正则**匹配诊断行，而固件在行尾会按
情况加上 `manu=0x../NB`、`appr=0x..`、`uuid128`、`uuid16=0x..` 等可选字段。
漏掉 `uuid128` 和 `uuid16=` 之后，**所有带 128 位 UUID 的设备整行匹配失败、
被静默丢掉**——回放出来 2 台，固件实际数 4 台，差了一倍，而且没有任何报错。
现在改成逐字段解析，并在开头打印"有多少行没解析成功"：只要不是 0，
就说明解析器又和固件对不上了，下面的结论一律不可信。

对应的固件位置（改固件时要同步改这里）：
    main/scan_ble.c    on_disc()                          逐包解析 + 分类
    main/scan_table.c  scan_table_observe_classified()    累积证据/在窗
    main/scan_table.c  scan_table_count_vehicle()         计数（在场 10s + dwell 10s）
    main/veh_rules.c   veh_rules_hard_ok()                硬条件
    main/veh_rules.c   veh_rules_evidence()               证据位
    main/dev_phone.c   dev_phone_is_phone() / is_peripheral()
"""
import collections
import re
import sys

# ---- 与固件保持一致的门槛 ----
SCAN_LIVE_WINDOW_MS = 10000      # 在场窗口
SCAN_VEHICLE_DWELL_MS = 10000    # 车要求累计在场
SCAN_MANU_LONG_LEN = 8           # 厂商数据"长"的门槛
SCAN_PHONE_RSSI_MAX = -75        # 手机数只数这个强度以上的

# ---- 与固件保持一致的名单 ----
# veh_rules_manu_is_office()
OFFICE = {0x0065, 0x011B, 0x0040, 0x0004, 0x018B, 0x01A9, 0x01F1,
          0x025D, 0x065F, 0x0755, 0x041E, 0x0381, 0x02EA}
# dev_phone_vendor()
PHONE_VENDOR = {0x00E0, 0x0075, 0x0837, 0x8486, 0x027D, 0x09C6, 0x038F,
                0x079A, 0x072F, 0x08A4, 0x03AB, 0x08CA, 0x02C5, 0x0008}
MANU_APPLE = 0x004C
MANU_MS = 0x0006
# dev_phone.c 的 PERIPH[]
PERIPH = ("mouse", "keyboard", "kbd", "trackpad", "touchpad", "buds", "earbud",
          "airpod", "headphone", "headset", "speaker", "watch", "band", "pen",
          "stylus", "printer", "tws", "ikf", "qcy", "edifier", "soundcore",
          "baseus", "jbl", "bose", "deli",
          # Windows 默认机器名（DESKTOP-XXXXXXX / LAPTOP-XXXXXXX）。
          # 带连字符，用来做子串匹配不会误伤别的产品名，车名也不可能长这样。
          "desktop-", "laptop-")
# dev_phone.c 的 PHONE 名字词表
PHONE_KEYS = ("iphone", "galaxy", "pixel", "redmi", "huawei", "honor",
              "oneplus", "oppo", "vivo", "xiaomi", "mi ", "realme")
# veh_rules.c 的 GADGET_SVC[]（0x16 service data）
GADGET_SVC = {0xFDF7: "HP 打印机", 0xFD92: "小米设备", 0xFEBE: "Bose 音箱"}
# 0x02/0x03 UUID 列表里的已知 gadget
GADGET_UUID16 = {0xFD92: "小米设备", 0xFEBE: "Bose 音箱"}
# ad_parse.h 的 Apple Continuity 子类型
APPLETYPE_PHONE = {0x0C: "Handoff", 0x0F: "NearbyInfo", 0x10: "NearbyAction"}
APPLETYPE_OTHER = {0x01: "ProximityPairing(AirPods)", 0x02: "iBeacon/FindMy",
                   0x05: "AirDrop", 0x06: "HomeKit", 0x07: "AirPods",
                   0x08: "Siri", 0x09: "AirPlay", 0x0A: "Watch",
                   0x0B: "Nearby", 0x0D: "TetheringSource",
                   0x0E: "TetheringTarget", 0x12: "FindMy"}


def appearance_is_gadget(app):
    """与 veh_rules_appearance_is_gadget() 一字不差（数值来自 SIG Assigned Numbers）。"""
    return (0x0080 <= app <= 0x008F      # 电脑/平板/Laptop
            or 0x00C0 <= app <= 0x00C2   # 手表/手环
            or 0x0300 <= app <= 0x03FF   # 体温计/心率/血压/HID（含数字笔 0x03C7）
            or 0x0440 <= app <= 0x044F   # 运动传感器
            or 0x0480 <= app <= 0x048F   # 骑行传感器
            or 0x0540 <= app <= 0x057F)  # 各类传感器


# 行首固定部分。**行尾的诊断文本逐字段解析**，不要用一个大正则——
# 固件往里加一个字段，大正则就整行匹配失败，而失败是静默的。
HEAD_RE = re.compile(
    r'I \((\d+)\) scan_ble: ([0-9A-F:]{17}) rssi=(-?\d+) type=0x(\w\w) '
    r'len=(\d+) fp=(\w+) name="([^"]*)" \|(.*)$')
TOKEN_RE = re.compile(r'(\w[\w=0-9x./A-Fa-f]*)')


def _hx(v):
    """解析十六进制字段。令牌里可能带 `0x` 前缀（ev=0x88 / manu=0x004C），
    也可能不带（ad=02011A），两种都要吃。"""
    v = v.strip()
    if v.lower().startswith("0x"):
        v = v[2:]
    return int(v, 16)


def parse_line(line):
    """返回 dict，或者 None（不是逐包诊断行）。字段缺失不算失败。"""
    m = HEAD_RE.search(line)
    if not m:
        return None
    rec = dict(ts=int(m.group(1)), mac=m.group(2), rssi=int(m.group(3)),
               type=m.group(4), plen=int(m.group(5)), name=m.group(7),
               manu=None, manu_len=None, appr=None, has_uuid128=False,
               uuid16=None, ev=0, sub=None, phone=0, ad=None)
    tail = m.group(8)
    # 串口在高负载下会**把下一行的行首拼到这一行尾部**（实测：
    # `sub=0x0I (66540) scan_ble: ...`——`phone=0` 丢了，"I" 粘上来了）。
    # 遇到下一个 "I (" 就把尾巴切掉，否则解析出来的字段是错的。
    cut = tail.find("I (")
    if cut > 0:
        tail = tail[:cut]

    for tok in TOKEN_RE.findall(tail):
        try:
            if tok.startswith("manu="):
                v = tok[5:].split("/")
                rec["manu"] = _hx(v[0])
                rec["manu_len"] = int(v[1].rstrip("B")) if len(v) > 1 else 0
            elif tok.startswith("appr="):
                rec["appr"] = _hx(tok[5:])
            elif tok == "uuid128":
                rec["has_uuid128"] = True
            elif tok.startswith("uuid16="):
                rec["uuid16"] = _hx(tok[7:])
            elif tok.startswith("ev=0x"):
                rec["ev"] = _hx(tok[3:])
            elif tok.startswith("sub=0x"):
                rec["sub"] = _hx(tok[4:])
            elif tok.startswith("phone="):
                rec["phone"] = int(tok[6:])
            elif tok.startswith("ad="):
                rec["ad"] = tok[3:]
        except ValueError:
            # 被截断的字段（行尾交错）——丢掉这个字段，其余照用。
            continue
    return rec


def ad_scan(hexs):
    """返回 (第一个 0x16 的 service UUID, 命中的 gadget 名字, appearance)"""
    if not hexs:
        return 0, None, None
    b = bytes.fromhex(hexs)
    i = 0
    svc = 0
    hit = None
    app = None
    while i < len(b) and b[i]:
        ln = b[i]
        if i + 1 >= len(b):
            break
        t = b[i + 1]
        data = b[i + 2:i + 1 + ln]
        if t == 0x16 and len(data) >= 2:
            u = data[0] | (data[1] << 8)
            if svc == 0:
                svc = u
            if u in GADGET_SVC:
                hit = GADGET_SVC[u]
        if t in (0x02, 0x03):
            for k in range(0, len(data) - 1, 2):
                u = data[k] | (data[k + 1] << 8)
                if u in GADGET_UUID16:
                    hit = GADGET_UUID16[u]
        if t == 0x19 and len(data) >= 2:
            app = data[0] | (data[1] << 8)
        i += 1 + ln
    return svc, hit, app


def load(path):
    per = collections.defaultdict(lambda: dict(
        first=None, last=None, packets=0, rssi_last=-127, rssi_peak=-127,
        manu=set(), manu_last=None, mlen_max=0, mlen_min=255,
        conn=False, names=[], apple_subs=set(), phone_votes=0,
        gadget=None, svc16=0, ad_types=set(), appr=None))
    bad = 0
    sniff_lines = 0
    for line in open(path, encoding="utf-8", errors="replace"):
        if "scan_ble:" not in line or "rssi=" not in line:
            continue
        sniff_lines += 1
        r = parse_line(line)
        if r is None:
            bad += 1
            continue
        d = per[r["mac"]]
        t = r["ts"]
        d["first"] = t if d["first"] is None else min(d["first"], t)
        d["last"] = t if d["last"] is None else max(d["last"], t)
        d["packets"] += 1
        d["rssi_last"] = r["rssi"]
        d["rssi_peak"] = max(d["rssi_peak"], r["rssi"])
        if r["type"] == "00":
            d["conn"] = True
        if r["manu"] is not None:
            d["manu"].add(r["manu"])
            d["manu_last"] = r["manu"]
            d["mlen_max"] = max(d["mlen_max"], r["manu_len"])
            d["mlen_min"] = min(d["mlen_min"], r["manu_len"])
        if r["name"] and r["name"] not in d["names"]:
            d["names"].append(r["name"])
        if r["sub"] is not None and r["manu"] == MANU_APPLE:
            d["apple_subs"].add(r["sub"])
        if r["phone"]:
            d["phone_votes"] += 1
        svc, gadget, app = ad_scan(r["ad"])
        if gadget:
            d["gadget"] = gadget
        if svc:
            d["svc16"] = svc
        if app is not None:
            d["appr"] = app
        if r["ad"]:
            b = bytes.fromhex(r["ad"])
            i = 0
            while i < len(b) and b[i]:
                if i + 1 < len(b):
                    d["ad_types"].add(b[i + 1])
                i += 1 + b[i]
    return per, sniff_lines, bad


def dwell_ms(d):
    """近似固件的 dwell：最后一次 - 第一次。"""
    return d["last"] - d["first"]


def last_manu(d):
    return d["manu_last"] if d["manu_last"] is not None else 0


def is_peripheral(d):
    for n in d["names"]:
        low = n.lower()
        if any(k in low for k in PERIPH):
            return True
    return False


def is_phone(d):
    if d["phone_votes"] > 0:
        return True
    if is_peripheral(d):
        return False
    mid = last_manu(d)
    if mid and mid != MANU_APPLE and mid in PHONE_VENDOR:
        return True
    if mid == MANU_APPLE:
        return bool(d["apple_subs"] & set(APPLETYPE_PHONE))
    for n in d["names"]:
        low = n.lower()
        if any(k in low for k in PHONE_KEYS):
            return True
    return False


# veh_rules.c 的 VEHICLE_BRANDS[]——**准入表**，只有在榜上的名字才算车。
VEHICLE_BRANDS = ("yadea", "aima", "tailg", "luyuan", "zeeho", "byd",
                  "ninebot", "segway", "soco", "sunra", "niu-")


def positive(d):
    """与 veh_rules_name_is_vehicle() 一致：名字里有车厂品牌。"""
    for n in d["names"]:
        low = n.lower()
        if any(k in low for k in VEHICLE_BRANDS):
            return True
    return False


def evidence(d):
    ev = 0
    if d["mlen_max"] >= SCAN_MANU_LONG_LEN:
        ev |= 0x02
    if d["conn"] and d["mlen_max"] < SCAN_MANU_LONG_LEN:
        ev |= 0x08
    if d["gadget"]:
        ev |= 0x80
    if d["appr"] is not None and appearance_is_gadget(d["appr"]):
        ev |= 0x10
    if positive(d):
        ev |= 0x20          # EVID_POSITIVE
    return ev


def hard_ok(d):
    if is_phone(d):
        return False, "手机"
    if is_peripheral(d):
        return False, "外设/电脑名"
    mid = last_manu(d)
    if mid and mid in OFFICE:
        return False, "办公品牌"
    if mid and (mid in (MANU_APPLE, MANU_MS) or mid in PHONE_VENDOR):
        return False, "消费电子品牌"
    if d["gadget"]:
        return False, "已知外设 UUID(%s)" % d["gadget"]
    if d["appr"] is not None and appearance_is_gadget(d["appr"]):
        return False, "Appearance=0x%04X（手表/电脑/HID/传感器）" % d["appr"]
    if d["conn"] and d["mlen_max"] >= SCAN_MANU_LONG_LEN:
        return False, "可连接+长厂商数据"
    return True, ""


def identity(d):
    if d["names"]:
        return d["names"][0]
    if d["gadget"]:
        return d["gadget"]
    mid = last_manu(d)
    if mid:
        return "厂商 0x%04X" % mid
    if d["svc16"]:
        return "服务 0x%04X" % d["svc16"]
    return "无任何标识"


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    path = sys.argv[1]
    per, sniff_lines, bad = load(path)

    print("逐包行 %d，解析失败 %d" % (sniff_lines, bad))
    if bad:
        print("  ⚠ 有 %d 行没解析出来——说明诊断行的字段又变了，"
              "下面所有结论都不可信，先修 parse_line()。" % bad)
    print()

    cand = [(k, v) for k, v in per.items() if evidence(v) & 0x08]
    shown = []
    maybe = []
    for k, v in cand:
        ok, why = hard_ok(v)
        if not ok:
            continue
        if dwell_ms(v) < SCAN_VEHICLE_DWELL_MS:
            continue
        if positive(v):
            shown.append((k, v))
        else:
            maybe.append((k, v))

    print("设备 %d 台，命中 D 判据 %d 台" % (len(per), len(cand)))
    excl = collections.Counter()
    for k, v in cand:
        ok, why = hard_ok(v)
        if not ok:
            excl[why] += 1
        elif dwell_ms(v) < SCAN_VEHICLE_DWELL_MS:
            excl["在场不足 10s（可能抓包前就在场）"] += 1
    print("排除分布:", dict(excl))
    print()
    print("===== 确认 %d 台（有车厂品牌名） / 疑似 %d 台（像车但无正面证据）====="
          % (len(shown), len(maybe)))
    for k, v in sorted(maybe, key=lambda x: -x[1]["rssi_last"]):
        print("  [疑似] %s rssi=%d 在场%.1fs %s"
              % (k, v["rssi_last"], dwell_ms(v) / 1000.0, identity(v)))
    print()
    for k, v in sorted(shown, key=lambda x: -x[1]["rssi_last"]):
        near = [(s, APPLETYPE_PHONE.get(s) or APPLETYPE_OTHER.get(s, "?"))
                for s in sorted(v["apple_subs"])]
        print("  %s" % k)
        print("      RSSI 最近 %-4d 峰值 %-4d   在场 %5.1fs   包 %d"
              % (v["rssi_last"], v["rssi_peak"], dwell_ms(v) / 1000.0, v["packets"]))
        print("      名字 %r   厂商 %s   厂商数据 %d-%d 字节"
              % (v["names"][:2] or "",
                 "/".join("0x%04X" % m for m in sorted(v["manu"])) or "无",
                 v["mlen_min"] if v["mlen_min"] != 255 else 0, v["mlen_max"]))
        print("      AD 类型 %s   service %s   appearance %s   Apple 子类型 %s"
              % (",".join("%02X" % t for t in sorted(v["ad_types"])) or "-",
                 "0x%04X" % v["svc16"] if v["svc16"] else "-",
                 "0x%04X" % v["appr"] if v["appr"] is not None else "-",
                 near or "-"))
        print("      推断：%s" % identity(v))
    if len(shown) != len(cand):
        print()
        print("---- 差一点就进来的（在场 4~10s 或证据不全），供判断稳定性 ----")
        for k, v in cand:
            ok, why = hard_ok(v)
            if ok and dwell_ms(v) < SCAN_VEHICLE_DWELL_MS:
                print("  %s  在场 %.1fs  证据 0x%02X  %s"
                      % (k, dwell_ms(v) / 1000.0, evidence(v), identity(v)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
