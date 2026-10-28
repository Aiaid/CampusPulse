#pragma once
#include <stddef.h>
#include "compare_config.h"
#include "cpu_math.h"
#if CFG_cpuStats
probe_cpu_point_t probe_cpu_begin(bool mqtt);
void probe_cpu_end(const probe_cpu_point_t *before,const char *kind,const char *mode,
    size_t bytes,unsigned sample,bool mqtt,bool new_mqtt_allowed);
void probe_cpu_control(void);
#else
static inline probe_cpu_point_t probe_cpu_begin(bool mqtt)
{(void)mqtt;return (probe_cpu_point_t){0};}
static inline void probe_cpu_end(const probe_cpu_point_t *before,const char *kind,const char *mode,
    size_t bytes,unsigned sample,bool mqtt,bool new_mqtt_allowed)
{(void)before;(void)kind;(void)mode;(void)bytes;(void)sample;(void)mqtt;(void)new_mqtt_allowed;}
static inline void probe_cpu_control(void){}
#endif
