#pragma once
void cp_test_perf_log(const char *, ...);
#define ESP_LOGI(tag, ...) ((void)(tag), cp_test_perf_log(__VA_ARGS__))
