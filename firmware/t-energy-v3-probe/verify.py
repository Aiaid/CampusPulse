"""Check separate ESP32-S3 images and the existing partition geometry."""
import importlib.util
import json
from pathlib import Path
import struct
import sys

build = Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location('existing', Path(__file__).resolve().parent.parent / 'tools/verify_tenergy_partitions.py')
existing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(existing)
args = json.loads((build / 'flasher_args.json').read_text())
files = {int(k, 0): v for k, v in args['flash_files'].items()}
assert set(files) == {0, 0x8000, 0x10000}
for offset, name in files.items():
    path = (build / name).resolve()
    assert path.is_relative_to(build)
    data = path.read_bytes()
    assert data and offset + len(data) <= {0: 0x8000, 0x8000: 0x9000, 0x10000: 0x310000}[offset]
    if offset == 0x8000:
        existing.verify_partitions(data)
    else:
        assert data[0] == 0xe9 and data[3] >> 4 == 4 and struct.unpack_from('<H', data, 12)[0] == 9
    print(f'{name}: offset={offset:#x} bytes={len(data)}')
config = (build / 'sdkconfig').read_text()
for key in ('CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y', 'CONFIG_SPIRAM_MODE_OCT=y', 'CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y'):
    assert key in config
assert 'CONFIG_BT_ENABLED=y' not in config
print('geometry and image headers verified; no device accessed')
