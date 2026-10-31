"""Use actual budget core/provider with a fault-injected NVS API model."""
from pathlib import Path
import os
import subprocess
import tempfile
root=Path(__file__).resolve().parents[1]
budget=root.parent / "components/cp_v3_budget"
with tempfile.TemporaryDirectory(prefix="cp-budget-nvs-") as directory:
    executable=Path(directory)/"test"
    subprocess.run([os.environ.get("CC","cc"),"-std=c11","-D_POSIX_C_SOURCE=200809L","-Wall","-Wextra","-Werror",
        "-fsanitize=address,undefined","-fno-omit-frame-pointer","-I",str(root/"localtests/stubs"),"-I",str(budget/"include"),
        str(budget/"budget.c"),str(budget/"budget_nvs.c"),str(root/"localtests/budget_nvs_test.c"),"-o",str(executable)],check=True)
    subprocess.run([str(executable)],check=True)
