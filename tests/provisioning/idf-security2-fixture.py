"""Public synthetic fixtures from unmodified ESP-IDF 5.5.3 Security2 methods.
Run: IDF_PATH=... UV_CACHE_DIR=/tmp/campuspulse-uv-cache uv run --with
cryptography --with protobuf --with packaging tests/provisioning/idf-security2-fixture.py
No device credential, capture or real setup material is used here. The counterpart
is a mathematical server; actual SDK C interoperability is a separate host gate.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
sdk = Path(os.environ['IDF_PATH'])
sys.path.insert(0, str(sdk / 'tools/esp_prov'))
import proto
from security import srp6a
from security.security2 import Security2
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

pin = '00123456'
username = 'campuspulse'
client_random = bytes(range(32))
a = int.from_bytes(client_random, 'big') | (1 << 255)
srp6a.get_random_of_length = lambda _: a  # Deterministic entropy only.
client = Security2(1, username, pin, False)
cmd0 = client.setup0_request().encode('latin1')
N, g = srp6a.get_ng(srp6a.NG_3072)
H = lambda *parts: hashlib.sha512(b''.join(parts)).digest()
binint = lambda value: value.to_bytes((value.bit_length() + 7) // 8 or 1, 'big')
salt = bytes(range(16, 32))
b = int.from_bytes(bytes(range(32, 64)), 'big')
k = int.from_bytes(H(N.to_bytes(384, 'big'), g.to_bytes(384, 'big')), 'big')
x = int.from_bytes(H(salt, H((username + ':' + pin).encode())), 'big')
v = pow(g, x, N)
B = (k * v + pow(g, b, N)) % N
r0 = proto.session_pb2.SessionData(); r0.sec_ver = 2; r0.sec2.msg = 1
r0.sec2.sr0.device_pubkey = binint(B); r0.sec2.sr0.device_salt = salt
resp0 = r0.SerializeToString(); client.setup0_response(resp0.decode('latin1'))
cmd1 = client.setup1_request().encode('latin1')
u = int.from_bytes(H(client.srp6a_ctx.A.to_bytes(384, 'big'), B.to_bytes(384, 'big')), 'big')
K = H(binint(pow((client.srp6a_ctx.A * pow(v, u, N)) % N, b, N)))
A = binint(client.srp6a_ctx.A)
xor = bytes(a ^ b for a, b in zip(H(N.to_bytes(384, 'big')), H(g.to_bytes(384, 'big'))))
M = H(xor, H(username.encode()), salt, A, binint(B), K)
p = proto.session_pb2.SessionData(); p.ParseFromString(cmd1)
assert p.sec2.sc1.client_proof == M
r1 = proto.session_pb2.SessionData(); r1.sec_ver = 2; r1.sec2.msg = 3
r1.sec2.sr1.device_proof = H(A, M, K)
nonce = bytes(range(8)) + (1).to_bytes(4, 'big')
r1.sec2.sr1.device_nonce = nonce
resp1 = r1.SerializeToString(); client.setup1_response(resp1.decode('latin1'))
cipher = AESGCM(K[:32]); counter = 1
messages = [b'{"v":1,"op":"info"}', b'{"v":1,"ok":true,"node_id":"cp_001122aabbcc"}', b'odd', b'partial-boundaries']
stream = []
for i, msg in enumerate(messages):
    encrypted = cipher.encrypt(nonce[:8] + counter.to_bytes(4, 'big'), msg, None)
    if i % 2 == 0:
        assert client.encrypt_data(msg) == encrypted
    else:
        assert client.decrypt_data(encrypted) == msg
    stream.append({'direction': 'encrypt' if i % 2 == 0 else 'decrypt', 'plain': msg.hex(), 'cipher': encrypted.hex()})
    counter += 1
paths = ['tools/esp_prov/security/security2.py', 'tools/esp_prov/security/srp6a.py', 'components/protocomm/proto/sec2.proto', 'components/protocomm/proto/session.proto', 'components/protocomm/src/security/security2.c', 'components/protocomm/src/crypto/srp6a/esp_srp.c']
print(json.dumps({'source': 'ESP-IDF v5.5.3 official Python Security2 protocol methods; deterministic entropy and synthetic mathematical server', 'source_sha256': {p: hashlib.sha256((sdk / p).read_bytes()).hexdigest() for p in paths}, 'group_N': format(N, 'x'), 'group_g': g, 'pin': pin, 'username': username, 'client_random': client_random.hex(), 'server_private': binint(b).hex(), 'salt': salt.hex(), 'nonce': nonce.hex(), 'key': K[:32].hex(), 'cmd0': cmd0.hex(), 'resp0': resp0.hex(), 'cmd1': cmd1.hex(), 'resp1': resp1.hex(), 'stream': stream}, indent=2))
