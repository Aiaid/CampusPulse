"""Verify the isolated S3 v3 trial's image boundaries and security settings."""
import hashlib
import json
from pathlib import Path
import struct
import sys


def verify(root):
    root = Path(root).resolve()
    config = set((root / 'sdkconfig').read_text().splitlines())
    for flag in ('IDF_TARGET_ESP32S3', 'ESPTOOLPY_FLASHSIZE_8MB', 'ESPTOOLPY_FLASHMODE_DIO',
                 'SPIRAM', 'SPIRAM_MODE_OCT', 'ESP_CONSOLE_USB_SERIAL_JTAG',
                 'MBEDTLS_HAVE_TIME', 'MBEDTLS_HAVE_TIME_DATE', 'MBEDTLS_CERTIFICATE_BUNDLE',
                 'MBEDTLS_EXTERNAL_MEM_ALLOC', 'MBEDTLS_DYNAMIC_BUFFER',
                 'BT_NIMBLE_MEM_ALLOC_MODE_EXTERNAL',
                 'BT_NIMBLE_ROLE_OBSERVER', 'ESP_COEX_SW_COEXIST_ENABLE'):
        assert f'CONFIG_{flag}=y' in config, flag
    description = json.loads((root / 'project_description.json').read_text())
    assert description['target'] == 'esp32s3'
    components = set(description['build_components'])
    assert not components.intersection(('cp_network', 'cp_provision', 'cp_runtime', 'mqtt'))
    assert {'cp_v3_control', 'cp_v3_transport', 'cp_v3_queue', 'cp_v3_evidence'} <= components
    files = json.loads((root / 'flasher_args.json').read_text())['flash_files']
    assert {int(offset, 0) for offset in files} == {0, 0x8000, 0x10000}
    report = {'target': 'esp32s3', 'flash_bytes': 8388608, 'images': {}}
    for offset, name in files.items():
        address = int(offset, 0)
        path = (root / name).resolve()
        assert path.is_relative_to(root)
        data = path.read_bytes()
        assert data and address + len(data) <= {0: 0x8000, 0x8000: 0x9000, 0x10000: 0x310000}[address]
        if address != 0x8000:
            assert data[0] == 0xe9 and struct.unpack_from('<H', data, 12)[0] == 9
            assert data[2] == 2 and data[3] >> 4 == 3
        report['images'][name] = {'offset': address, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    return report


if __name__ == '__main__':
    print(json.dumps(verify(sys.argv[1]), indent=2))
