// main/scan_stats.c —— 每台设备的累计表（离线标定用）。
//
// 设计取舍（都在这里说清楚，避免以后看代码时猜）：
//
// 1) 按 MAC 聚合，不按名字。名字是"可能收不到"的属性（车棚实测 93% 的包没有名字），
//    拿它当主键会让大量设备被合并成一个桶——v1 就是这么失败的：台铃那个 BandSpeed
//    模组（manu=0x0020）无名 350 包、有名只有 36 包，10 台车被并成 1 行。
//
// 2) 名字取"见过的第一个非空值"，不覆盖。车厂的名字是固定的（车架号/编号），
//    第一次抓到就够了；反复覆盖只会让统计在两种名字之间跳。
//
// 3) 表满之后丢弃新设备并计数，不淘汰旧的。理由：这张表的意义是
//    "这一趟走过的地方都出现了什么"，先来的（也就是离你最近的）更有价值。
//
// 4) 导出时才按前缀聚合。**聚合是展示层的事**，采样层只负责忠实记录每台设备。
#include "scan_stats.h"

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"
#include <stdio.h>
#include <string.h>

static const char *TAG = "scan_stats";

#define STATS_NVS_NS      "scanstats"
#define STATS_NVS_KEY     "devs"

// v1 存的是"按名字前缀聚合"的结构，v2 改成"按 MAC"。布局完全不同，
// 读旧 blob 会得到垃圾数据而且不报错，所以必须校验版本。
#define STATS_MAGIC       0x53544234u   // 'STB4'
#define STATS_VERSION     4u

typedef struct {
    uint32_t magic;
    uint32_t version;
    uint32_t count;
    scan_dev_t devs[SCAN_STATS_DEVS];
} stats_blob_t;

static scan_dev_t s_devs[SCAN_STATS_DEVS];
static int s_count;
static uint32_t s_dropped;   // 表满被丢弃的包
static uint32_t s_total;     // 累计包数

// 约 9KB，不能放栈上。
static stats_blob_t s_blob;

void scan_stats_reset(void)
{
    memset(s_devs, 0, sizeof(s_devs));
    s_count = 0;
    s_dropped = 0;
    s_total = 0;
}

int scan_stats_count(void)
{
    return s_count;
}

static scan_dev_t *find_or_add(const uint8_t mac[6])
{
    for (int i = 0; i < s_count; i++) {
        if (memcmp(s_devs[i].mac, mac, 6) == 0) return &s_devs[i];
    }
    if (s_count >= SCAN_STATS_DEVS) return NULL;
    scan_dev_t *d = &s_devs[s_count++];
    memset(d, 0, sizeof(*d));
    memcpy(d->mac, mac, 6);
    d->used = true;
    d->rssi_best = -127;   // 保证第一包一定覆盖
    d->mlen_min = 255;     // 255 = 还没见过带厂商数据的包
    return d;
}

void scan_stats_note(const uint8_t mac[6], bool has_manu, uint16_t manu_id,
                     const char *name, uint8_t name_len,
                     int8_t rssi, uint8_t event_type,
                     uint8_t manu_len, bool has_uuid128,
                     uint8_t evidence, bool is_phone,
                     uint32_t ad_mask, uint16_t svc16)
{
    scan_dev_t *d = find_or_add(mac);
    if (!d) {           // 表满
        s_dropped++;
        return;
    }

    s_total++;
    if (d->packets < 0xFFFF) d->packets++;

    if (has_manu && !d->has_manu) {
        d->has_manu = true;
        d->manu[0] = (uint8_t)(manu_id & 0xFF);
        d->manu[1] = (uint8_t)(manu_id >> 8);
    }

    // 名字只记第一次拿到的非空值，见文件头第 2 条。
    if (name && name_len && d->name_len == 0) {
        uint8_t n = name_len;
        if (n > SCAN_STATS_NAME_MAX) n = SCAN_STATS_NAME_MAX;
        memcpy(d->name, name, n);
        d->name_len = n;
    }

    if (rssi > d->rssi_best) d->rssi_best = rssi;

    if (event_type == 0x00)      d->type_mask |= 0x01;   // 可连接
    else if (event_type == 0x03) d->type_mask |= 0x02;   // 不可连接
    else                         d->type_mask |= 0x04;

    if (has_manu) {
        if (manu_len > d->mlen_max) d->mlen_max = manu_len;
        if (manu_len < d->mlen_min) d->mlen_min = manu_len;
    }
    if (has_uuid128) d->has_uuid128 = true;
    d->evidence |= evidence;
    if (is_phone) d->phone = true;

    // AD 结构画像：按位或累积，第一次见到的 0x16 UUID 记住。
    d->ad_mask |= ad_mask;
    if (d->svc16 == 0 && svc16 != 0) d->svc16 = svc16;
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

// 把一个设备名归一成"同一款车的共同前缀"。
//
// 车棚实测的命名格式有三类：
//   "bdb-PKE-7BCA"  -> "bdb-PKE-"（尾部是大写字母+数字混排，按分隔符截）
//   "TL_BEUOZB_7D"  -> "TL_BEUOZB_"（同上）
//   "LuYuan-Smart"  -> "LuYuan-Smart"（没有编号，保留全名）
//   "GANA23268LHA"  -> "GANA"（纯编号，去掉尾部字母数字）
//
// 规则：从末尾开始去掉连续的 [0-9A-F] 和分隔符，剩下的就是前缀。
// 只去十六进制字符是刻意的——品牌名里常有 G、L 这种字母，
// 如果连所有字母都去，会把 "LuYuan" 削成一个 "L"。
static void name_prefix(const char *name, uint8_t len, char *out, uint8_t *out_len)
{
    uint8_t n = len;
    if (n > SCAN_STATS_NAME_MAX) n = SCAN_STATS_NAME_MAX;

    // 规则 1：有分隔符、且分隔符后面那段含数字 -> 截到分隔符（含）。
    //   这覆盖了车厂最常见的一类命名，也是上一版削坏的地方：
    //   bdb-PKE-7BCA -> bdb-PKE-    （上一版会继续把 E 当十六进制削掉，变成 bdb-PK）
    //   TL_BEUOZB_D927 -> TL_BEUOZB_
    //   AIMA-B52F1F -> AIMA-
    //   LuYuan-Smart -> LuYuan-Smart（后面 "Smart" 不含数字，不动）
    int last_sep = -1;
    for (int i = (int)n - 1; i >= 0; i--) {
        const char c = name[i];
        if (c == '-' || c == '_' || c == ' ') { last_sep = i; break; }
    }
    if (last_sep > 0) {
        bool digit_after = false;
        for (int i = last_sep + 1; i < (int)n; i++) {
            if (name[i] >= '0' && name[i] <= '9') { digit_after = true; break; }
        }
        if (digit_after) {
            *out_len = (uint8_t)(last_sep + 1);
            memcpy(out, name, *out_len);
            return;
        }
    }

    // 规则 2：没有分隔符 -> 截到第一个数字。
    //   YD5729E0D2 -> YD       （雅迪，换成"只去尾部数字"会剩 YD5729E0D）
    //   GANA23268LHABHY6 -> GANA
    //   HE3490081138 -> HE
    //   车架号/编号都在数字段，截在这里最稳。
    uint8_t cut = n;
    for (uint8_t i = 0; i < n; i++) {
        if (name[i] >= '0' && name[i] <= '9') { cut = i; break; }
    }
    // 整个名字以数字开头（28DBD2527J）：没有可用的前缀，取前 4 个字符当标识
    if (cut < 2) cut = (n >= 4) ? 4 : n;

    memcpy(out, name, cut);
    *out_len = cut;
}

#define AGG_MAX 64

typedef struct {
    char prefix[SCAN_STATS_NAME_MAX];
    uint8_t prefix_len;
    uint16_t count;        // 台数
    uint32_t packets;
    int8_t rssi_best;
    uint8_t type_mask;
    uint8_t mlen_max;
    uint8_t mlen_min;
    uint8_t phone_cnt;
    char sample[SCAN_STATS_NAME_MAX + 1];  // 一台样例设备名，人工核对用
    uint32_t ad_mask;      // 这组见过的 AD Type 并集
    uint16_t svc16;        // 这组见过的第一个 0x16 service UUID
} agg_t;

static agg_t s_agg[AGG_MAX];
static int s_agg_n;

static void agg_add(const char *pre, uint8_t pre_len, const scan_dev_t *d)
{
    for (int i = 0; i < s_agg_n; i++) {
        agg_t *a = &s_agg[i];
        if (a->prefix_len == pre_len && memcmp(a->prefix, pre, pre_len) == 0) {
            a->count++;
            a->packets += d->packets;
            if (d->rssi_best > a->rssi_best) a->rssi_best = d->rssi_best;
            a->type_mask |= d->type_mask;
            if (d->mlen_max > a->mlen_max) a->mlen_max = d->mlen_max;
            if (d->mlen_min < a->mlen_min) a->mlen_min = d->mlen_min;
            if (d->phone) a->phone_cnt++;
            a->ad_mask |= d->ad_mask;
            if (a->svc16 == 0) a->svc16 = d->svc16;
            return;
        }
    }
    if (s_agg_n >= AGG_MAX) return;
    agg_t *a = &s_agg[s_agg_n++];
    memset(a, 0, sizeof(*a));
    memcpy(a->prefix, pre, pre_len);
    a->prefix_len = pre_len;
    a->count = 1;
    a->packets = d->packets;
    a->rssi_best = d->rssi_best;
    a->type_mask = d->type_mask;
    a->mlen_max = d->mlen_max;
    a->mlen_min = d->mlen_min;
    if (d->phone) a->phone_cnt = 1;
    a->ad_mask = d->ad_mask;
    a->svc16 = d->svc16;
    if (d->name_len) {
        memcpy(a->sample, d->name, d->name_len);
        a->sample[d->name_len] = '\0';
    }
}

int scan_stats_dump(void)
{
    if (s_count == 0) {
        ESP_LOGI(TAG, "[STAT] 本轮没有累计到任何设备");
        return 0;
    }

    s_agg_n = 0;
    int named = 0;
    for (int i = 0; i < s_count; i++) {
        scan_dev_t *d = &s_devs[i];
        if (d->name_len) {
            named++;
            char pre[SCAN_STATS_NAME_MAX];
            uint8_t plen = 0;
            name_prefix(d->name, d->name_len, pre, &plen);
            agg_add(pre, plen, d);
        } else {
            // 无名设备**不能只塞进一个桶**。
            //
            // 车棚实测：横排往返一圈，199 台里有 183 台没名字。如果全合并成
            // `(无名) 183 台`，就看不出里面到底有多少台像车——而那正是这次要回答的问题。
            //
            // 所以按"能不能是车"的已知特征分档：
            //   有可连接广播 + 厂商数据长度 0   -> 最像车（车棚实测：7 台车 4 台 mlen=0）
            //   有可连接广播 + 厂商数据 1~7     -> 也像车（台铃是 6）
            //   有可连接广播 + 厂商数据 >=8     -> 更像手机（苹果/微软都是 20+）
            //   只有不可连接广播                -> 手机、信标，PEPS 车不可能
            const char *tag = "(无名 其他)";
            if (d->type_mask & 0x01) {
                if (d->mlen_max == 0)       tag = "(无名 C m0)";
                else if (d->mlen_max < 8)   tag = "(无名 C m1-7)";
                else                        tag = "(无名 C m8+)";
            } else if (d->type_mask & 0x02) tag = "(无名 N)";
            // 长度用 strlen 现场算：这些标签是 UTF-8 中文（3 字节/字），
            // 手写字节数极容易错（我第一次就按字符数写了 13，实际是 15，
            // 会导致标签被截掉半个汉字）。
            agg_add(tag, (uint8_t)strlen(tag), d);
        }
    }

    ESP_LOGI(TAG, "==== 累计 %d 台设备（有名 %d / 无名 %d），共 %lu 包（丢弃 %lu）====",
             s_count, named, s_count - named, (unsigned long)s_total,
             (unsigned long)s_dropped);
    ESP_LOGI(TAG, "前缀             台数   包数  最强RSSI 类型 mlen  手机 AD类型            样例名");

    // 按台数降序，台数相同按包数降序 —— 成排的车会排在最前面
    for (int i = 0; i < s_agg_n; i++) {
        int best = i;
        for (int j = i + 1; j < s_agg_n; j++) {
            if (s_agg[j].count > s_agg[best].count ||
                (s_agg[j].count == s_agg[best].count &&
                 s_agg[j].packets > s_agg[best].packets)) {
                best = j;
            }
        }
        if (best != i) {
            agg_t t = s_agg[i];
            s_agg[i] = s_agg[best];
            s_agg[best] = t;
        }
    }

    for (int i = 0; i < s_agg_n; i++) {
        agg_t *a = &s_agg[i];
        char pbuf[SCAN_STATS_NAME_MAX + 1];
        memcpy(pbuf, a->prefix, a->prefix_len);
        pbuf[a->prefix_len] = '\0';

        char types[8];
        int k = 0;
        if (a->type_mask & 0x01) types[k++] = 'C';
        if (a->type_mask & 0x02) types[k++] = 'N';
        if (a->type_mask & 0x04) types[k++] = 'O';
        if (k == 0) types[k++] = '-';
        types[k] = '\0';

        // AD 类型列表：把位图摊成 "01,09,FF" 这样的串。
        // 这一列是判断"是不是车"的最后一条线索——真车的 AD 结构我们还没见过，
        // 但只要车棚日志里出现稳定的一两种结构，就能和打印机的（01,09 / 01,16）
        // 直接区分开。
        char ads[40];
        int ap = 0;
        ads[0] = '\0';
        for (int bit = 1; bit < 32; bit++) {
            if ((a->ad_mask & (1UL << bit)) == 0) continue;
            if (ap < (int)sizeof(ads) - 4) {
                ap += snprintf(ads + ap, sizeof(ads) - (size_t)ap,
                               ap ? ",%02X" : "%02X", bit);
            }
        }
        if (a->svc16) {
            snprintf(ads + ap, sizeof(ads) - (size_t)ap, "/%04X", a->svc16);
        }
        if (ads[0] == '\0') snprintf(ads, sizeof(ads), "-");

        // mlen 列写成 "min-max"：`0-0` 是一直没有厂商数据，`4-27` 是长短包混发。
        char ml[12];
        if (a->mlen_min == 255) {
            snprintf(ml, sizeof(ml), "  -  ");
        } else {
            snprintf(ml, sizeof(ml), "%u-%u", (unsigned)a->mlen_min,
                     (unsigned)a->mlen_max);
        }

        ESP_LOGI(TAG, "[STAT] %-16s %4u %6lu %6d   %-3s %-5s %4u %-18s %s",
                 pbuf, (unsigned)a->count, (unsigned long)a->packets,
                 (int)a->rssi_best, types, ml,
                 (unsigned)a->phone_cnt, ads, a->sample);
    }
    ESP_LOGI(TAG, "==== 结束 ====");
    return s_count;
}

// ---------------------------------------------------------------------------
// NVS 持久化
// ---------------------------------------------------------------------------

esp_err_t scan_stats_save(void)
{
    if (s_count == 0) return ESP_OK;   // 不拿空表覆盖上一趟

    esp_err_t err = nvs_flash_init();
    if (err != ESP_OK && err != ESP_ERR_NVS_NO_FREE_PAGES &&
        err != ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS 初始化失败: %s", esp_err_to_name(err));
        return err;
    }

    nvs_handle_t h;
    err = nvs_open(STATS_NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "NVS 打开失败: %s", esp_err_to_name(err));
        return err;
    }

    s_blob.magic = STATS_MAGIC;
    s_blob.version = STATS_VERSION;
    s_blob.count = (uint32_t)s_count;
    memcpy(s_blob.devs, s_devs, sizeof(s_devs));

    // 【先擦后写】否则 11KB 的 blob 在 24KB 的 NVS 分区里写不进去。
    //
    // 实测报错：`累计表落盘失败: ESP_ERR_NVS_NOT_ENOUGH_SPACE`。
    // 原因：NVS 一个数据页放 4000 字节，11KB 的 blob 要占 3 页；而 nvs_set_blob
    // 是"写新的、成功后才释放旧的"，峰值要 6 页 —— 整个分区只有 6 页
    // （0x6000 / 4096），还要和 WiFi 凭据、套件设置共用，必然失败。
    //
    // 先 erase 把旧 blob 的页标成已擦除，GC 就能复用；峰值降到 3 页。
    // 代价：这两步之间掉电会丢掉持久化的累计表（RAM 里那份还在，
    // 下一次 30 秒定时保存会重写）。相比"永远写不进去"，这个代价可以接受。
    err = nvs_erase_key(h, STATS_NVS_KEY);
    if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;   // 第一次存，没有旧值
    if (err == ESP_OK) err = nvs_commit(h);
    if (err == ESP_OK) err = nvs_set_blob(h, STATS_NVS_KEY, &s_blob, sizeof(s_blob));
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);

    if (err == ESP_OK) {
        ESP_LOGI(TAG, "累计表已落盘: %d 台 / %lu 包", s_count, (unsigned long)s_total);
    } else {
        ESP_LOGW(TAG, "累计表落盘失败: %s", esp_err_to_name(err));
    }
    return err;
}

esp_err_t scan_stats_load(bool clear_after)
{
    esp_err_t err = nvs_flash_init();
    if (err != ESP_OK && err != ESP_ERR_NVS_NO_FREE_PAGES &&
        err != ESP_ERR_NVS_NEW_VERSION_FOUND) {
        return err;
    }

    nvs_handle_t h;
    err = nvs_open(STATS_NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;

    size_t len = sizeof(s_blob);
    err = nvs_get_blob(h, STATS_NVS_KEY, &s_blob, &len);
    if (err != ESP_OK) {           // 没存过
        nvs_close(h);
        return err;
    }

    if (len != sizeof(s_blob) || s_blob.magic != STATS_MAGIC ||
        s_blob.version != STATS_VERSION ||
        s_blob.count > SCAN_STATS_DEVS) {
        ESP_LOGW(TAG, "NVS 里的累计表格式不符（len=%u ver=%lu），忽略",
                 (unsigned)len, (unsigned long)s_blob.version);
        if (clear_after) {
            (void)nvs_erase_key(h, STATS_NVS_KEY);
            (void)nvs_commit(h);
        }
        nvs_close(h);
        return ESP_ERR_INVALID_VERSION;
    }

    memcpy(s_devs, s_blob.devs, sizeof(s_devs));
    s_count = (int)s_blob.count;
    s_total = 0;
    s_dropped = 0;
    for (int i = 0; i < s_count; i++) s_total += s_devs[i].packets;

    if (clear_after) {
        (void)nvs_erase_key(h, STATS_NVS_KEY);
        (void)nvs_commit(h);
    }
    nvs_close(h);
    ESP_LOGI(TAG, "从 NVS 恢复累计表: %d 台 / %lu 包", s_count, (unsigned long)s_total);
    return ESP_OK;
}

esp_err_t scan_stats_clear_nvs(void)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(STATS_NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_erase_key(h, STATS_NVS_KEY);
    if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    if (err == ESP_OK) (void)nvs_commit(h);
    nvs_close(h);
    ESP_LOGI(TAG, "NVS 里的累计表已清除");
    return err;
}
