#pragma once
/* Header-only build limit: no collector/network runtime dependency. */
#ifdef ESP_PLATFORM
#include "sdkconfig.h"
#endif
#ifdef CONFIG_CP_COLLECT_MAX_ADDRESSES
#define CP_COLLECT_ADDRESSES (CONFIG_CP_COLLECT_MAX_ADDRESSES + 0u)
#else
#define CP_COLLECT_ADDRESSES 128u
#endif
#if CP_COLLECT_ADDRESSES < 1 || CP_COLLECT_ADDRESSES > 512
#error "Collector build capacity must be between 1 and 512 addresses"
#endif
