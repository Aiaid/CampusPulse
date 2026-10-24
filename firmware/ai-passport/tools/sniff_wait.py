#!/usr/bin/env python3
"""等用户进页面开 LOG ON，然后抓固定时长的逐包日志。

    <IDF venv python> tools/sniff_wait.py [抓取秒数] [输出文件]

为什么要有这个脚本
------------------
连串口这个动作本身就会复位设备（pyserial 打开端口拉高 DTR，C3 的 DTR 接 EN），
所以"用户先开 LOG ON、我再抓包"这个顺序永远抓不到东西——LOG ON 会被这次
复位关掉。

正确顺序只能是：**先起抓包脚本（它会复位一次）→ 用户进页面开 LOG ON →
脚本检测到逐包数据开始计时**。这个脚本就是把"等"和"抓"合在一起，
省得来回两次。

判定"已经开始"的依据：日志里出现 `scan_ble: <MAC> rssi=` 行。
LOG ON 关着的时候一行都不会有，所以不存在误判。
"""
import re
import sys
import time

import serial

SNIFF_RE = re.compile(rb"scan_ble: [0-9A-F:]{17} rssi=")


def main() -> int:
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 60.0
    out_path = sys.argv[2] if len(sys.argv) > 2 else "_sniff.log"
    wait_max = float(sys.argv[3]) if len(sys.argv) > 3 else 240.0

    s = serial.Serial("COM5", 115200, timeout=0.3)
    # 打开端口已经把芯片按进复位了，立刻释放，让它跑起来。
    s.setDTR(False)
    s.setRTS(False)

    t0 = time.time()
    buf = bytearray()
    started = None
    try:
        while True:
            chunk = s.read(16384)
            if chunk:
                buf += chunk
            now = time.time()
            if started is None:
                if SNIFF_RE.search(bytes(buf[-65536:])):
                    started = now
                    print("[%5.1fs] 检测到逐包数据，开始计时 %.0f 秒"
                          % (now - t0, seconds), flush=True)
                elif now - t0 > wait_max:
                    print("超时 %.0fs 没等到 LOG ON（一行逐包数据都没有）" % wait_max,
                          flush=True)
                    break
            elif now - started >= seconds:
                print("[%5.1fs] 抓够 %.0f 秒，结束" % (now - t0, seconds), flush=True)
                break
    except KeyboardInterrupt:
        pass
    finally:
        s.close()

    with open(out_path, "wb") as f:
        f.write(buf)

    txt = buf.decode("utf-8", "replace")
    print("bytes=%d sniff=%d wdt=%d panic=%d -> %s"
          % (len(buf), txt.count("rssi="), txt.count("task_wdt"),
             txt.count("Guru Meditation"), out_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
