#pragma once
#include <stdint.h>
typedef unsigned UBaseType_t;
typedef int BaseType_t;
typedef uint8_t StackType_t;
typedef int portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED 0
#define pdFALSE 0
#define pdTRUE 1
#if CP_TEST_COUNTER_BITS == 64
#define configRUN_TIME_COUNTER_TYPE uint64_t
#else
#define configRUN_TIME_COUNTER_TYPE uint32_t
#endif
void cp_test_perf_enter(portMUX_TYPE *);
void cp_test_perf_exit(portMUX_TYPE *);
#define portENTER_CRITICAL(p) cp_test_perf_enter(p)
#define portEXIT_CRITICAL(p) cp_test_perf_exit(p)
