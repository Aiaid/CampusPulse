"""Repair ESP-IDF 5.5.3 asynchronous transport error and retry signaling.

Read the installed SDK without modifying it. Generate the reviewed source only
inside the selected build directory, retaining Espressif's Apache-2.0 notices.
The connection state machine and TLS verification remain unchanged. A failed
socket-descriptor lookup retains its TLS object for normal transport cleanup;
nonblocking read waits report EAGAIN so HTTP can enforce its overall deadline.
"""
import argparse
import hashlib
import json
from pathlib import Path

SOURCE = "components/tcp_transport/transport_ssl.c"
EXPECTED = "7ea28eb0a05f5547794619b7fd48aad03b15bbfd5c6142f32266c892ff59fb0b"
FUNCTION = b"static int esp_tls_connect_async(esp_transport_handle_t t, const char *host, int port, int timeout_ms, bool is_plain_tcp)"
HELPER = b'''/* CampusPulse: async failures use the same error bridge as ssl_connect(). */
static void capture_async_tls_error(esp_transport_handle_t t, transport_esp_tls_t *ssl, esp_err_t fallback)
{
    esp_tls_error_handle_t tls_error;
    if (esp_tls_get_error_handle(ssl->tls, &tls_error) == ESP_OK) {
        esp_transport_set_errors(t, tls_error);
    }
    esp_tls_last_error_t *transport_error = esp_transport_get_error_handle(t);
    if (transport_error && transport_error->last_error == ESP_OK) {
        transport_error->last_error = fallback;
    }
}

'''
REPLACEMENTS = (
    (FUNCTION, HELPER + FUNCTION),
    (b'''        ssl->tls = esp_tls_init();
        if (!ssl->tls) {
            return -1;
        }
''', b'''        ssl->tls = esp_tls_init();
        if (!ssl->tls) {
            capture_tcp_transport_error(t, ERR_TCP_TRANSPORT_NO_MEM);
            return -1;
        }
'''),
    (b'''        int progress = esp_tls_conn_new_async(host, strlen(host), port, &ssl->cfg, ssl->tls);
        if (progress >= 0) {
            if (esp_tls_get_conn_sockfd(ssl->tls, &ssl->sockfd) != ESP_OK) {
                ESP_LOGE(TAG, "Error in obtaining socket fd for the session");
                esp_tls_conn_destroy(ssl->tls);
                return -1;
            }
        }
''', b'''        int progress = esp_tls_conn_new_async(host, strlen(host), port, &ssl->cfg, ssl->tls);
        if (progress < 0) {
            capture_async_tls_error(t, ssl, ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST);
        } else {
            esp_err_t socket_error = esp_tls_get_conn_sockfd(ssl->tls, &ssl->sockfd);
            if (socket_error != ESP_OK) {
                ESP_LOGE(TAG, "Error in obtaining socket fd for the session");
                capture_async_tls_error(t, ssl, socket_error);
                /* The transport owns this object until base_close(), including
                 * this failure path. Do not destroy it twice during cleanup. */
                return -1;
            }
        }
'''),
    (b'''static int ssl_read(esp_transport_handle_t t, char *buffer, int len, int timeout_ms)
{
    transport_esp_tls_t *ssl = ssl_get_context_data(t);
    ESP_STATIC_ANALYZER_CHECK(ssl == NULL, -1);

    int poll = esp_transport_poll_read(t, timeout_ms);
    if (poll == -1) {
        return ERR_TCP_TRANSPORT_CONNECTION_FAILED;
    }
    if (poll == 0) {
        return ERR_TCP_TRANSPORT_CONNECTION_TIMEOUT;
    }
''', b'''static int ssl_read(esp_transport_handle_t t, char *buffer, int len, int timeout_ms)
{
    transport_esp_tls_t *ssl = ssl_get_context_data(t);
    ESP_STATIC_ANALYZER_CHECK(ssl == NULL, -1);

    int poll = esp_transport_poll_read(t, timeout_ms);
    if (poll == -1) {
        return ERR_TCP_TRANSPORT_CONNECTION_FAILED;
    }
    if (poll == 0) {
        /* HTTP async body processing retries only when errno signals EAGAIN. */
        if (ssl->cfg.non_block) {
            errno = EAGAIN;
        }
        return ERR_TCP_TRANSPORT_CONNECTION_TIMEOUT;
    }
'''),
    (b'''        if (ret == ESP_TLS_ERR_SSL_WANT_READ || ret == ESP_TLS_ERR_SSL_TIMEOUT) {
            ret = ERR_TCP_TRANSPORT_CONNECTION_TIMEOUT;
        }
''', b'''        if (ret == ESP_TLS_ERR_SSL_WANT_READ || ret == ESP_TLS_ERR_SSL_TIMEOUT) {
            ret = ERR_TCP_TRANSPORT_CONNECTION_TIMEOUT;
            if (ssl->cfg.non_block) {
                errno = EAGAIN;
            }
        }
'''),
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def patch(original):
    if sha(original) != EXPECTED:
        raise ValueError("ESP-IDF transport source differs from the reviewed v5.5.3 fingerprint; refusing patch")
    patched = original
    for before, after in REPLACEMENTS:
        if patched.count(before) != 1:
            raise ValueError("Pinned async transport patch anchor differs; refusing patch")
        patched = patched.replace(before, after, 1)
    restored = patched
    for before, after in reversed(REPLACEMENTS):
        restored = restored.replace(after, before, 1)
    if restored != original:
        raise ValueError("Pinned async transport patch is not reversible; refusing patch")
    return patched


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--idf-path", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        patched = patch((args.idf_path / SOURCE).read_bytes())
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from error
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "transport_ssl.c").write_bytes(patched)
    manifest = {
        "sdk": "ESP-IDF v5.5.3", "source": SOURCE,
        "source_sha256": EXPECTED, "patched_sha256": sha(patched),
        "license": "Apache-2.0 (original notices retained)",
        "patch": "Bridge async TLS errors, retain single-owner cleanup and signal retryable async read waits",
        "replacement_count": len(REPLACEMENTS),
        "tls_verification_changed": False,
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Pinned async transport error propagation patch: ready")


if __name__ == "__main__":
    main()
