#include "cpu_probe.h"
#if CFG_cpuStats
#include <inttypes.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"
#if !CONFIG_FREERTOS_UNICORE || CONFIG_FREERTOS_SMP || \
    !CONFIG_FREERTOS_GENERATE_RUN_TIME_STATS || !CONFIG_FREERTOS_USE_TRACE_FACILITY || \
    !CONFIG_FREERTOS_RUN_TIME_STATS_USING_ESP_TIMER || !CONFIG_FREERTOS_RUN_TIME_COUNTER_TYPE_U64
#error "cpuStats requires unicore non-SMP FreeRTOS trace, ESP_TIMER runtime statistics and U64"
#endif
_Static_assert(sizeof(configRUN_TIME_COUNTER_TYPE)==8,"CPU counters must be U64");

probe_cpu_point_t probe_cpu_begin(bool mqtt)
{
    probe_cpu_point_t p={0};TaskStatus_t status; /* One scalar, no status array. */
    int64_t started=esp_timer_get_time();
    // Switch the calling main task out so its current running tail is charged.
    // This yield is outside the protocol's recorded latency timestamp window.
    vTaskDelay(1);
    int64_t read_started=esp_timer_get_time();vTaskSuspendAll();
    TaskHandle_t task=xTaskGetCurrentTaskHandle();
    if(task){vTaskGetInfo(task,&status,pdFALSE,eInvalid);
        p.main_present=status.eCurrentState!=eDeleted&&status.eCurrentState!=eInvalid;
        p.main_id=(uint32_t)status.xTaskNumber;p.main_run=(uint64_t)status.ulRunTimeCounter;}
    if(mqtt){
        // Exact task name in pinned IDF5.5.3 esp-mqtt mqtt_client.c start().
        task=xTaskGetHandle("mqtt_task");
        if(task){vTaskGetInfo(task,&status,pdFALSE,eInvalid);
            p.mqtt_present=status.eCurrentState!=eDeleted&&status.eCurrentState!=eInvalid;
            p.mqtt_id=(uint32_t)status.xTaskNumber;p.mqtt_run=(uint64_t)status.ulRunTimeCounter;}
    }
    p.at_us=(uint64_t)esp_timer_get_time();(void)xTaskResumeAll();
    p.snapshot_read_us=(uint64_t)(esp_timer_get_time()-read_started);
    p.snapshot_wall_us=(uint64_t)(esp_timer_get_time()-started);return p;
}
void probe_cpu_end(const probe_cpu_point_t *before,const char *kind,const char *mode,
    size_t bytes,unsigned sample,bool mqtt,bool new_mqtt_allowed)
{
    probe_cpu_point_t after=probe_cpu_begin(mqtt);
    probe_cpu_delta_t d=probe_cpu_delta(before,&after,mqtt,new_mqtt_allowed);
    printf("COMPARE_CPU kind=%s mode=%s bytes=%u sample=%u main_us=%"PRIu64" mqtt_us=%"PRIu64
        " known=%u main_reason=%u mqtt_reason=%u mqtt_new=%u interval_us=%"PRIu64
        " snapshot_wall_us=%"PRIu64" snapshot_read_us=%"PRIu64"\n",kind,mode,(unsigned)bytes,sample,
        d.main_us,d.mqtt_us,d.known,d.main_reason,d.mqtt_reason,d.mqtt_new,d.interval_us,
        before->snapshot_wall_us+after.snapshot_wall_us,before->snapshot_read_us+after.snapshot_read_us);
}
void probe_cpu_control(void)
{
    for(unsigned i=0;i<2;i++){
        probe_cpu_point_t before=probe_cpu_begin(false);
        probe_cpu_end(&before,"control","empty",0,i,false,false);
    }
}
#endif
