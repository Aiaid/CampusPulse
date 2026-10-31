#include "flash_queue.h"
#include <string.h>

#define SECTOR 4096u
#define SLOT (2u * SECTOR)
#define HEADER 16u
#define MAGIC 0x51335643u

static uint32_t get32(const uint8_t *p) {
    return (uint32_t)p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24;
}
static void put32(uint8_t *p, uint32_t n) {
    p[0]=(uint8_t)n; p[1]=(uint8_t)(n>>8); p[2]=(uint8_t)(n>>16); p[3]=(uint8_t)(n>>24);
}
static uint32_t crc32(const uint8_t *p, size_t n) {
    uint32_t c=~0u;
    while (n--) { c^=*p++; for (unsigned i=0;i<8;i++) c=(c>>1) ^ (0xedb88320u & (0u-(c&1u))); }
    return ~c;
}
static bool read_at(te_flash_queue_t *s, size_t off, void *dst, size_t n) {
    return esp_partition_read(s->partition,off,dst,n)==ESP_OK;
}
/* Check every byte: a missing/torn header does not mean an empty slot. */
static int empty(te_flash_queue_t *s, unsigned slot) {
    uint8_t b[128]; size_t base=(size_t)slot*SLOT;
    for (size_t off=0;off<SLOT;off+=sizeof b) {
        if (!read_at(s,base+off,b,sizeof b)) return -1;
        for (size_t i=0;i<sizeof b;i++) if (b[i]!=0xff) return 0;
    }
    return 1;
}
static int load(void *ctx,unsigned slot,void *dst,size_t cap,size_t *len) {
    te_flash_queue_t *s=ctx; uint8_t h[HEADER];
    if (!s || !s->partition || !dst || !len || slot>=CP_V3_QUEUE_SLOTS) return -1;
    *len=0;
    if (s->uncertain & (1u<<slot)) return 2;
    size_t off=(size_t)slot*SLOT;
    if (!read_at(s,off,h,sizeof h)) return -1;
    if (get32(h)!=MAGIC || get32(h+12)!=~MAGIC) {
        int e=empty(s,slot); return e<0 ? -1 : e ? 0 : 2;
    }
    uint32_t n=get32(h+4);
    if (!n || n>CP_V3_QUEUE_SLOT_BYTES || n>cap || HEADER+n>SLOT) return 2;
    if (!read_at(s,off+HEADER,dst,n)) return -1;
    if (crc32(dst,n)!=get32(h+8)) return 2;
    uint8_t tail[128];
    for (size_t pos=HEADER+n; pos<SLOT;) {
        size_t count=SLOT-pos < sizeof tail ? SLOT-pos : sizeof tail;
        if (!read_at(s,off+pos,tail,count)) return -1;
        for (size_t i=0;i<count;i++) if (tail[i]!=0xff) return 2;
        pos+=count;
    }
    *len=n; return 1;
}
static bool store(void *ctx,unsigned slot,const void *bytes,size_t len) {
    te_flash_queue_t *s=ctx;
    if (!s || !s->partition || !bytes || !len || len>CP_V3_QUEUE_SLOT_BYTES || slot>=CP_V3_QUEUE_SLOTS ||
        (s->uncertain & (1u<<slot)) || empty(s,slot)!=1) return false;
    size_t off=(size_t)slot*SLOT;
    /* Mark uncertain in RAM before first write. Header is published last. */
    s->uncertain|=(uint16_t)(1u<<slot);
    if (esp_partition_write(s->partition,off+HEADER,bytes,len)!=ESP_OK ||
        !read_at(s,off+HEADER,s->comparison,len) || memcmp(bytes,s->comparison,len)) return false;
    uint8_t h[HEADER]; put32(h,MAGIC); put32(h+4,(uint32_t)len);
    put32(h+8,crc32(bytes,len)); put32(h+12,~MAGIC);
    if (esp_partition_write(s->partition,off,h,sizeof h)!=ESP_OK) return false;
    uint8_t check[HEADER];
    if (!read_at(s,off,check,sizeof check) || memcmp(h,check,sizeof h)) return false;
    s->uncertain&=(uint16_t)~(1u<<slot); return true;
}
static bool reclaim(void *ctx,unsigned slot,const void *bytes,size_t len) {
    te_flash_queue_t *s=ctx; size_t got=0;
    if (!s || !bytes || !len || len>sizeof s->comparison || slot>=CP_V3_QUEUE_SLOTS ||
        load(s,slot,s->comparison,sizeof s->comparison,&got)!=1 || got!=len || memcmp(bytes,s->comparison,len)) return false;
    s->uncertain|=(uint16_t)(1u<<slot);
    size_t off=(size_t)slot*SLOT;
    /* ACK was matched by queue before callback. Erase payload tail first;
     * erase header sector last, so interrupted reclaim stays occupied or free. */
    if (esp_partition_erase_range(s->partition,off+SECTOR,SECTOR)!=ESP_OK ||
        esp_partition_erase_range(s->partition,off,SECTOR)!=ESP_OK || empty(s,slot)!=1) return false;
    s->uncertain&=(uint16_t)~(1u<<slot); return true;
}
bool te_flash_queue_prepare(te_flash_queue_t *s,const esp_partition_t *p,cp_v3_queue_store_t *out) {
    if (!s || !p || !out || p->type!=ESP_PARTITION_TYPE_DATA || p->subtype!=0x40 ||
        strcmp(p->label,"v3queue") || p->encrypted || p->readonly || p->size!=TE_FLASH_QUEUE_BYTES ||
        p->address%SECTOR || p->erase_size!=SECTOR) return false;
    memset(s,0,sizeof *s); s->partition=p;
    *out=(cp_v3_queue_store_t){s,load,store,reclaim}; return true;
}
