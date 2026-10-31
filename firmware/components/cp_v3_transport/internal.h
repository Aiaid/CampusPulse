#pragma once
#include "cp_v3_transport.h"
#include "http_parser.h"

typedef struct { char host[254], authority[264]; uint16_t port; } cp_v3_origin_t;
typedef struct {
    http_parser parser;
    char *body;
    size_t capacity, used, header_bytes, key_used, value_used;
    char key[64], value[512];
    bool value_started, headers_done, complete, failed, date_seen, date_valid;
    uint64_t date_ms;
} cp_v3_http_response_t;
bool cp_v3_transport_origin(const char *, cp_v3_origin_t *);
bool cp_v3_transport_path(cp_v3_http_method_t, const char *);
bool cp_v3_transport_receipt_only_path(cp_v3_http_method_t, const char *);
bool cp_v3_transport_anchor(const cp_v3_time_t *, uint64_t now, cp_v3_time_t *);
bool cp_v3_transport_date(const char *, uint64_t *);
void cp_v3_http_init(cp_v3_http_response_t *, char *, size_t);
bool cp_v3_http_feed(cp_v3_http_response_t *, const void *, size_t);
bool cp_v3_http_eof(cp_v3_http_response_t *);
/* Incomplete data cannot be treated as a response/clock, but numeric evidence
 * must survive cleanup so retry investigation does not erase its failure. */
void cp_v3_transport_clear_response(cp_v3_transport_response_t *);
void cp_v3_transport_note_headers(cp_v3_transport_response_t *, const cp_v3_http_response_t *);
bool cp_v3_transport_should_flush_dns(const cp_v3_transport_config_t *, const cp_v3_transport_response_t *,
    bool network_failure, bool is_owner, bool cancelled);
