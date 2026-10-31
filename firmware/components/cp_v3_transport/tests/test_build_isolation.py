from pathlib import Path
import os
import subprocess
import tempfile
import unittest

COMPONENT=Path(__file__).resolve().parents[1]

class BuildIsolation(unittest.TestCase):
    def probe(self,native):
        with tempfile.TemporaryDirectory(prefix='cp-v3-build-probe-') as folder:
            root=Path(folder);out=root/'result.txt';script=root/'probe.cmake'
            script.write_text(f'''cmake_minimum_required(VERSION 3.16)
set(CONFIG_CP_V3_NATIVE_MQTT {"ON" if native else "OFF"})
set(COMPONENT_LIB fake_component)
macro(idf_component_register)
    cmake_parse_arguments(PROBE "" "" "SRCS;INCLUDE_DIRS;PRIV_INCLUDE_DIRS;REQUIRES;PRIV_REQUIRES" ${{ARGN}})
endmacro()
function(idf_build_get_property out property)
    set(${{out}} "${{test_components}}" PARENT_SCOPE)
endfunction()
macro(target_link_libraries)
    set(test_links "${{ARGV}}")
endmacro()
include("{COMPONENT/'CMakeLists.txt'}")
file(WRITE "{out}" "${{PROBE_SRCS}}\n${{test_links}}\n")
''')
            result=subprocess.run(['cmake','-P',str(script)],capture_output=True,text=True)
            return result,(out.read_text() if out.exists() else '')

    def test_actual_component_config_gates_sources_and_global_wrappers(self):
        result,record=self.probe(False)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('mqtt_disabled.c',record);self.assertNotIn('mqtt_native.c',record);self.assertNotIn('--wrap=',record)
        result,record=self.probe(True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('mqtt_native.c',record);self.assertNotIn('mqtt_disabled.c',record)
        self.assertIn('--wrap=esp_transport_read',record);self.assertIn('--wrap=esp_transport_write',record)
        # The active transport owns its helpers; no retired network include or owner.
        self.assertNotIn('cp_network',(COMPONENT/'CMakeLists.txt').read_text())
        self.assertNotIn('mqtt_rpc.h',(COMPONENT/'mqtt_native.c').read_text())

    def test_disabled_translation_unit_has_no_mqtt_or_wrapper_sdk_symbols(self):
        with tempfile.TemporaryDirectory(prefix='cp-v3-disabled-') as folder:
            binary=Path(folder)/'disabled'
            subprocess.run([os.environ.get('CC','cc'),'-std=c11','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',
                '-I',str(COMPONENT/'tests/host'),'-I',str(COMPONENT/'include'),'-I',str(COMPONENT),
                '-I',str(COMPONENT.parent/'cp_settings/include'),'-I',str(COMPONENT.parent/'cp_v3_evidence/include'),
                str(COMPONENT/'mqtt_disabled.c'),str(COMPONENT/'tests/mqtt_disabled_test.c'),'-o',str(binary)],check=True)
            subprocess.run([str(binary)],check=True)
            symbols=subprocess.check_output(['nm','-g',str(binary)],text=True)
            self.assertNotIn('esp_mqtt_',symbols);self.assertNotIn('__wrap_esp_transport_',symbols)

if __name__=='__main__':unittest.main()
