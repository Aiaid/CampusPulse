"""Pure private Wi-Fi preflight shared by both V3 USB host tools.

No file, serial, network or persistent-store operations. Returned strings contain
credentials; callers must never log them. The printable-ASCII wire contract is
intentional, so admitted character lengths equal decoded byte lengths.
"""
import base64
import re


class WifiValidationError(ValueError):
    """Fixed diagnostic; never include private input values."""


def _text(value, minimum, maximum):
    if (type(value) is not str or not minimum <= len(value) <= maximum
            or any(not 32 <= ord(c) <= 126 for c in value)):
        raise WifiValidationError("invalid Wi-Fi text field")
    return value


def validate_ca(pem):
    """Require a single canonical PEM envelope and a real X.509 CA."""
    if type(pem) is not str or not 1 <= len(pem) <= 4096 or not pem.isascii():
        raise WifiValidationError("invalid single CA certificate")
    lines = pem.replace("\r\n", "\n").split("\n")
    if lines[-1] == "":
        lines.pop()
    if len(lines) < 3 or lines[0] != "-----BEGIN CERTIFICATE-----" or lines[-1] != "-----END CERTIFICATE-----":
        raise WifiValidationError("invalid single CA certificate")
    body = lines[1:-1]
    if any(not re.fullmatch(r"[A-Za-z0-9+/]{1,64}={0,2}", line) or len(line) > 64 or len(line) % 4 for line in body):
        raise WifiValidationError("invalid single CA certificate")
    if any(len(line) != 64 or "=" in line for line in body[:-1]):
        raise WifiValidationError("invalid single CA certificate")
    try:
        encoded = "".join(body)
        der = base64.b64decode(encoded, validate=True)
        if base64.b64encode(der).decode("ascii") != encoded:
            raise ValueError()
        from cryptography import x509
        from cryptography.hazmat.primitives.serialization import Encoding
        cert = x509.load_der_x509_certificate(der)
        if cert.public_bytes(Encoding.DER) != der or not cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
            raise ValueError()
        try:
            if not cert.extensions.get_extension_for_class(x509.KeyUsage).value.key_cert_sign:
                raise ValueError()
        except x509.ExtensionNotFound:
            pass
    except ImportError:
        raise WifiValidationError("cryptography dependency unavailable") from None
    except Exception:
        raise WifiValidationError("invalid single CA certificate") from None
    return pem


def validate_domain(value):
    domain = _text(value, 1, 253)
    labels = domain.split(".")
    if (re.fullmatch(r"[0-9.]+", domain)
            or any(not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label) for label in labels)):
        raise WifiValidationError("EAP server domain must be one DNS hostname")
    return domain


def validate_wifi(wifi, *, save_startup=False):
    if type(wifi) is not dict or type(save_startup) is not bool:
        raise WifiValidationError("invalid Wi-Fi configuration")
    mode = wifi.get("security", "personal")
    if mode not in ("open", "personal", "enterprise_peap"):
        raise WifiValidationError("unsupported Wi-Fi authentication mode")
    common = {"ssid", "password", "security"}
    eap = {"eap_username", "eap_identity", "eap_password", "eap_ca_pem", "eap_domain", "eap_server_verification"}
    allowed = common | (eap if mode == "enterprise_peap" else set())
    if set(wifi) - allowed or not {"ssid", "password"}.issubset(wifi):
        raise WifiValidationError("unexpected or missing Wi-Fi fields")
    payload = dict(ssid=_text(wifi["ssid"], 1, 32),
                   password=_text(wifi["password"], 0, 64), security=mode)
    if mode == "personal":
        password = payload["password"]
        if not 8 <= len(password) <= 64 or (len(password) == 64 and not re.fullmatch(r"[0-9A-Fa-f]{64}", password)):
            raise WifiValidationError("personal Wi-Fi requires an 8-63 byte passphrase or 64 hex digits")
    elif payload["password"]:
        raise WifiValidationError("open and PEAP Wi-Fi require an empty personal password")
    if mode == "enterprise_peap":
        if save_startup:
            raise WifiValidationError("PEAP startup verification selection is not stored; use manual USB setup")
        if not {"eap_username", "eap_password"}.issubset(wifi):
            raise WifiValidationError("PEAP credentials are required")
        # Empty form/JSON strings mean no trust material was supplied. Reject
        # wrong types before inference; whitespace or malformed nonempty CA
        # material must never silently select the unverified mode.
        for field in ("eap_ca_pem", "eap_domain"):
            if field in wifi and type(wifi[field]) is not str:
                raise WifiValidationError("invalid EAP trust field")
        verification = wifi.get("eap_server_verification", "ca" if wifi.get("eap_ca_pem", "") else "none")
        if verification not in ("ca", "none"):
            raise WifiValidationError("invalid EAP server verification selection")
        payload["eap_server_verification"] = verification
        if verification == "none":
            if wifi.get("eap_ca_pem", "") or wifi.get("eap_domain", ""):
                raise WifiValidationError("unverified PEAP cannot include CA or server domain")
        elif "eap_ca_pem" not in wifi or "eap_domain" not in wifi:
            raise WifiValidationError("verified PEAP requires CA and server domain")
        payload.update({field: _text(wifi[field], 1, 128) for field in ("eap_username", "eap_password")})
        identity = wifi.get("eap_identity", "")
        payload["eap_identity"] = _text(payload["eap_username"] if identity == "" else identity, 1, 128)
        if verification == "ca":
            payload.update(eap_ca_pem=validate_ca(wifi["eap_ca_pem"]), eap_domain=validate_domain(wifi["eap_domain"]))
    return payload
