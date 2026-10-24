"""Apply the single reviewed ESP-IDF 5.5.3 Security2 IV-alignment repair.

The installed SDK is read-only. Its exact original SHA-256 is mandatory; output
is generated in the build directory with all upstream Apache-2.0 notices intact.
No algorithm, group, wire field, nonce byte count, or counter order is changed.
"""
import argparse
import hashlib
import json
from pathlib import Path

SOURCE = "components/protocomm/src/security/security2.c"
EXPECTED = "d6dedb2b759c4ae45c1c88ff251de4ba1f830e5b896c0193ef01ce69c2a862bc"
BEFORE = b"    uint8_t iv[AES_GCM_IV_SIZE];"
AFTER = b"    _Alignas(uint32_t) uint8_t iv[AES_GCM_IV_SIZE];"
WRAPPER = b'''/* CampusPulse build-only layout assertions; upstream implementation stays in
 * security2.c with its original Apache-2.0 notices. */
#include <stddef.h>
#include "security2.c"
_Static_assert(offsetof(session_t, iv) % _Alignof(aes_gcm_iv_t) == 0,
               "Security2 IV storage must meet counter alignment");
_Static_assert(sizeof(((session_t *)0)->iv) == 12,
               "Security2 wire nonce must stay exactly 12 bytes");
_Static_assert(sizeof(aes_gcm_iv_t) == 12,
               "Security2 session-id/counter layout must stay unchanged");
'''

def sha(data):
    return hashlib.sha256(data).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--idf-path', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    original = (args.idf_path / SOURCE).read_bytes()
    if sha(original) != EXPECTED or original.count(BEFORE) != 1:
        raise SystemExit('ESP-IDF Security2 source differs from the reviewed v5.5.3 fingerprint; refusing patch')
    patched = original.replace(BEFORE, AFTER)
    assert patched.replace(AFTER, BEFORE) == original
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'security2.c').write_bytes(patched)
    (args.output / 'security2_checked.c').write_bytes(WRAPPER)
    manifest = {'sdk': 'ESP-IDF v5.5.3', 'source': SOURCE,
                'source_sha256': EXPECTED, 'patched_sha256': sha(patched),
                'wrapper_sha256': sha(WRAPPER),
                'license': 'Apache-2.0 (original notices retained)',
                'patch': 'Align the private IV array to uint32_t; no wire or algorithm change',
                'replacement_count': 1, 'nonce_bytes': 12}
    (args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Pinned Security2 IV alignment patch and layout assertions: ready')

if __name__ == '__main__':
    main()
