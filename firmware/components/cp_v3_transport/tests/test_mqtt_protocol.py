from pathlib import Path
import os
import shlex
import subprocess
import tempfile

component=Path(__file__).resolve().parents[1]
firmware=component.parent
crypto=shlex.split(subprocess.check_output(['pkg-config','--cflags','--libs','openssl'],text=True))
with tempfile.TemporaryDirectory(prefix='cp-v3-mqtt-protocol-') as folder:
    binary=Path(folder)/'test'
    subprocess.run([os.environ.get('CC','cc'),'-std=c11','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',
        '-I',str(component/'tests/host'),'-I',str(component/'include'),'-I',str(component),
        '-I',str(firmware/'cp_network'),'-I',str(firmware/'cp_settings/include'),'-I',str(firmware/'cp_v3_evidence/include'),
        str(component/'tests/mqtt_protocol_test.c'),str(firmware/'cp_settings/settings_validate.c'),*crypto,'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True)
