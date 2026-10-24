// main/dev_class.h —— 设备分类模块的聚合头（只做 include 转发）。
//
// 分类被拆成三个独立模块，各有各的头文件：
//   ad_parse.h   广播里写了什么（解析，唯一 AD 遍历入口）
//   dev_phone.h  像不像手机 / 是不是外设
//   veh_rules.h  电动车的证据位与硬条件
//
// 这个文件存在只是为了少改调用点。**新代码请直接 include 对应的模块头**，
// 不要从这里拿——那会把"我只用手机判定"写成"我要整个分类系统"，
// 依赖关系就又糊掉了。
#ifndef DEV_CLASS_H
#define DEV_CLASS_H

#include "ad_parse.h"
#include "dev_phone.h"
#include "veh_rules.h"

#endif  // DEV_CLASS_H
