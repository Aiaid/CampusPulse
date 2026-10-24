# 纯逻辑参考实现，用来和 C 版本对照（本机没有主机 gcc，用 Python 跑断言）。
#
# 覆盖：去重 / 窗口过期 / 容量淘汰 / 32 位回绕 / 名字继承 / 地址轮换合并 /
#       指纹 / top 排序 / 唤醒判定的三种场景。
import sys

KEY_LEN = 6
CAPACITY = 128
LIVE_WINDOW = 5000      # 离场判定
SHORT_WINDOW = 2000     # 短窗，瞬时变化
ACTIVE_WINDOW = 15000   # 宽窗，唤醒判定用
NAME_MAX = 16
FP_MAX = 31
FP_MERGE_RSSI = 6
PRUNE_INTERVAL = 200


def key_of(i):
    return bytes(KEY_LEN - 1) + bytes([i & 0xFF])


def make_key(val_le):
    return bytes(reversed(val_le))


def make_anon(seed, etype):
    return bytes([0xA0, (seed >> 24) & 0xFF, (seed >> 16) & 0xFF,
                  (seed >> 8) & 0xFF, seed & 0xFF, etype])


def fingerprint(data):
    if not data or len(data) > FP_MAX:
        return 0
    h = 0x811C
    for b in data:
        h ^= b
        h = (h * 0x0101) & 0xFFFF
        h ^= (h >> 7) & 0xFFFF
        h &= 0xFFFF
    return h or 1


class Entry:
    __slots__ = ("key", "anon", "rssi", "peak", "used", "name", "fp",
                 "manu", "last", "first")

    def __init__(self):
        self.used = False
        self.name = b""


class T:
    def __init__(self):
        self.e = [Entry() for _ in range(CAPACITY)]
        self.total = 0
        self.last_prune = 0

    def reset(self):
        self.__init__()

    def fresh(self, x, now, win=LIVE_WINDOW):
        # 纯读：不能改写 x.used，否则 count/top 会产生副作用
        return x.used and ((now - x.last) & 0xFFFFFFFF) < win

    def prune(self, now, win=LIVE_WINDOW):
        for x in self.e:
            if x.used and not self.fresh(x, now, win):
                x.used = False

    def find(self, k):
        for i, x in enumerate(self.e):
            if x.used and x.key == k:
                return i
        return -1

    def find_fp(self, fp, k, rssi, now, win=LIVE_WINDOW):
        if not fp:
            return -1
        best, best_dr = -1, 256
        for i, x in enumerate(self.e):
            if not self.fresh(x, now, win) or x.fp != fp or x.anon:
                continue
            if x.key == k:
                continue
            dr = abs(abs(x.rssi) - abs(rssi))
            if dr > FP_MERGE_RSSI:
                continue
            if dr < best_dr:
                best_dr, best = dr, i
        return best

    def _fill(self, x, k, anon, rssi, name, name_len, fp, manu, has_manu, now):
        x.key, x.anon, x.rssi, x.peak, x.used = k, anon, rssi, abs(rssi), True
        x.fp = fp
        x.manu = manu if has_manu else 0
        x.last = now
        x.first = now
        x.name = b""
        if name:
            k2 = min(name_len, NAME_MAX)
            if k2:
                x.name = name[:k2]

    def observe(self, k, anon, rssi, name, name_len, fp, manu, has_manu, now):
        i = self.find(k)
        if i >= 0:
            x = self.e[i]
            reentered = ((now - x.last) & 0xFFFFFFFF) > LIVE_WINDOW
            x.last, x.rssi = now, rssi
            if abs(rssi) < x.peak:
                x.peak = abs(rssi)
            if fp:
                x.fp = fp
            if has_manu:
                x.manu = manu
            if reentered:
                x.first = now
                self.total += 1
            if name:
                k2 = min(name_len, NAME_MAX)
                if k2:
                    x.name = name[:k2]
            return reentered

        m = self.find_fp(fp, k, rssi, now)
        if m >= 0:
            x = self.e[m]
            x.key, x.anon, x.last, x.rssi = k, anon, now, rssi
            if abs(rssi) < x.peak:
                x.peak = abs(rssi)
            if name:
                k2 = min(name_len, NAME_MAX)
                if k2:
                    x.name = name[:k2]
            return False

        free = [i for i, x in enumerate(self.e) if not x.used]
        slot = free[0] if free else min(range(CAPACITY), key=lambda i: self.e[i].last)
        self._fill(self.e[slot], k, anon, rssi, name, name_len, fp, manu, has_manu, now)
        self.total += 1
        return True

    def count(self, now, win=LIVE_WINDOW):
        return sum(1 for x in self.e if self.fresh(x, now, win))

    def top(self, now, mx, win=LIVE_WINDOW):
        live = [x for x in self.e if self.fresh(x, now, win)]
        live.sort(key=lambda x: -x.rssi)
        return live[:mx] if mx else []



def check(name, cond):
    # 注意 cond 是布尔表达式，不能用 `cond is False` 之类的写法，
    # 也不要在 check 里再算一遍——要排查失败时先把它拆成局部变量。
    if not cond:
        print("FAIL:", name, file=sys.stderr)
        sys.exit(1)


# --- 基础 ---------------------------------------------------------------
t = T()
k1 = key_of(1)
check("first", t.observe(k1, False, -60, None, 0, 0, 0, False, 1000) is True)
check("dup", t.observe(k1, False, -55, None, 0, 0, 0, False, 1200) is False)
check("count1", t.count(1500) == 1)
check("total1", t.total == 1)

t.observe(key_of(2), False, -80, None, 0, 0, 0, False, 1500)
t.observe(key_of(3), False, -50, None, 0, 0, 0, False, 1600)
check("count3", t.count(1700) == 3)
# k1 最后一次是 1200（不是 1000）。严格 < 判定：差 4999ms 还在，差 5000ms 就算走。
check("edge-5s", t.count(1200 + LIVE_WINDOW - 1) == 3)
check("expire-5s", t.count(1200 + LIVE_WINDOW) == 2)
check("expire-all", t.count(1600 + LIVE_WINDOW + 1) == 0)
check("total-sticky", t.total == 3)
check("wide-still-there", t.count(1600 + LIVE_WINDOW + 1, ACTIVE_WINDOW) == 3)
check("reenter", t.observe(k1, False, -60, None, 0, 0, 0, False,
                           1600 + LIVE_WINDOW + 500) is True)
check("total4", t.total == 4)

# --- 5 秒离场判定：走出去、再走回来 --------------------------------------
t = T()
kl = key_of(0x77)
t.observe(kl, False, -55, b"EV-Scooter", 10, 0, 0, False, 10000)
check("in-0s", t.count(10000) == 1)
check("in-3s", t.count(13000) == 1)
check("in-4.9s", t.count(14900) == 1)
check("out-5.001s", t.count(15001) == 0)
check("out-wide", t.count(15001, ACTIVE_WINDOW) == 1)
check("back", t.observe(kl, False, -58, b"EV-Scooter", 10, 0, 0, False, 18000) is True)
check("back-count", t.count(18000) == 1)
check("back-total", t.total == 2)
check("short-in", t.count(18000, SHORT_WINDOW) == 1)
check("short-out", t.count(20001, SHORT_WINDOW) == 0)

# 指纹合并的窗口边界
t = T()
a, b = key_of(0x55), key_of(0x56)
fpz = fingerprint(b"\x02\x01\x06")
t.observe(a, False, -60, b"X", 1, fpz, 0, False, 1000)
check("fp-merge-in5s", t.observe(b, False, -61, b"X", 1, fpz, 0, False, 4000) is False)
t = T()
a, b = key_of(0x55), key_of(0x57)
t.observe(a, False, -60, b"X", 1, fpz, 0, False, 1000)
check("fp-no-merge-after", t.observe(b, False, -61, b"X", 1, fpz, 0, False, 7000) is True)
# 注意：老条目最后一次是 1000，到 7000 已经超出 5 秒窗口，在场数为 1 是正确的。
# 要验证"没有合并"，得看宽窗口（15s）里它俩是不是两个独立身份。
check("fp-no-merge-count", t.count(7000, ACTIVE_WINDOW) == 2)

# --- 容量 / 回绕 --------------------------------------------------------
t = T()
for i in range(CAPACITY):
    t.observe(key_of(i), False, -60, None, 0, 0, 0, False, 3000 + i)
check("full", t.count(3000 + CAPACITY) == CAPACITY)
check("evict", t.observe(key_of(200), False, -50, None, 0, 0, 0, False,
                         3000 + CAPACITY) is True)
check("still-full", t.count(3001 + CAPACITY) == CAPACITY)

t = T()
t.observe(key_of(1), False, -55, None, 0, 0, 0, False, 0xFFFFFF00)
check("wrap", t.count(0x10) == 1)

# --- 名字 ---------------------------------------------------------------
t = T()
t.observe(k1, False, -60, b"NIU Link 4A2F", 13, 0, 0, False, 5000)
b = t.top(5100, 2)
check("name", b and b[0].name == b"NIU Link 4A2F")
t.observe(k1, False, -58, None, 0, 0, 0, False, 5200)
check("name-keep", t.top(5300, 2)[0].name == b"NIU Link 4A2F")
t.observe(k1, False, -58, b"ABCDEFGHIJKLMNOPQRSTUVWXYZ", 26, 0, 0, False, 5400)
check("name-trunc", len(t.top(5500, 2)[0].name) == NAME_MAX)

# --- 地址字节序 ---------------------------------------------------------
check("key-endian", make_key(bytes([0x01, 0xEE, 0xDD, 0xCC, 0xBB, 0xAA])) ==
      bytes([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x01]))

# --- 地址轮换合并 -------------------------------------------------------
t = T()
payload = b"\x02\x01\x06\x0d\x09MiBand 7"
fp = fingerprint(payload)
check("fp-nonzero", fp != 0)
kA, kB = key_of(0x11), key_of(0x22)
t.observe(kA, False, -62, b"MiBand 7", 9, fp, 0x0157, True, 1000)
check("merge-pre", t.count(1100) == 1)
check("merge", t.observe(kB, False, -63, b"MiBand 7", 9, fp, 0x0157, True, 1500) is False)
check("merge-count", t.count(1600) == 1)
check("merge-total", t.total == 1)
check("merge-newkey", t.find(kB) >= 0 and t.find(kA) < 0)
check("far-kept", t.observe(key_of(0x33), False, -30, b"MiBand 7", 9, fp, 0x0157, True, 1700) is True)
check("far-count", t.count(1800) == 2)
t.observe(key_of(0x44), False, -62, b"Other", 5, 0xBEEF, 0, False, 1900)
check("diff-fp", t.count(2000) == 3)

t = T()
t.observe(make_anon(1, 0), True, -55, None, 0, fp, 0, False, 3000)
t.observe(make_anon(2, 0), True, -55, None, 0, fp, 0, False, 3100)
check("anon-no-merge", t.count(3200) == 2)

# --- 指纹 ---------------------------------------------------------------
p = b"\x02\x01\x06\x03\x03\xaa\xfe"
q = b"\x02\x01\x06\x03\x03\xaa\xff"
check("fp-stable", fingerprint(p) == fingerprint(p))
check("fp-diff", fingerprint(p) != fingerprint(q))
check("fp-toolong", fingerprint(bytes(64)) == 0)
check("fp-empty", fingerprint(b"") == 0)

# --- top ----------------------------------------------------------------
t = T()
t.observe(key_of(10), False, -85, None, 0, 0, 0, False, 2000)
t.observe(key_of(11), False, -45, None, 0, 0, 0, False, 2000)
t.observe(key_of(12), False, -65, None, 0, 0, 0, False, 2000)
check("top-order", [x.rssi for x in t.top(2100, 4)] == [-45, -65, -85])
check("top-trunc", [x.rssi for x in t.top(2100, 2)] == [-45, -65])

# --- 唤醒判定 -----------------------------------------------------------
GATE_WINDOW = 6
GATE_DELTA = 3
GATE_RISE = 2
GATE_CONFIRM = 2
GATE_COOLDOWN = 30000


class Gate:
    def __init__(self, now=0):
        self.hist = []
        self.hits = 0
        self.last = now
        self.once = False

    def feed(self, c, now):
        self.hist.append(c)
        if len(self.hist) > GATE_WINDOW:
            self.hist.pop(0)
        if len(self.hist) < GATE_WINDOW:
            return False
        lo, hi = min(self.hist), max(self.hist)
        mean = sum(self.hist) // len(self.hist)
        active = (hi - lo) >= GATE_DELTA and c >= mean + GATE_RISE
        if not active:
            self.hits = 0
            return False
        if self.hits < GATE_CONFIRM:
            self.hits += 1
        if self.hits < GATE_CONFIRM:
            return False
        if self.once and (now - self.last) < GATE_COOLDOWN:
            return False
        self.last, self.once, self.hits = now, True, 0
        return True


g = Gate()
for i, v in enumerate([3, 3, 4, 3, 3, 4, 3, 3, 4, 3, 3, 3, 4, 3]):
    check("quiet", g.feed(v, i * 2000) is False)

g = Gate()
for i in range(20):
    check("crowded-static", g.feed(40 + (i % 2), i * 2000) is False)

g = Gate()
tm = 0
for v in [3, 3, 3, 4, 3, 3]:
    check("pre", g.feed(v, tm) is False)
    tm += 2000
fired = False
for v in [9, 10, 9, 9, 10, 9]:
    if g.feed(v, tm):
        fired = True
    tm += 2000
check("person-arrives", fired)
for _ in range(3):
    check("cooldown", g.feed(12, tm) is False)
    tm += 2000

# --- 电动车证据切换：改判据必须让旧结论作废 -----------------------------
#
# 守的是 v9 报的那个 bug：改了 A/B/C 勾选后车数不归零、也没有 loading。
# 根因是 scan_ble_set_evidence() 漏掉了 restart_vehicle_timer()，
# 旧判据下攒够的 30 秒被新判据直接继承。
VEHICLE_DWELL = 30000
EVID_A, EVID_B, EVID_C = 0x01, 0x02, 0x04
EVID_ALL = 0x07


class VEntry:
    __slots__ = ("key", "evidence", "phone", "periph", "connectable",
                 "last", "base", "dwell", "used")

    def __init__(self, key, evidence, phone=False, periph=False, connectable=False):
        self.key, self.evidence = key, evidence
        self.phone, self.periph, self.connectable = phone, periph, connectable
        self.last = 0
        self.base = 0
        self.dwell = 0
        self.used = True


class V:
    """只实现车判定需要的部分，和 scan_table.c 的判定顺序一一对应。"""

    def __init__(self):
        self.e = []

    def add(self, key, evidence, phone=False, periph=False, connectable=False):
        x = VEntry(key, evidence, phone, periph, connectable)
        self.e.append(x)
        return x

    def fresh(self, x, now):
        return x.used and ((now - x.last) & 0xFFFFFFFF) < LIVE_WINDOW

    def observe(self, x, now):
        # 对应 apply_class()：断档超过 5 秒就从这次重新起算。
        was_fresh = ((now - x.last) & 0xFFFFFFFF) < LIVE_WINDOW
        x.last = now
        if not was_fresh:
            x.base, x.dwell = now, 0
        else:
            x.dwell = (now - x.base) & 0xFFFFFFFF

    def tick(self, now):
        for x in self.e:
            if self.fresh(x, now):
                x.dwell = (now - x.base) & 0xFFFFFFFF

    def _candidate(self, x, now, mask):
        if not self.fresh(x, now):
            return False
        if x.phone or x.periph or x.connectable:
            return False
        return (x.evidence & mask) != 0

    def count_vehicle(self, now, mask):
        if mask == 0:
            return 0
        return sum(1 for x in self.e
                   if self._candidate(x, now, mask) and x.dwell >= VEHICLE_DWELL)

    def next_wait(self, now, mask):
        if mask == 0:
            return 0
        need_min = None
        for x in self.e:
            if not self._candidate(x, now, mask):
                continue
            if x.dwell >= VEHICLE_DWELL:
                return 0
            need = VEHICLE_DWELL - x.dwell
            need_min = need if need_min is None else min(need_min, need)
        return need_min or 0

    def restart_vehicle_timer(self, now):
        for x in self.e:
            if not self.fresh(x, now):
                continue
            x.base, x.dwell = now, 0


v = V()
car = v.add(key_of(0xC1), EVID_B)
phone = v.add(key_of(0xC2), 0, phone=True, connectable=True)

for now in range(1000, 41001, 1000):
    v.observe(car, now)
    v.observe(phone, now)
    v.tick(now)

check("veh-ready", v.count_vehicle(41000, EVID_B) == 1)
check("veh-ready-all", v.count_vehicle(41000, EVID_ALL) == 1)
check("veh-no-wait", v.next_wait(41000, EVID_B) == 0)
check("veh-phone-separate", sum(1 for x in v.e if v.fresh(x, 41000) and x.phone) == 1)

# 用户改勾选 → 旧结论作废：车数归 0，并报告"还要等满 30 秒"（界面 LOADING）。
v.restart_vehicle_timer(41000)
check("veh-reset-to-0", v.count_vehicle(41000, EVID_ALL) == 0)
check("veh-loading-30s", v.next_wait(41000, EVID_ALL) == VEHICLE_DWELL)

# 倒计时按真实进度走，不是一直卡在 30。
for now in range(42000, 51001, 1000):
    v.observe(car, now)
    v.tick(now)
check("veh-still-0", v.count_vehicle(51000, EVID_ALL) == 0)
check("veh-wait-20s", v.next_wait(51000, EVID_ALL) == 20000)

# 攒满 30 秒后重新出数。
for now in range(52000, 71001, 1000):
    v.observe(car, now)
    v.tick(now)
check("veh-back", v.count_vehicle(71000, EVID_ALL) == 1)
check("veh-back-nowait", v.next_wait(71000, EVID_ALL) == 0)

# 判据全关是"关闭"，不是"等待"。
check("veh-off", v.count_vehicle(71000, 0) == 0)
check("veh-off-nowait", v.next_wait(71000, 0) == 0)

print("scan_table_ref: all assertions passed")
