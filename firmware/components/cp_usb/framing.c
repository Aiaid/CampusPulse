#include "cp_usb_frame.h"
#include <string.h>
enum { WAIT_RS, PREFIX, REQUEST_ID, SPACE, JSON };
void cp_usb_secure_clear(void *memory,size_t length)
{
    volatile uint8_t *p=memory;
    while (length--) *p++=0;
}
void cp_usb_frame_clear(cp_usb_frame_parser_t *p)
{
    if (!p) return;
    cp_usb_secure_clear(p->request_id,sizeof(p->request_id));
    cp_usb_secure_clear(p->json,sizeof(p->json));
    p->state=WAIT_RS;p->prefix_used=0;p->id_used=0;p->json_used=0;
}
void cp_usb_frame_init(cp_usb_frame_parser_t *p)
{if (p) memset(p,0,sizeof(*p));}
static bool hex(char c)
{return (c>='0'&&c<='9')||(c>='a'&&c<='f');}
bool cp_usb_uuid_v4(const char *s)
{
    if (!s || strlen(s)!=36 || s[14]!='4' || !(s[19]=='8'||s[19]=='9'||s[19]=='a'||s[19]=='b')) return false;
    for (unsigned i=0;i<36;++i) {
        if (i==8||i==13||i==18||i==23) {if (s[i]!='-') return false;}
        else if (!hex(s[i])) return false;
    }
    return true;
}
bool cp_usb_utf8_valid(const uint8_t *p,size_t length)
{
    if (!p && length) return false;
    for (size_t i=0;i<length;) {
        uint8_t first=p[i++];
        if (first<0x80) {if (!first) return false;continue;}
        unsigned remaining;uint32_t point,minimum;
        if (first>=0xc2 && first<=0xdf) {remaining=1;point=first&0x1f;minimum=0x80;}
        else if (first>=0xe0 && first<=0xef) {remaining=2;point=first&0x0f;minimum=0x800;}
        else if (first>=0xf0 && first<=0xf4) {remaining=3;point=first&7;minimum=0x10000;}
        else return false;
        if (remaining>length-i) return false;
        while (remaining--) {uint8_t c=p[i++];if ((c&0xc0)!=0x80)return false;point=(point<<6)|(c&0x3f);}
        if (point<minimum || point>0x10ffff || (point>=0xd800&&point<=0xdfff)) return false;
    }
    return true;
}
static void malformed(cp_usb_frame_parser_t *p)
{++p->malformed_frames;cp_usb_frame_clear(p);}
void cp_usb_frame_feed(cp_usb_frame_parser_t *p,const void *bytes,size_t length,
                       cp_usb_frame_fn receive,void *context)
{
    if (!p || (!bytes&&length) || !receive) return;
    const uint8_t *input=bytes;
    static const uint8_t prefix[]=CP_USB_PREFIX;
    for (size_t i=0;i<length;++i) {
        uint8_t c=input[i];
        if (c==0x1e) {
            if (p->state!=WAIT_RS) ++p->malformed_frames;
            cp_usb_frame_clear(p);p->state=PREFIX;p->prefix_used=1;continue;
        }
        switch (p->state) {
        case WAIT_RS: break;
        case PREFIX:
            if (c!=prefix[p->prefix_used]) {malformed(p);break;}
            if (++p->prefix_used==sizeof(prefix)-1u) p->state=REQUEST_ID;
            break;
        case REQUEST_ID:
            p->request_id[p->id_used++]=(char)c;
            if (p->id_used==36) {
                p->request_id[36]=0;
                if (!cp_usb_uuid_v4(p->request_id)) malformed(p);else p->state=SPACE;
            }
            break;
        case SPACE:
            if (c!=' ') malformed(p);else p->state=JSON;
            break;
        case JSON:
            if (c=='\n') {
                if (p->json_used && cp_usb_utf8_valid(p->json,p->json_used)) {
                    p->json[p->json_used]=0;
                    ++p->completed_frames;receive(context,p->request_id,p->json,p->json_used);
                    cp_usb_frame_clear(p);
                } else malformed(p);
            } else if (!c || c=='\r' || p->json_used>=CP_USB_JSON_MAX) malformed(p);
            else p->json[p->json_used++]=c;
            break;
        default: malformed(p);break;
        }
    }
}
bool cp_usb_frame_encode(const char *id,const uint8_t *json,size_t length,
                         uint8_t *out,size_t capacity,size_t *written)
{
    if (written) *written=0;
    const size_t prefix=sizeof(CP_USB_PREFIX)-1u;
    const size_t total=prefix+36u+1u+length+1u;
    if (!out || !written || !cp_usb_uuid_v4(id) || !length || length>CP_USB_JSON_MAX ||
        total>capacity || !cp_usb_utf8_valid(json,length)) return false;
    for (size_t i=0;i<length;++i) if (json[i]=='\n'||json[i]=='\r'||json[i]==0x1e) return false;
    memcpy(out,CP_USB_PREFIX,prefix);memcpy(out+prefix,id,36);out[prefix+36]=' ';
    memcpy(out+prefix+37,json,length);out[total-1]='\n';*written=total;return true;
}
