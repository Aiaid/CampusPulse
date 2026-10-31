#include "raw_v3_queue_store.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static bool path(raw_v3_queue_store_t *s,unsigned slot,const char *suffix,char out[224]) {
    if(slot>=CP_V3_QUEUE_SLOTS) return false;
    int n=snprintf(out,224,"%s/q%02u.%s",s->directory,slot,suffix); return n>0&&n<224;
}
/* Directory state is never modified by probe. Do not follow host symlinks. */
static int exists(const char *name,struct stat *st) {
#ifdef ESP_PLATFORM
    int r=stat(name,st);
#else
    int r=lstat(name,st);
#endif
    return !r?1:errno==ENOENT?0:-1;
}
static bool sync_metadata(raw_v3_queue_store_t *s) {
    if(s->sync_metadata) return s->sync_metadata(s->sync_context);
#ifdef ESP_PLATFORM
    return false; /* FatFs callers MUST supply an explicit owning-volume sync. */
#else
    int fd=open(s->directory,O_RDONLY); if(fd<0) return false;
    bool ok=fsync(fd)==0; if(close(fd)) ok=false; return ok;
#endif
}
static int read_regular(const char *name,void *bytes,size_t cap,size_t *length) {
    struct stat st; *length=0;
    int r=exists(name,&st); if(r<=0) return r;
    if(!S_ISREG(st.st_mode)||st.st_size<=0||(uint64_t)st.st_size>cap) return 2;
    int fd=open(name,O_RDONLY); if(fd<0) return -1;
    struct stat actual; bool ok=fstat(fd,&actual)==0&&S_ISREG(actual.st_mode)&&actual.st_size==st.st_size;
    size_t got=0;
    while(ok&&got<(size_t)st.st_size) {
        ssize_t n=read(fd,(uint8_t *)bytes+got,(size_t)st.st_size-got);
        if(n<0&&errno==EINTR) continue;
        if(n<=0) { ok=false; break; } got+=(size_t)n;
    }
    uint8_t extra;
    if(ok&&read(fd,&extra,1)!=0) ok=false;
    if(ok&&(fstat(fd,&actual)||actual.st_size!=st.st_size)) ok=false;
    if(close(fd)) ok=false;
    if(!ok) return -1;
    *length=got; return 1;
}
static int load(void *context,unsigned slot,void *bytes,size_t cap,size_t *length) {
    raw_v3_queue_store_t *s=context; char name[224]; struct stat st;
    if(!s||!bytes||!length) return -1;
    *length=0;
    uint8_t tombstone[CP_V3_QUEUE_TOMBSTONE_BYTES]; size_t tombstone_bytes=0;
    if(!path(s,slot,"exp",name)) return -1;
    int expired=read_regular(name,tombstone,sizeof tombstone,&tombstone_bytes);
    cp_v3_queue_tombstone_t parsed;
    if(expired<0) return -1;
    if(expired&&(!cp_v3_queue_tombstone_decode(tombstone,tombstone_bytes,&parsed)||expired!=1)) return 2;
    const char *blocked[]={"tmp","ack","xtm"};
    for(unsigned i=0;i<3;i++) {
        if(!path(s,slot,blocked[i],name)) return -1;
        int r=exists(name,&st); if(r<0) return -1;
        if(r) {
            if(expired&&cap>=tombstone_bytes) { memcpy(bytes,tombstone,tombstone_bytes); *length=tombstone_bytes; return 4; }
            return 2;
        }
    }
    if(!path(s,slot,"rec",name)) return -1;
    int record=read_regular(name,bytes,cap,length);
    if(record==1&&expired) {
        cp_v3_queue_tombstone_t identity;
        if(!s->sha256||!cp_v3_queue_record_check(bytes,*length,slot,s->sha256,s->sha_context,&identity)||identity.ordinal<parsed.ordinal) {
            if(cap<tombstone_bytes) return 2;
            memcpy(bytes,tombstone,tombstone_bytes); *length=tombstone_bytes; return 4;
        }
        if(identity.ordinal==parsed.ordinal) {
            if(memcmp(identity.record_sha256,parsed.record_sha256,32)||strcmp(identity.body_sha256,parsed.body_sha256)||
               identity.source_expires_at_ms!=parsed.source_expires_at_ms||identity.body_bytes!=parsed.body_bytes) return 2;
            /* A synced exact expiry intent already authorized this deletion.
             * Finish recovery without presenting expired bytes as pending. */
            if(unlink(name)||!sync_metadata(s)) return -1;
            memcpy(bytes,tombstone,tombstone_bytes); *length=tombstone_bytes; return 3;
        }
        return 1; /* New complete record wins; old tombstone remains until sync. */
    }
    if(record) return record;
    if(expired) {
        if(cap<tombstone_bytes) return 2;
        memcpy(bytes,tombstone,tombstone_bytes); *length=tombstone_bytes; return 3;
    }
    return 0;
}
static bool write_exclusive(const char *name,const void *bytes,size_t length) {
    int fd=open(name,O_WRONLY|O_CREAT|O_EXCL,0600); if(fd<0) return false;
    bool ok=true; size_t done=0;
    while(done<length) {
        ssize_t n=write(fd,(const uint8_t *)bytes+done,length-done);
        if(n<0&&errno==EINTR) continue;
        if(n<=0) { ok=false; break; } done+=(size_t)n;
    }
    if(ok&&fsync(fd)) ok=false;
    if(close(fd)) ok=false;
    /* Any partial file is retained, occupying this slot until reviewed. */
    return ok;
}
static bool store(void *context,unsigned slot,const void *bytes,size_t length) {
    raw_v3_queue_store_t *s=context; size_t n; char temp[224],final[224];
    if(!s||!length||length>CP_V3_QUEUE_SLOT_BYTES||!path(s,slot,"tmp",temp)||!path(s,slot,"rec",final)) return false;
    int prior=load(s,slot,s->comparison,sizeof s->comparison,&n);
    if(prior!=0&&prior!=3) return false;
    if(!write_exclusive(temp,bytes,length)||!sync_metadata(s)) return false;
    /* Caller exclusively owns this directory. POSIX rename may overwrite, so
     * refuse an unexpected destination before invoking it; there are no other
     * queue writers while the external storage lock is held. */
    struct stat st; if(exists(final,&st)!=0||rename(temp,final)) return false;
    if(!sync_metadata(s)) return false;
    if(prior==3) {
        size_t got=0;
        if(load(s,slot,s->comparison,sizeof s->comparison,&got)!=1||got!=length||memcmp(s->comparison,bytes,length)) return false;
        char expired[224]; if(!path(s,slot,"exp",expired)||unlink(expired)||!sync_metadata(s)) return false;
    }
    return true;
}
static bool reclaim(void *context,unsigned slot,const void *bytes,size_t length) {
    raw_v3_queue_store_t *s=context; size_t got; char ack[224],record[224];
    if(!s||length>sizeof s->comparison||load(s,slot,s->comparison,sizeof s->comparison,&got)!=1||
       got!=length||memcmp(bytes,s->comparison,length)||!path(s,slot,"ack",ack)||!path(s,slot,"rec",record)) return false;
    /* Durable ACK-intent comes first. A crash at any later step either leaves
     * quarantined files or a free slot; it never drops unacknowledged evidence. */
    if(!write_exclusive(ack,bytes,length)||!sync_metadata(s)) return false;
    if(unlink(record)||!sync_metadata(s)) return false;
    if(unlink(ack)||!sync_metadata(s)) return false;
    return true;
}
bool raw_v3_queue_store_expire(void *context,unsigned slot,const void *bytes,size_t length,const cp_v3_queue_tombstone_t *t) {
    raw_v3_queue_store_t *s=context; size_t got; char temporary[224],expired[224],record[224];
    uint8_t encoded[CP_V3_QUEUE_TOMBSTONE_BYTES];
    if(!s||!bytes||length>sizeof s->comparison||!cp_v3_queue_tombstone_encode(t,encoded,sizeof encoded)||
       load(s,slot,s->comparison,sizeof s->comparison,&got)!=1||got!=length||memcmp(bytes,s->comparison,length)||
       !path(s,slot,"xtm",temporary)||!path(s,slot,"exp",expired)||!path(s,slot,"rec",record)) return false;
    uint8_t previous[CP_V3_QUEUE_TOMBSTONE_BYTES]; size_t previous_bytes=0;
    int prior=read_regular(expired,previous,sizeof previous,&previous_bytes);
    if(prior<0||prior==2) return false;
    if(prior==1) {
        /* Resume a confirmed exact intent after an interrupted body removal.
         * Never replace a different tombstone via FatFs rename-overwrite. */
        if(previous_bytes!=sizeof encoded||memcmp(previous,encoded,sizeof encoded)) return false;
    } else {
        if(!write_exclusive(temporary,encoded,sizeof encoded)||!sync_metadata(s)) return false;
        if(rename(temporary,expired)||!sync_metadata(s)) return false;
    }
    if(unlink(record)||!sync_metadata(s)) return false;
    return true;
}
bool raw_v3_queue_store_prepare(raw_v3_queue_store_t *s,const char *directory,
    bool (*sync)(void *),void *context,cp_v3_queue_store_t *out) {
    if(!s||!directory||!out||directory[0]!='/'||!directory[1]||strlen(directory)>=sizeof s->directory||
       strstr(directory,"..")||strstr(directory,"//")||directory[strlen(directory)-1]=='/') return false;
#ifdef ESP_PLATFORM
    if(!sync) return false;
#endif
    memset(s,0,sizeof *s); strcpy(s->directory,directory); s->sync_metadata=sync; s->sync_context=context;
    struct stat st; int r=exists(directory,&st);
    if(r<0||(r&&!S_ISDIR(st.st_mode))) return false;
    if(!r) {
        if(mkdir(directory,0700)||!sync_metadata(s)) return false;
#ifndef ESP_PLATFORM
        /* Creating the queue directory also changes its parent's metadata. */
        char parent[sizeof s->directory]; strcpy(parent,directory);
        char *slash=strrchr(parent,'/'); if(slash==parent) slash[1]=0; else *slash=0;
        int fd=open(parent,O_RDONLY); if(fd<0) return false;
        bool ok=fsync(fd)==0; if(close(fd)) ok=false; if(!ok) return false;
#endif
    }
    *out=(cp_v3_queue_store_t){s,load,store,reclaim}; return true;
}
void raw_v3_queue_store_set_hash(raw_v3_queue_store_t *s,cp_v3_sha256_fn hash,void *context) {
    if(s) { s->sha256=hash; s->sha_context=context; }
}
