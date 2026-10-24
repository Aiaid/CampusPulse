"""Generate public test vectors using ESP-IDF 5.5.3's unmodified client.
Run with uv and an IDF Python environment. IDF_PATH selects the installed SDK.
All private keys and proof below are synthetic fixtures, never device secrets.
"""
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(os.environ['IDF_PATH']) / 'tools/esp_prov'))
import proto
from security.security1 import Security1
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
client_private = bytes(range(1, 33))
device_private = bytes(range(33, 65))
iv = bytes(range(16))
proof = '00112233445566778899aabbccddeeff'
client = Security1(proof, False)
def fixed_client_key():
    client.client_private_key = X25519PrivateKey.from_private_bytes(client_private)
    client.client_public_key = client.client_private_key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
client._Security1__generate_key = fixed_client_key
cmd0 = client.setup0_request().encode('latin1')
device = X25519PrivateKey.from_private_bytes(device_private)
device_pub = device.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
h = hashes.Hash(hashes.SHA256()); h.update(proof.encode()); digest = h.finalize()
shared = device.exchange(client.client_private_key.public_key())
key = bytes(a ^ b for a,b in zip(shared,digest))
cipher = Cipher(algorithms.AES(key), modes.CTR(iv)).encryptor()
r0 = proto.session_pb2.SessionData(); r0.sec_ver = 1; r0.sec1.msg = 1; r0.sec1.sr0.device_pubkey = device_pub; r0.sec1.sr0.device_random = iv
resp0 = r0.SerializeToString(); client.setup0_response(resp0.decode('latin1')); cmd1 = client.setup1_request().encode('latin1')
p = proto.session_pb2.SessionData(); p.ParseFromString(cmd1)
assert cipher.update(p.sec1.sc1.client_verify_data) == device_pub
r1 = proto.session_pb2.SessionData(); r1.sec_ver = 1; r1.sec1.msg = 3; r1.sec1.sr1.device_verify_data = cipher.update(client.client_public_key)
resp1 = r1.SerializeToString(); client.setup1_response(resp1.decode('latin1'))
messages = [b'{"v":1,"op":"info"}', b'{"v":1,"ok":true,"node_id":"cp_001122aabbcc"}', b'odd', b'partial-boundaries']
stream = []
for msg in messages:
    encrypted = client.encrypt_data(msg)
    assert cipher.update(encrypted) == msg
    stream.append({'plain':msg.hex(),'cipher':encrypted.hex()})
print(json.dumps({'source':'ESP-IDF v5.5.3 tools/esp_prov/security/security1.py (unmodified protocol methods)', 'proof':proof, 'client_private':client_private.hex(), 'device_private':device_private.hex(), 'iv':iv.hex(), 'cmd0':cmd0.hex(), 'resp0':resp0.hex(), 'cmd1':cmd1.hex(), 'resp1':resp1.hex(), 'stream':stream}, indent=2))
