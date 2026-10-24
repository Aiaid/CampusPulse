@echo off
rem 现场抓包（停车场/车棚专用）—— 双击运行，抓 10 分钟，结束后按任意键关窗。
rem
rem 现场操作顺序（重要，别反）：
rem   1. 到地方后把设备插上电脑（或已插着）
rem   2. 双击本脚本 —— 它打开串口时会把设备复位重启一次，这是正常的
rem   3. 等设备屏幕亮起来，【双击 OK 键】打开 LOG（标题栏出现 LOG 字样）
rem      —— 不开 LOG 就没有逐包数据和 [BIKE]/[MISS] 诊断
rem   4. 然后该干嘛干嘛：走一圈、开关锁、站着不动对比……
rem   5. 想提前结束就直接关这个黑窗口；日志文件已经写在
rem      D:\esp\aiprogram\_现场_时间戳.log
rem
rem 时长想改就把下面的 600（秒）改成别的数。
chcp 65001 >nul
cd /d %~dp0
set STAMP=%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%_%TIME:~0,2%%TIME:~3,2%
set STAMP=%STAMP: =0%
echo 正在抓 600 秒，日志写到 ..\\..\\_现场_%STAMP%.log ...
"D:/esp/idf/tools/python_env/idf5.5_py3.13_env/Scripts/python.exe" capture_log.py 600 "..\..\_现场_%STAMP%.log"
pause
