"""Real WebCrypto signature interoperability and portable hostile-input checks."""
from pathlib import Path
import json
import os
import shlex
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
IDF = Path(os.environ["IDF_PATH"])
GENERATOR = r"""
const {webcrypto} = require('node:crypto');
(async()=>{
 const key=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const other=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const spki=Buffer.from(await webcrypto.subtle.exportKey('spki',key.publicKey));
 const otherSpki=Buffer.from(await webcrypto.subtle.exportKey('spki',other.publicKey));
 const nonce='0123456789abcdef'.repeat(4);
 const fields={schema:'cp-v3-signed-clock/1',audience:'https://pulse.anend.net',key_id:'test-key_1',nonce,unix_ms:1793577600000,max_error_ms:1000};
 const transcript=`${fields.schema}\n${fields.audience}\n${fields.key_id}\n${nonce}\n${fields.unix_ms}\n${fields.max_error_ms}\n`;
 const sig=Buffer.from(await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,Buffer.from(transcript)));
 if(spki.length!==91||sig.length!==64)throw Error('unexpected crypto shape');
 console.log(JSON.stringify({spki:[...spki],otherSpki:[...otherSpki],nonce,body:JSON.stringify({...fields,sig:sig.toString('base64url')})}));
})();
"""

with tempfile.TemporaryDirectory(prefix="cp-v3-clock-") as directory:
    temp = Path(directory)
    generated = json.loads(subprocess.check_output(["node", "-e", GENERATOR], text=True))
    (temp / "generated.h").write_text(
        "static const unsigned char KEY[91]={" + ",".join(map(str, generated["spki"])) + "};\n"
        + "static const unsigned char OTHER_KEY[91]={" + ",".join(map(str, generated["otherSpki"])) + "};\n"
        + "static const char NONCE[]=" + json.dumps(generated["nonce"]) + ";\n"
        + "static const char BODY[]=" + json.dumps(generated["body"]) + ";\n"
    )
    (temp / "esp_err.h").write_text("typedef int esp_err_t;\n")
    flags = shlex.split(subprocess.check_output(["pkg-config", "--cflags", "--libs", "openssl"], text=True))
    binary = temp / "verify"
    # Pinned upstream cJSON uses sprintf; macOS marks that declaration deprecated.
    # Limit this suppression to that unchanged upstream translation unit.
    vendor = temp / "cjson.o"
    subprocess.run(["cc", "-std=c11", "-fsanitize=address,undefined",
                    "-Wno-deprecated-declarations", "-c",
                    str(IDF / "components/json/cJSON/cJSON.c"), "-o", str(vendor)], check=True)
    subprocess.run([
        "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined",
        "-fno-omit-frame-pointer", "-I" + str(temp),
        "-I" + str(HERE.parent / "include"),
        "-I" + str(ROOT / "firmware/components/cp_settings/include"),
        "-I" + str(ROOT / "firmware/components/cp_v3_evidence/include"),
        "-I" + str(IDF / "components/json/cJSON"),
        str(HERE / "test_verify.c"), str(HERE.parent / "verify.c"),
        str(vendor), *flags, "-o", str(binary),
    ], check=True)
    subprocess.run([str(binary)], check=True)
