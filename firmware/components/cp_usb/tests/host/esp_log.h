#pragma once
void cp_test_log(const char*,const char*,unsigned);
#define ESP_LOGI(tag,format,value) cp_test_log(tag,format,value)
