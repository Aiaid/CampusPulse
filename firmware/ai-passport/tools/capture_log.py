#!/usr/bin/env python3
"""抓串口日志。用法：

    <IDF venv python> tools/capture_log.py [秒数] [输出文件]

例：
    "D:/esp/idf/tools/python_env/idf5.5_py3.13_env/Scripts/python.exe" \\
        tools/capture_log.py 60 ../_capture.log

为什么需要这个脚本（本机踩过的坑，别再重复踩）
------------------------------------------------
**pyserial 一打开串口就会把设备复位。**

ESP32-C3 开发板的 DTR 通常接 EN，pyserial 的 `Serial()` 打开端口时会把 DTR 拉高，
芯片被按在复位里 —— 表现是"打开了串口，但一个字节都收不到"（读到 0 字节不是
设备坏了，是它根本没在跑）。等它把 DTR 拉低，芯片才从头启动，日志里会出现
`rst:0x15 (USB_UART_CHIP_RESET)`。

后果不止是丢一段日志：**页面状态会被清掉**。所以"用户在页面上按了 LOG ON"之后
再去开串口，LOG ON 就灭了、累计表也回不到刚才那页。

正确做法：打开端口后**立刻**把 DTR/RTS 都拉低（`setDTR(False)` / `setRTS(False)`），
让它尽快跑起来。复位仍然会发生（打开那一刻已经发生了），但至少不用等到
驱动默认状态自己恢复，也不会被 RTS 再按进下载模式。

**所以：需要"进页面之后"的日志时，先起这个脚本（它会复位一次），
再让用户进页面。顺序反了就要让用户重进。**
"""
import sys
import time

import serial


def main() -> int:
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 30.0
    out_path = sys.argv[2] if len(sys.argv) > 2 else "_capture.log"
    port = "COM5"
    baud = 115200

    s = serial.Serial(port, baud, timeout=0.3)
    # 关键：打开端口后立刻释放 DTR/RTS。
    # 不释放的话芯片会被一直按在复位里，读到 0 字节。
    s.setDTR(False)
    s.setRTS(False)

    t0 = time.time()
    buf = bytearray()
    try:
        while time.time() - t0 < seconds:
            chunk = s.read(16384)
            if chunk:
                buf += chunk
    except KeyboardInterrupt:
        pass
    finally:
        s.close()

    with open(out_path, "wb") as f:
        f.write(buf)

    txt = buf.decode("utf-8", "replace")
    print("bytes=%d sniff=%d stat=%d wdt=%d panic=%d -> %s"
          % (len(buf), txt.count("rssi="), txt.count("[STAT]"),
             txt.count("task_wdt"), txt.count("Guru Meditation"), out_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
