> **赛前历史参考，迁入于 2026-10-23。** 下文的 current、implemented、测试通过与命令路径
> 全部属于旧原型，不描述新仓库现状。本轮未重跑测试、连接设备或重新核验外部规则来源。
> 原 Markdown：`research/vehicle-rules.md`；原文件 SHA-256：`469bd8cd76bde72beffb3dc47e31b6053b666615c968b5a7a4b4b0aa7501273d`。
> 原始代码和采集数据继续保留在本地，不随本文迁入。正文原样保留。
> 旧实现中的开发/运行命令只适用于旧原型目录。
> 新设计见[上传协议 v1 草案](../../specs/ingest-v1.md)；历史观察见[整理记录](observations.md)。

# BLE vehicle-related signal rules / 车辆相关广播候选规则

Status: current implementation; **not a validated vehicle counter**. Rule version:
`2026-10-14.1`. Source review: 2026-10-14. Hardware field validation: pending.

结果表示“车辆相关广播候选”，不表示现场车辆数。`e_bike_related` 包含电动车、
电动滑板车品牌名的弱提示，不能据此确认法律意义上的电动自行车类别，也不能
确认广播来自一辆真实车辆。`unknown` 表示本版本规则没有证据，不等于“不是车”。

## Implemented evidence and precedence

The same five rules are implemented in `firmware/main/cp_vehicle.c` and
`receiver/vehicle.go`. In a single well-formed report, the first matching rule
in this table wins. Confidence describes evidence specificity, not a calibrated
probability. No result has `high` or `confirmed` confidence.

| Priority | Rule ID | Exact trigger | Category / confidence | Evidence boundary |
|---|---|---|---|---|
| 1 | `tesla_vehicle_service` | Service UUID `00000211-b2d1-43f0-9b88-960cebf8b91e` | `car_related` / medium | Tesla publishes this as its vehicle connector service. Advertisement is unauthenticated; neither model, VIN nor physical vehicle is established. |
| 2 | `ccc_digital_key` | Service UUID `0xFFF5`, including its Bluetooth-base 32/128-bit forms | `vehicle_ecosystem` / medium | CCC service association; phone, key, vehicle and other participant roles remain unknown. |
| 3 | `tesla_company` | Manufacturer-specific AD starts with little-endian company ID `0x022B` | `vehicle_ecosystem` / low | Tesla-assigned company number alone does not identify the emitting product. |
| 4 | `tesla_name_pattern` | Complete local name is exactly `S` + 16 lowercase hexadecimal characters + `C` | `car_related` / low | Matches the format of Tesla's published vehicle local-name function; this scanner has no VIN to verify the value and no authentication. |
| 5 | `ebike_name_hint` | Case-insensitive local-name prefix from the list below, ending at the name or followed by space, `-`, `_` or `:` | `e_bike_related` / low | Project heuristic based on brand/product wording, not an official manufacturer advertising-format guarantee. |

The explicit name allowlist is `NIU`, `NINEBOT`, `SEGWAY`, `YADEA`,
`XIAOMI SCOOTER`, `XIAOMI ELECTRIC SCOOTER`, `MI ELECTRIC SCOOTER`.
It applies to complete and shortened local names. Names containing NUL,
control bytes or non-ASCII bytes do not match. Consequently this first version
can miss concatenated serial names, Chinese names and changed user names.
A phone renamed `NIU` can be a false candidate. A shortened `NIU` can conceal a
different full name. These are intentional, visible limitations of a low-level
name hint; they require field validation before any counting claim.

## Primary-source provenance

- [Tesla official vehicle-command BLE connector](https://github.com/teslamotors/vehicle-command/blob/058ee325e59d0290212f967f9ad94a4b61341fd5/pkg/connector/ble/ble.go):
  reviewed the version pinned to commit
  `058ee325e59d0290212f967f9ad94a4b61341fd5`, together with current `main`.
  `vehicleServiceUUID` supplies the service value; `VehicleLocalName` computes
  a name from the first eight bytes of SHA-1 of the VIN; `scanVehicleBeacon`
  compares local names. CampusPulse uses only the public name shape and service
  identifier. It does not recover, guess or verify a VIN, connect, unlock or send
  vehicle commands. A GATT service existing in code does not guarantee that every
  model advertises it in every vehicle state.
- [Bluetooth SIG Assigned Numbers, PDF](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Assigned_Numbers/out/en/Assigned_Numbers.pdf)
  reviewed the document dated **2026-10-08**, printed pages 115 and 234:
  `0xFFF5` is assigned to Car Connectivity Consortium, and company `0x022B`
  to Tesla. The [official index](https://www.bluetooth.com/specifications/assigned-numbers/)
  links the maintained PDF and YAML repository. These assignments establish
  ownership, not an advertising device's physical identity or a car count.
- [CCC Digital Key use cases](https://carconnectivity.org/digital-key-use-cases/):
  describes vehicles paired with mobile devices and multiple shared keys.
  This is why a digital-key ecosystem marker is not counted as a car.
- [NIU Smart App](https://global.niu.com/pt_pt/smartapp),
  [Segway scooter activation guide](https://motors.segway.com/pdf/SegwayAPPguide.pdf),
  [Yadea OMEE product page](https://yadea.com/electric-scooter/omee), and
  [Xiaomi scooter connection instructions](https://www.mi.com/global/support/article/KA-07367/)
  establish Bluetooth-enabled products associated with the allowlisted wording.
  They do **not** establish a universal BLE local-name prefix. The name rule is
  explicitly a CampusPulse heuristic, not a reverse-engineered vendor protocol.

## Exclusions and parsing contract

- Nordic UART service `6e400001-b5a3-f393-e0a9-e50e24dcca9e` is a general UART
  bridge, per [Nordic's service documentation](https://nrfconnectdocs.nordicsemi.com/ncs/latest/nrf/libraries/bluetooth/services/nus.html).
  It is not a vehicle fingerprint. Generic `FFE0`, battery services, Apple
  manufacturer data, `MI`, `M`, `M365`, substrings such as `CAR`, random MACs
  and RSSI do not independently trigger any rule. Tesla-assigned `FE96`/`FE97`
  are not enabled as a vehicle rule: assignment alone does not prove a service's
  function.
- Parse AD structures with bounded length checks. Match 16/32/128-bit service
  lists (`0x02`–`0x07`), corresponding service-data UUID prefixes (`0x16`, `0x20`,
  `0x21`), local names (`0x08`, `0x09`) and manufacturer IDs (`0xFF`). UUID bytes
  are little-endian. Service solicitation does not count as offering a service.
  Bytes inside unrelated data are never searched for embedded matching IDs.
- A zero AD length ends parsing. Truncated AD elements, incomplete service UUIDs
  and undersized service/manufacturer data produce `unknown` with
  `malformed_ad=true`, even if an earlier element matched. Unknown AD types are
  ignored by classification and retained by raw decoding.
- A classification uses one report only. ADV and SCAN_RSP are not combined;
  a later name does not retroactively alter an earlier anonymous advertisement.
  Address-window aggregation is a separate layer. It must preserve the
  strongest per-address candidate without turning address counts into vehicle
  counts, and must expose capacity saturation/loss.
- C returns four bytes (`kind`, `confidence`, `rule_id`, `malformed_ad`) and uses
  static strings, with no heap allocation or blocking calls. Go returns
  `category`, `confidence`, `rule_id`, `evidence`, `version`, `notice`, and
  `malformed_ad`. Go reads `payload_hex` and `payload_length`; presentation AD
  fields cannot fabricate evidence. Both leave the input record unchanged.

## What the receiver cannot observe or infer

The [ESP32-C3 datasheet](https://www.espressif.com/sites/default/files/documentation/esp32-c3_datasheet_en.pdf)
specifies Bluetooth LE. This scanner does not perform Bluetooth Classic
inquiry, so classic-only car audio is outside its observation surface. A parked
vehicle can be silent, connected, powered off, out of range or using a
vendor format not covered here. Nearby phones, keys, trackers and several radios
on one vehicle can generate unrelated or repeated observations.

[Bluetooth SIG's RPA explanation](https://www.bluetooth.com/blog/enhancing-device-privacy-and-energy-efficiency-with-bluetooth-randomized-rpa-updates/)
describes changing private addresses and resolution using a shared IRK.
CampusPulse does not resolve private addresses. One physical transmitter may
therefore appear under multiple observed addresses; one address is not proof
of one vehicle. None of packet rate, RSSI, local-name match or a passing build
establishes radio completeness, physical attribution, detection accuracy, or a
universal conversion from BLE observations to parked vehicles.

## Manual comparison with 20–30 actual e-bikes

1. Choose a clearly bounded parking area. Before collecting, manually record
   the actual count, start/end time, movement during the run, whether scooters
   are included, and enough brand/model and powered-state notes to describe the
   cohort. An estimate such as “20–30” should stay an interval until counted.
2. Record scanner node, boot ID, firmware/rule version, capture mode, location
   within the area and observation duration. Use an equivalent nearby background
   window to describe phones and other non-vehicle traffic.
3. Report raw reports, all unique observed addresses, `e_bike_related`
   candidate addresses, `car_related` candidate addresses,
   `vehicle_ecosystem` addresses, unknown addresses and malformed reports
   separately. Keep low-confidence name rules separate from medium-confidence
   service rules. A repeated packet is not another vehicle.
4. Alongside each window retain queue loss, storage exhaustion, sequence gaps,
   upload failures and unique-table saturation. Explain shorter/partial coverage;
   an empty result with missing records is not evidence of no vehicles.
5. Compare candidate-address counts with the manual count descriptively.
   Candidate addresses divided by actual vehicles is a **count ratio**, not
   recall, and can exceed 1. Precision/recall require independently matching
   individual observed signals to actual vehicles and checking misses/false
   matches. Do not tune a conversion factor on one 20–30-vehicle parking sample
   and present it as transferable to another site.

## Validation record

On 2026-10-14, host C tests passed with address and undefined-behavior sanitizers,
including every combination of 33 payload sizes, 256 initial AD lengths and 256
AD types (2,162,688 boundary cases), and positive/negative identifier fixtures.
Go classifier/codec tests passed in isolation; a 3-second fuzz run completed
259,927 executions without failure. Tests check unknown/malformed handling,
unchanged raw data, generic phones/UART exclusions, precedence, short/complete
names, every supported UUID width and no cross-report merging.

These are parser/classifier checks with synthetic inputs. Physical vehicles,
radio reception, model coverage and the manual 20–30-e-bike comparison have
**not** been validated by these checks. The whole receiver and firmware build
are verified separately by the integration workflow.

Reproduce from the repository root (host C compiler and Go required):

```sh
cc -std=c11 -O1 -g -Wall -Wextra -Werror -fsanitize=address,undefined \
  -Ifirmware/main tests/test_vehicle.c firmware/main/cp_vehicle.c \
  -o /tmp/campuspulse-test-vehicle
/tmp/campuspulse-test-vehicle
cd receiver
GOCACHE=/tmp/campuspulse-vehicle-go-cache go test codec.go vehicle.go vehicle_test.go
GOCACHE=/tmp/campuspulse-vehicle-go-cache go test -fuzz=FuzzVehicleADBounds \
  -fuzztime=3s -parallel=2 codec.go vehicle.go vehicle_test.go
```
