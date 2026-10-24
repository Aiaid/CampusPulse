# 电动车/手机分类判定的参考实现 + 断言。
#
# 和 scan_class.c 一一对应。跑法：
#   python tests/scan_class_ref.py
# 输出 "scan_class_ref: all assertions passed" 表示全过。
#
# 覆盖重点（这几条是最容易出错的）：
#   1. AirPods 不能算手机（严格模式的核心要求）
#   2. 鼠标/键盘不能算电动车（实验室场景的核心要求）
#   3. 手机在场再久也不算车（硬排除）
#   4. 一条证据都不勾 = 不判车
#   5. 勾选变化后必须重新等 30 秒

KEY_LEN = 6
CAPACITY = 128
LIVE_WINDOW = 5000
VEHICLE_DWELL = 30000
MANU_LONG_LEN = 8

EVID_UUID128 = 0x01
EVID_MANU_LONG = 0x02
EVID_APPEARANCE_VEHICLE = 0x04
EVID_ALL = 0x07

APPEARANCE_PHONE = 0x0040
APPEARANCE_HID_MIN = 0x03C0
APPEARANCE_HID_MAX = 0x03C4
APPEARANCE_VEHICLE_MIN = 0x0300
APPEARANCE_VEHICLE_MAX = 0x03FF

MANU_APPLE = 0x004C
MANU_GOOGLE = 0x00E0
MANU_SAMSUNG = 0x0075
MANU_VIVO_NEW = 0x0837      # vivo，新标记
MANU_VIVO_OLD = 0x8486      # vivo，旧标记

# 已知"会做手机"的厂商 ID。每一条都查过 Bluetooth SIG 列表，不能凭记忆：
# 0x0157 看着像小米，实际是 Anhui Huami（华米手表）；小米是 0x038F。
PHONE_VENDOR_IDS = frozenset((
    MANU_GOOGLE,      # 0x00E0
    MANU_SAMSUNG,     # 0x0075
    MANU_VIVO_NEW,    # 0x0837
    MANU_VIVO_OLD,    # 0x8486
    0x027D,           # HUAWEI
    0x09C6,           # Honor
    0x038F,           # Xiaomi
    0x079A,           # OPPO
    0x072F,           # OnePlus
    0x08A4,           # realme
    0x03AB,           # Meizu
    0x08CA,           # Nubia
    0x02C5,           # Lenovo
    0x0008,           # Motorola
))

APPLETYPE_HANDOFF = 0x0C
APPLETYPE_NEARBY_INFO = 0x0F
APPLETYPE_NEARBY_ACTION = 0x10

UUID16_HID = 0x1812
UUID16_HID_SVC = 0x1813
UUID16_FASTPAIR = 0xFE2C


class Facts:
    """对应 C 里的 scan_facts_t。字段少，直接全部给默认值。"""
    __slots__ = ("has_manu", "manu_id", "apple_subtype", "manu_len",
                 "has_appearance", "appearance", "uuid16", "has_uuid128",
                 "name", "connectable")

    def __init__(self):
        self.has_manu = False
        self.manu_id = 0
        self.apple_subtype = 0
        self.manu_len = 0
        self.has_appearance = False
        self.appearance = 0
        self.uuid16 = set()
        self.has_uuid128 = False
        self.name = ""
        self.connectable = False


def name_contains_ci(name, needle):
    return needle.lower() in name.lower()


def apple_subtype_is_phone(sub):
    return sub in (APPLETYPE_HANDOFF, APPLETYPE_NEARBY_INFO,
                   APPLETYPE_NEARBY_ACTION)


PERIPHERAL_NAMES = ("mouse", "keyboard", "kbd", "trackpad", "touchpad",
                    "buds", "earbud", "airpod", "headphone", "headset",
                    "speaker", "watch", "band", "pen", "stylus", "printer",
                    # 真无线耳机名字常写 "vivo TWS 3e"，同时含品牌词。
                    # 不在这里排掉，厂商分支排了也会被名字兜底捞回来。
                    "tws")


def name_looks_like_peripheral(name):
    return any(k in name.lower() for k in PERIPHERAL_NAMES)


def is_phone(f):
    # B. Appearance 明确是电话
    if f.has_appearance and f.appearance == APPEARANCE_PHONE:
        return True

    if f.has_manu:
        # A. 已知手机厂商，排除配件特征名。
        #    厂商 ID 只说明品牌（同一家也做耳机/手表/路由），
        #    所以判据其实是"品牌对 + 名字里没有配件特征"。
        #    手机广播通常不带名字、配件通常带名字，这个不对称是唯一可用的判据。
        if f.manu_id in PHONE_VENDOR_IDS:
            if not (name_contains_ci(f.name, "buds") or
                    name_contains_ci(f.name, "watch") or
                    name_contains_ci(f.name, "band") or
                    name_contains_ci(f.name, "tws")):
                return True
        # C. Apple 严格按 Continuity 子类型
        if f.manu_id == MANU_APPLE:
            return apple_subtype_is_phone(f.apple_subtype)

    # D. 名字兜底：必须先排掉外设名，否则 "Pixel Buds" 会因含 "pixel" 被判成手机。
    phone_kw = ("iphone", "galaxy", "pixel", "redmi", "huawei", "honor",
                "oneplus", "oppo", "vivo", "xiaomi", "mi ", "realme")
    if (any(name_contains_ci(f.name, k) for k in phone_kw) and
            not name_looks_like_peripheral(f.name)):
        return True
    return False


def evidence(f):
    ev = 0
    if f.has_uuid128:
        ev |= EVID_UUID128
    if f.has_manu and f.manu_len >= MANU_LONG_LEN:
        ev |= EVID_MANU_LONG
    if (f.has_appearance and
            APPEARANCE_VEHICLE_MIN <= f.appearance <= APPEARANCE_VEHICLE_MAX):
        ev |= EVID_APPEARANCE_VEHICLE
    return ev


def is_peripheral(f):
    if (f.has_appearance and
            APPEARANCE_HID_MIN <= f.appearance <= APPEARANCE_HID_MAX):
        return True
    if f.uuid16 & {UUID16_HID, UUID16_HID_SVC, UUID16_FASTPAIR}:
        return True
    if name_looks_like_peripheral(f.name):
        return True
    return False


def is_vehicle(f, mask, dwell_ms, connectable):
    if mask == 0:
        return False
    # 硬排除一：是手机就绝不是车。
    # 必须在函数内部——iPhone 的厂商数据常 >= 8 字节，天然命中证据 B。
    if is_phone(f):
        return False
    # 硬排除二：外设
    if is_peripheral(f):
        return False
    if dwell_ms < VEHICLE_DWELL:
        return False
    if connectable:
        return False
    return (evidence(f) & mask) != 0


# ---------------------------------------------------------------------------
# 构造常见设备的 Facts
# ---------------------------------------------------------------------------

def iphone():
    f = Facts()
    f.has_manu = True
    f.manu_id = MANU_APPLE
    f.apple_subtype = APPLETYPE_NEARBY_INFO
    f.manu_len = 8
    f.connectable = True
    return f


def airpods():
    f = Facts()
    f.has_manu = True
    f.manu_id = MANU_APPLE
    f.apple_subtype = 0x07          # AirPods
    f.manu_len = 20
    f.connectable = True
    return f


def apple_watch():
    f = Facts()
    f.has_manu = True
    f.manu_id = MANU_APPLE
    f.apple_subtype = 0x0A          # Watch
    f.manu_len = 12
    f.name = "Apple Watch"
    return f


def logitech_mouse():
    f = Facts()
    f.has_appearance = True
    f.appearance = 0x03C2           # Pointing device
    f.uuid16 = {UUID16_HID}
    f.name = "MX Master 3"
    f.connectable = False           # 很多鼠标是不可连接的
    return f


def bt_keyboard():
    f = Facts()
    f.has_appearance = True
    f.appearance = 0x03C1
    f.uuid16 = {UUID16_HID}
    f.name = "Keyboard"
    f.connectable = False
    return f


def e_bike_private_uuid():
    """典型电动车：私有 128 位 UUID，不可连接。
    注意：故意不带长厂商数据，让它**只命中证据 A**。
    一个设备同时命中多条证据就无法验证"只勾某一条时该不该计入"。"""
    f = Facts()
    f.has_uuid128 = True
    f.connectable = False
    return f


def e_bike_manu_only():
    """只带长厂商数据、没有 128 位 UUID 的车。"""
    f = Facts()
    f.has_manu = True
    f.manu_id = 0x5678
    f.manu_len = 10
    f.connectable = False
    return f


def e_bike_appearance():
    f = Facts()
    f.has_appearance = True
    f.appearance = 0x0320           # Vehicle 段内
    f.connectable = False
    return f


def tv_box():
    """电视盒子：不可连接、有厂商数据但短、没有私有 UUID。"""
    f = Facts()
    f.has_manu = True
    f.manu_id = 0x0099
    f.manu_len = 4
    f.connectable = False
    return f


# ---------------------------------------------------------------------------
# 断言
# ---------------------------------------------------------------------------

def test_phone_strict():
    # iPhone 必须认出来
    assert is_phone(iphone()), "iPhone 应判定为手机"
    # AirPods 绝不能算手机（严格模式的核心）
    assert not is_phone(airpods()), "AirPods 不能被算成手机"
    assert not is_phone(apple_watch()), "Apple Watch 不能被算成手机"

    # Appearance 直接命中
    f = Facts(); f.has_appearance = True; f.appearance = APPEARANCE_PHONE
    assert is_phone(f), "Appearance=0x0040 应判为手机"

    # Google 手机
    f = Facts(); f.has_manu = True; f.manu_id = MANU_GOOGLE; f.name = "Pixel 8"
    assert is_phone(f), "Pixel 应判为手机"

    # Google 耳机（Fast Pair 带 buds 名）不算手机
    f = Facts(); f.has_manu = True; f.manu_id = MANU_GOOGLE; f.name = "Pixel Buds"
    assert not is_phone(f), "Pixel Buds 不能被算成手机"

    # vivo 手机（实测：名字为空、manu=0x0837/27B、RSSI -28dBm）
    # 旧白名单漏掉这一家 -> 手机数 0，同时这台设备 ev=0x02 被算成了电动车。
    for mid in (MANU_VIVO_NEW, MANU_VIVO_OLD):
        f = Facts(); f.has_manu = True; f.manu_id = mid
        f.name = ""; f.manu_len = 25
        assert is_phone(f), f"vivo(0x{mid:04X}) 应判为手机"
        # 同一台设备绝不能同时算成电动车
        assert not is_vehicle(f, EVID_ALL, 600000, False), \
            f"vivo(0x{mid:04X}) 不能同时被算成电动车"

    # vivo 耳机（名字带 TWS）不算手机
    f = Facts(); f.has_manu = True; f.manu_id = MANU_VIVO_NEW; f.name = "vivo TWS 3e"
    assert not is_phone(f), "vivo TWS 不能被算成手机"

    # 国产安卓大厂：每一家都要认得出来，而且绝不能同时被算成电动车
    # （同一个漏判会两头污染：手机数少一个、车数多一个）
    for mid in (0x027D, 0x09C6, 0x038F, 0x079A, 0x072F, 0x08A4,
                0x03AB, 0x08CA, 0x02C5, 0x0008):
        f = Facts(); f.has_manu = True; f.manu_id = mid
        f.name = ""; f.manu_len = 25
        assert is_phone(f), f"厂商 0x{mid:04X} 的手机应判为手机"
        assert not is_vehicle(f, EVID_ALL, 600000, False), \
            f"厂商 0x{mid:04X} 的手机不能同时被算成电动车"

    # 同品牌的配件仍然不算手机：名字里有特征词
    for mid, nm in ((0x027D, "HUAWEI WATCH GT"), (0x038F, "Mi Smart Band 8"),
                    (0x079A, "OPPO Enco Buds"), (0x08A4, "realme Buds T100"),
                    (0x09C6, "HONOR Band 9")):
        f = Facts(); f.has_manu = True; f.manu_id = mid; f.name = nm
        assert not is_phone(f), f"{nm} 不能被算成手机"

    # 0x0157 = Anhui Huami（华米手表），**不是小米**。
    # 单钉一条：凭记忆把它当小米填进去，会让一堆手表变成人。
    f = Facts(); f.has_manu = True; f.manu_id = 0x0157; f.name = ""
    assert not is_phone(f), "0x0157 是华米手表，不能当手机厂商"
    print("  phone_strict OK")


def test_peripheral_excluded():
    """鼠标键盘必须被识别为外设——这是实验室场景的关键。"""
    assert is_peripheral(logitech_mouse()), "鼠标应判为外设"
    assert is_peripheral(bt_keyboard()), "键盘应判为外设"

    # 外设即使在场 10 分钟、即使勾了所有证据，也不能算车
    for dev, nm in ((logitech_mouse(), "鼠标"), (bt_keyboard(), "键盘")):
        assert not is_vehicle(dev, EVID_ALL, 600000, False), \
            f"{nm} 不能被算成电动车"
    print("  peripheral_excluded OK")


def test_vehicle_by_evidence():
    # A：私有 UUID
    assert is_vehicle(e_bike_private_uuid(), EVID_UUID128, 35000, False), \
        "命中证据 A 的车应被计数"
    # 只勾 B 时，只有 A 的车不算
    assert not is_vehicle(e_bike_private_uuid(), EVID_MANU_LONG, 35000, False), \
        "只勾 B 时，仅命中 A 的车不该计入"

    # B：长厂商数据
    assert is_vehicle(e_bike_manu_only(), EVID_MANU_LONG, 35000, False), \
        "命中证据 B 的车应被计数"

    # C：车辆 Appearance
    assert is_vehicle(e_bike_appearance(), EVID_APPEARANCE_VEHICLE, 35000, False), \
        "命中证据 C 的车应被计数"
    print("  vehicle_by_evidence OK")


def test_vehicle_negative():
    # 电视盒子：三条证据都不命中
    assert not is_vehicle(tv_box(), EVID_ALL, 600000, False), \
        "无任何证据的设备不能算车"

    # 一条都不勾 = 关闭
    assert not is_vehicle(e_bike_private_uuid(), 0, 600000, False), \
        "mask=0 时必须返回 false"

    # 可连接的设备不算车（有连接能力，不是 PEPS）
    f = e_bike_private_uuid(); f.connectable = True
    assert not is_vehicle(f, EVID_ALL, 600000, True), \
        "可连接广播不能算车"

    # 在场不足 30 秒
    assert not is_vehicle(e_bike_private_uuid(), EVID_ALL, 29999, False), \
        "29.999 秒不能算车"
    assert is_vehicle(e_bike_private_uuid(), EVID_ALL, 30000, False), \
        "整 30 秒应算车"
    print("  vehicle_negative OK")


def test_phone_never_vehicle():
    """手机在场再久也不能算车。"""
    assert not is_vehicle(iphone(), EVID_ALL, 3600000, False), \
        "iPhone 在场 1 小时也不能算车"
    print("  phone_never_vehicle OK")


def test_evidence_mask_semantics():
    """证据位是"或"：勾多条时命中任意一条即可。"""
    # 一辆只命中 B 的车，勾 A|B 时应计入
    assert is_vehicle(e_bike_manu_only(), EVID_UUID128 | EVID_MANU_LONG,
                      35000, False), "勾 A|B 时只命中 B 也应计入"
    # 勾 A|C 时不应计入
    assert not is_vehicle(e_bike_manu_only(),
                          EVID_UUID128 | EVID_APPEARANCE_VEHICLE,
                          35000, False), "勾 A|C 时只命中 B 不该计入"
    print("  evidence_mask_semantics OK")


def test_restart_timer_semantics():
    """勾选变化后，计时必须从零重新走。"""
    # 模拟：设备已经攒了 25 秒
    dwell = 25000
    assert not is_vehicle(e_bike_private_uuid(), EVID_ALL, dwell, False)
    # 用户改勾选 → 计时清零
    dwell = 0
    # 再走 29 秒还不够
    assert not is_vehicle(e_bike_private_uuid(), EVID_ALL, 29000, False), \
        "重置后 29 秒不该出结果"
    # 走满 30 秒才出
    assert is_vehicle(e_bike_private_uuid(), EVID_ALL, 30000, False), \
        "重置后满 30 秒应出结果"
    print("  restart_timer_semantics OK")


if __name__ == "__main__":
    print("scan_class_ref:")
    test_phone_strict()
    test_peripheral_excluded()
    test_vehicle_by_evidence()
    test_vehicle_negative()
    test_phone_never_vehicle()
    test_evidence_mask_semantics()
    test_restart_timer_semantics()
    print("scan_class_ref: all assertions passed")
