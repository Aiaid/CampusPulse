#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define PROBE_RECEIPT_CAP 768
#define PROBE_RECEIPT_GUARD_VERSION 2
typedef struct { char connection_id[37]; char colo[9]; } probe_receipt_t;
void probe_payload(uint8_t *out,size_t bytes,const uint8_t run[16],uint32_t seq);
void probe_hex(const uint8_t *in,size_t bytes,char *out);
bool probe_receipt(const char *json,size_t length,const char *run,uint32_t seq,
    size_t bytes,const char *sha,probe_receipt_t *out);
typedef struct {
    bool active,overflow;
    size_t frame_offset,frame_size,used;
    char buffer[PROBE_RECEIPT_CAP];
} probe_assembly_t;
// 1 complete bounded text message, 0 partial/control, -1 malformed/overflow.
int probe_fragment(probe_assembly_t *s,unsigned opcode,bool fin,int offset,int frame_size,
    const char *data,int length);
