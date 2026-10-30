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
static int load(void *context,unsigned slot,void *bytes,size_t cap,size_t *length) {
    raw_v3_queue_store_t *s=context; char name[224]; struct stat st;
    if(!s||!bytes||!length) return -1;
    *length=0;
    const char *blocked[]={"tmp","ack"};
    for(unsigned i=0;i<2;i++) {
        if(!path(s,slot,blocked[i],name)) return -1;
        int r=exists(name,&st); if(r<0) return -1; if(r) return 2;
    }
    if(!path(s,slot,"rec",name)) return -1;
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
    if(!s||!length||length>CP_V3_QUEUE_SLOT_BYTES||load(s,slot,s->comparison,sizeof s->comparison,&n)!=0||
       !path(s,slot,"tmp",temp)||!path(s,slot,"rec",final)) return false;
    if(!write_exclusive(temp,bytes,length)||!sync_metadata(s)) return false;
    /* Caller exclusively owns this directory. POSIX rename may overwrite, so
     * refuse an unexpected destination before invoking it; there are no other
     * queue writers while the external storage lock is held. */
    struct stat st; if(exists(final,&st)!=0||rename(temp,final)) return false;
    return sync_metadata(s);
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
