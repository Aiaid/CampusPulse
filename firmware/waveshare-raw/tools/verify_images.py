"""Check the offline raw recorder's resolved config and separate flash images."""
import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path
import struct


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify(build):
    build = build.resolve()
    lines = set((build / 'sdkconfig').read_text().splitlines())
    for key in ('IDF_TARGET_ESP32S3', 'ESPTOOLPY_FLASHSIZE_8MB',
                'ESPTOOLPY_FLASHMODE_DIO', 'SPIRAM', 'SPIRAM_MODE_OCT',
                'ESP_CONSOLE_USB_SERIAL_JTAG', 'BT_NIMBLE_ENABLED',
                'BT_NIMBLE_ROLE_OBSERVER', 'BT_NIMBLE_EXT_ADV',
                'BT_NIMBLE_EXT_SCAN', 'FATFS_LFN_HEAP'):
        require(f'CONFIG_{key}=y' in lines, f'Missing configuration: {key}')
    require('CONFIG_ESPTOOLPY_HEADER_FLASHSIZE_UPDATE=y' not in lines,
            'Image flash size must remain fixed')
    desc = json.loads((build / 'project_description.json').read_text())
    require(desc['target'] == 'esp32s3', 'Wrong target')
    components = desc['build_components']
    experimental_usb_v2 = 'CONFIG_RAW_USB_PROVISION_V2=y' in lines
    if experimental_usb_v2:
        expected_shared = {'cp_core', 'cp_settings', 'cp_network', 'cp_provision'}
        require({name for name in components if name.startswith('cp_')} == expected_shared,
                'Unexpected shared runtime in experimental USB-v2 adapter')
    else:
        require(not any(name.startswith('cp_') for name in components),
                'Shared firmware components must not be linked in default image')
    # IDF Bluetooth dependencies can register esp_wifi even when its client
    # routines are removed by the linker. Check the actual ELF as well.
    if not experimental_usb_v2:
        require('mqtt' not in components, 'Unexpected MQTT dependency')
    nm = shutil.which('xtensa-esp32s3-elf-nm')
    require(nm is not None, 'Activate the ESP32-S3 toolchain to inspect the ELF')
    symbols = subprocess.check_output([nm, '--defined-only', str(build / 'waveshare_raw.elf')], text=True)
    names = {line.split()[-1] for line in symbols.splitlines() if line.split()}
    if not experimental_usb_v2:
        require(not names.intersection({'esp_wifi_init', 'esp_wifi_start', 'esp_wifi_connect',
                'esp_mqtt_client_init', 'esp_mqtt_client_start', 'esp_http_client_init'}),
                'The default offline recorder must not contain network client entry points')
    require('cp_usb_start' not in names, 'A second USB console reader must not be linked')
    lvgl_path = next((Path(path) for name, path in
                      zip(components, desc['build_component_paths'])
                      if name == 'lvgl__lvgl'), None)
    require(lvgl_path is not None and 'version: 9.5.0' in
            (lvgl_path / 'idf_component.yml').read_text(), 'Expected LVGL 9.5.0')
    args = json.loads((build / 'flasher_args.json').read_text())
    images = {int(offset, 0): name for offset, name in args['flash_files'].items()}
    require(set(images) == {0, 0x8000, 0x10000}, 'Only separate images may be delivered')
    report = {'target': 'esp32s3', 'flash_bytes': 8 * 1024 * 1024,
              'experimental_usb_v2': experimental_usb_v2, 'images': {}}
    for offset, name in images.items():
        path = (build / name).resolve()
        require(path.is_relative_to(build), 'Image path outside build directory')
        data = path.read_bytes()
        limit = {0: 0x8000, 0x8000: 0x9000, 0x10000: 0x310000}[offset]
        require(data and offset + len(data) <= limit, 'Image crosses allowed bounds')
        if offset == 0x8000:
            partitions = {}
            for pos in range(0, len(data), 32):
                entry = data[pos:pos + 32]
                if entry[:2] in (b'\xff\xff', b'\xeb\xeb'):
                    break
                require(len(entry) == 32 and entry[:2] == b'\xaa\x50', 'Invalid partition')
                _, kind, subtype, start, size, label, _ = struct.unpack('<HBBII16sI', entry)
                label = label.rstrip(b'\0').decode('ascii')
                require(label not in partitions, 'Duplicate partition')
                partitions[label] = (kind, subtype, start, size)
            require(partitions == {'nvs': (1, 2, 0x9000, 0x6000),
                    'phy_init': (1, 1, 0xf000, 0x1000),
                    'factory': (0, 0, 0x10000, 0x300000)}, 'Unexpected partition geometry')
        else:
            require(len(data) >= 24 and data[0] == 0xe9, 'Invalid ESP image')
            require(data[2] == 2 and data[3] >> 4 == 3,
                    'Expected DIO / 8 MB image header')
            require(struct.unpack_from('<H', data, 12)[0] == 9, 'Wrong image chip')
        report['images'][name] = {'offset': hex(offset), 'bytes': len(data),
                                  'sha256': hashlib.sha256(data).hexdigest()}
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('build', type=Path)
    print(json.dumps(verify(parser.parse_args().build), indent=2))
