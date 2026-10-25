#pragma once
#if defined(__APPLE__)
#include <libkern/OSByteOrder.h>
#define htobe32(x) OSSwapHostToBigInt32(x)
#define be32toh(x) OSSwapBigToHostInt32(x)
#else
#include_next <endian.h>
#endif
