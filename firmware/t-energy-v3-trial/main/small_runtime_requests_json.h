#pragma once
#include "cJSON.h"
#include <stdbool.h>
#include <stddef.h>
/* Only a complete authenticated error response can explicitly disable a
 * transient HTTP retry. No server free text or error body is logged. */
static inline bool te_small_server_retryable(const char *body,size_t bytes){
    if(!body||!bytes)return true;
    const char *end=NULL;cJSON *root=cJSON_ParseWithLengthOpts(body,bytes,&end,false);
    if(!root)return true;
    while(end<body+bytes&&(*end==' '||*end=='\n'||*end=='\r'||*end=='\t'))end++;
    const cJSON *error=cJSON_GetObjectItemCaseSensitive(root,"error");
    bool retryable=end!=body+bytes||!cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(error,"retryable"));
    cJSON_Delete(root);return retryable;
}
