"""Run the exact IDF HTTP parser and v3 protocol bounds with ASan/UBSan."""
from pathlib import Path
import os
import subprocess
import tempfile

component = Path(__file__).resolve().parents[1]
idf = Path(os.environ["IDF_PATH"])
parser = idf / "components/http_parser"
with tempfile.TemporaryDirectory(prefix="cp-v3-transport-tests-") as directory:
    executable = Path(directory) / "protocol-test"
    subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-D_DEFAULT_SOURCE", "-Wall", "-Wextra", "-Werror",
        "-Wno-unused-parameter", "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
        "-I", str(component / "tests/host"), "-I", str(component / "include"), "-I", str(component),
        "-I", str(component.parent / "cp_settings/include"), "-I", str(component.parent / "cp_v3_evidence/include"),
        "-I", str(parser), str(component / "protocol.c"), str(parser / "http_parser.c"),
        "-I", str(idf / "components/esp-tls"), "-I", str(idf / "components/mbedtls/mbedtls/include"),
        str(component / "tests/protocol_test.c"), "-o", str(executable)], check=True)
    subprocess.run([str(executable)], check=True)
