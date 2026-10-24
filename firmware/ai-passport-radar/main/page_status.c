#include "page_status.h"
#include "ui_mini.h"

#include <stddef.h>
#include <stdio.h>
#include <string.h>

// Preserve bounded snapshot reads even when a caller fills an entire field.
// Only printable ASCII reaches the inherited font/UTF-8 decoder.
static void value_text(int y, const char *value, size_t capacity)
{
    char line[32];
    size_t n = 0;
    while (n < capacity && n < sizeof line - 1 && value[n]) {
        const unsigned char ch = (unsigned char)value[n];
        line[n++] = ch >= 32 && ch <= 126 ? (char)ch : '?';
    }
    line[n] = '\0';
    const int width = UI_W - 36;
    if (ui_text_width(line) > width) {
        while (n > 0) {
            line[--n] = '\0';
            if (ui_text_width(line) + ui_text_width("...") <= width) break;
        }
        if (n + 3 < sizeof line) {
            line[n++] = '.';
            line[n++] = '.';
            line[n++] = '.';
            line[n] = '\0';
        }
    }
    ui_text(24, y, line[0] ? line : "--", UI_COL_FG);
}

static void field(int y, const char *label, const char *value, size_t capacity)
{
    ui_text(12, y, label, UI_COL_MUTED);
    value_text(y + 20, value, capacity);
}

static void paint_status(void *arg)
{
    const cp_status_view_t *view = arg;
    ui_clear(UI_COL_BG);
    if(view->setup_active){
        ui_text(12,6,view->setup_softap?"Wi-Fi hotspot setup":"Bluetooth setup",UI_COL_TEAL);
        field(36,"Node",view->node_id,sizeof view->node_id);
        field(76,view->setup_softap?"Wi-Fi name":"Device name",view->setup_name,sizeof view->setup_name);
        char part[17];memcpy(part,view->setup_proof,16);part[16]=0;
        ui_text(12,116,"Setup proof",UI_COL_MUTED);value_text(136,part,sizeof part);
        memcpy(part,view->setup_proof+16,16);part[16]=0;value_text(156,part,sizeof part);
        if(view->setup_softap){ui_text(12,186,"Wi-Fi password",UI_COL_MUTED);
            memcpy(part,view->setup_password,16);part[16]=0;value_text(206,part,sizeof part);
            memcpy(part,view->setup_password+16,16);part[16]=0;value_text(226,part,sizeof part);
            ui_text(12,252,"Open 192.168.4.1",UI_COL_FG);
        }else field(196,"State",view->setup_state,sizeof view->setup_state);
        ui_text(12,282,"UP:BLE DOWN:Wi-Fi",UI_COL_MUTED);return;
    }
    ui_text(12, 6, "CampusPulse", UI_COL_TEAL);
    ui_fill(12, 31, UI_W - 24, 1, UI_COL_LINE);
    field(36, "Node", view->node_id, sizeof view->node_id);
    field(76, "Board", view->board, sizeof view->board);
    field(116, "Network", view->network, sizeof view->network);
    field(156, "Authentication", view->authentication, sizeof view->authentication);
    field(196, "Policy", view->policy, sizeof view->policy);
    field(236, "Collection", view->collection, sizeof view->collection);
    ui_fill(12, 284, UI_W - 24, 1, UI_COL_LINE);
    char battery[24];
    if (view->battery_percent >= 0 && view->battery_percent <= 100) {
        snprintf(battery, sizeof battery, "Battery: %d%%", view->battery_percent);
    } else {
        snprintf(battery, sizeof battery, "Battery: unavailable");
    }
    ui_text(12, 292, battery, UI_COL_MUTED);
}

void status_page_render(const cp_status_view_t *snapshot)
{
    if (!snapshot) return;
    ui_render((ui_rect_t){0, 0, UI_W, UI_H}, paint_status, (void *)snapshot);
}
