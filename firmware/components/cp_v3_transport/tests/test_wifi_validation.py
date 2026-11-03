# /// script
# dependencies = ["cryptography>=44"]
# ///
"""Synthetic trust material, actual mbedTLS verification and sanitizers; no radio."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import os
import subprocess
import tempfile
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID

component = Path(__file__).resolve().parents[1]
prefix = Path(os.environ.get("MBEDTLS_PREFIX", "/opt/homebrew/opt/mbedtls@3"))
now = datetime.now(timezone.utc)

def cert(key, issuer_key, subject, issuer, before, after, ca, signing=True):
    b = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, subject)]))
         .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, issuer)]))
         .public_key(key.public_key()).serial_number(x509.random_serial_number())
         .not_valid_before(before).not_valid_after(after)
         .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
         .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
            key_encipherment=False, data_encipherment=False, key_agreement=False,
            key_cert_sign=ca and signing, crl_sign=ca and signing,
            encipher_only=False, decipher_only=False), critical=True))
    if not ca:
        b = b.add_extension(x509.SubjectAlternativeName([x509.DNSName("radius.synthetic.invalid")]), critical=False)
        b = b.add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
    return b.sign(issuer_key, hashes.SHA256()).public_bytes(serialization.Encoding.PEM)

with tempfile.TemporaryDirectory(prefix="cp-v3-eap-validation-") as temp:
    folder = Path(temp)
    key = ec.generate_private_key(ec.SECP256R1())
    other = ec.generate_private_key(ec.SECP256R1())
    peer = ec.generate_private_key(ec.SECP256R1())
    values = [
        cert(key,key,"Synthetic CA","Synthetic CA",now-timedelta(days=1),now+timedelta(days=365),True),
        cert(peer,key,"Synthetic Peer","Synthetic CA",now-timedelta(hours=1),now+timedelta(days=1),False),
        cert(other,other,"Other CA","Other CA",now-timedelta(days=1),now+timedelta(days=365),True),
        cert(peer,key,"Expired Peer","Synthetic CA",now-timedelta(days=3),now-timedelta(days=2),False),
        cert(peer,key,"Future Peer","Synthetic CA",now+timedelta(days=2),now+timedelta(days=3),False),
        cert(key,key,"Expired CA","Expired CA",now-timedelta(days=4),now-timedelta(days=2),True),
        cert(peer,key,"Synthetic Peer","Expired CA",now-timedelta(hours=1),now+timedelta(days=1),False),
        cert(key,key,"Synthetic CA","Synthetic CA",now+timedelta(days=2),now+timedelta(days=365),True),
        cert(key,key,"Invalid Usage CA","Invalid Usage CA",now-timedelta(days=1),now+timedelta(days=365),True,False),
    ]
    paths = []
    for i, data in enumerate(values):
        path = folder / f"synthetic-{i}.pem"
        path.write_bytes(data)
        paths.append(str(path))
    binary = folder / "verify"
    subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-D_POSIX_C_SOURCE=200809L", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
        "-I", str(component / "tests/host"), "-I", str(component / "include"), "-I", str(prefix / "include"),
        "-I", str(component.parent / "cp_settings/include"), "-I", str(component.parent / "cp_v3_evidence/include"),
        str(component / "wifi_validation.c"), str(component.parent / "cp_settings/settings_validate.c"), str(component / "tests/wifi_validation_test.c"),
        "-L", str(prefix / "lib"), "-lmbedx509", "-lmbedcrypto", "-lm", "-o", str(binary)], check=True)
    subprocess.run([str(binary), *paths], check=True)
