# T-Energy raw-first development image

Development-only headless image for LILYGO T-Energy-S3 V1.0 / ESP32-S3-R8 (16 MB Flash, 8 MB octal PSRAM); see [manufacturer documentation](https://github.com/Xinyuan-LilyGO/T-Energy-S3). It observes SDK-delivered BLE reports, not all radio transmissions. No TF, display or physical power-button support is assumed.

The uploader and provisioning integration are not yet implemented. Buffered raw reports live only in PSRAM; no Flash persistence or cloud delivery is claimed. When the bounded buffer fills, new reports are lost and counted. Disconnects or loss of power can destroy all unconfirmed RAM reports; after power loss their exact count cannot be recovered. Counters are boot-local. USB console reports state without raw identifiers or payloads.

The partition table preserves the current `cpqueue` geometry, but this application does not use or erase that partition. This project is not authorized for deployment merely because it builds: first verify board revision, actual installed Flash layout and data at all write offsets; preserve existing contents and obtain explicit authorization for device operations. Physical scanning, sustained upload, coexistence, overload, brownout and long-run behavior remain unverified.

Activate ESP-IDF 5.5.3 and run `./build.sh` for a build in a temporary directory. No device is opened by the build script.
