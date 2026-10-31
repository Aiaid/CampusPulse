#pragma once
#include "cJSON.h"
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <math.h>
/* Only return fixed diagnostic literals. Never echo a server message, free
 * text, identifiers or an unrecognized code into the public serial log. */
static inline const char *edge_error_code(const char *body,size_t bytes,bool *retryable) {
    if(retryable)*retryable=true;
    if(!body||!bytes)return "unavailable";
    const char *end=NULL;cJSON *root=cJSON_ParseWithLengthOpts(body,bytes,&end,false);
    if(!root)return "unavailable";
    while(end<body+bytes&&(*end==' '||*end=='\n'||*end=='\r'||*end=='\t'))end++;
    const cJSON *error=cJSON_GetObjectItemCaseSensitive(root,"error"),*code=cJSON_GetObjectItemCaseSensitive(error,"code");
    const char *result="unavailable";
    static const char *const allowed[]={"v3_statistics_capture_unauthorized","v3_statistics_authority_missing",
        "v3_statistics_window_conflict","v3_statistics_batch_conflict","v3_statistics_conflict",
        "v3_receipt_not_committed","v3_statistics_policy_mismatch"};
    if(end==body+bytes&&cJSON_IsString(code))for(unsigned i=0;i<sizeof allowed/sizeof allowed[0];i++)
        if(!strcmp(code->valuestring,allowed[i])){result=allowed[i];if(retryable)*retryable=!cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(error,"retryable"));break;}
    cJSON_Delete(root);return result;
}
/* Frozen body has already passed queue hash/record verification. Do not modify
 * it, or treat missing/unknown UTC as zero for upload admissibility. */
static inline bool edge_json_time_upper(const cJSON *item,const char *key,uint64_t *upper) {
    const cJSON *t=cJSON_GetObjectItemCaseSensitive(item,key);
    if(!cJSON_IsArray(t)||cJSON_GetArraySize(t)!=4)return false;
    const cJSON *utc=cJSON_GetArrayItem(t,1),*unc=cJSON_GetArrayItem(t,3);
    if(!cJSON_IsNumber(utc)||!cJSON_IsNumber(unc)||!isfinite(utc->valuedouble)||!isfinite(unc->valuedouble)||utc->valuedouble<0||utc->valuedouble>8640000000000000.0||unc->valuedouble<0||unc->valuedouble>5000)return false;
    uint64_t u=(uint64_t)utc->valuedouble,v=(uint64_t)unc->valuedouble;
    if((double)u!=utc->valuedouble||(double)v!=unc->valuedouble)return false;
    if(u+v>*upper)*upper=u+v;
    return true;
}
static inline bool edge_frozen_upper(const char *body,size_t bytes,uint64_t *upper) {
    if(!body||!bytes||!upper)return false;
    const char *end=NULL;cJSON *root=cJSON_ParseWithLengthOpts(body,bytes,&end,false);
    if(!root)return false;
    while(end<body+bytes&&(*end==' '||*end=='\n'||*end=='\r'||*end=='\t'))end++;
    const cJSON *items=cJSON_GetObjectItemCaseSensitive(root,"x"),*kind=cJSON_GetObjectItemCaseSensitive(root,"k");
    bool valid=end==body+bytes&&cJSON_IsArray(items)&&cJSON_GetArraySize(items)==1&&cJSON_IsString(kind);
    const cJSON *item=cJSON_GetArrayItem(items,0);*upper=0;
    if(valid&&!strcmp(kind->valuestring,"candidate_events")){
        valid=edge_json_time_upper(item,"a",upper)&&edge_json_time_upper(item,"l",upper)&&edge_json_time_upper(item,"u",upper);
        const cJSON *terminal=cJSON_GetObjectItemCaseSensitive(item,"e");
        if(valid&&!cJSON_IsNull(terminal))valid=edge_json_time_upper(item,"e",upper);
    }else if(valid&&(!strcmp(kind->valuestring,"window_statistics")||!strcmp(kind->valuestring,"node_status")))valid=edge_json_time_upper(item,"t",upper);
    else valid=false;
    cJSON_Delete(root);return valid;
}
