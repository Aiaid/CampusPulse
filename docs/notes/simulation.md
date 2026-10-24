# Frontend simulation scenarios

Status: implemented and locally verified on 2026-10-24. These are authored
illustrations; they are not sensor records, weather forecasts or campus schedules.

In **模拟演示**, use **模拟场景** above the map to choose:

| Scenario | Illustrated behavior |
| --- | --- |
| 常规教学日 | Class-break flow near teaching buildings, lunch/dinner at Boya, evening library and gym activity |
| 周末休闲 | Less teaching activity, more daytime reading, plaza and sports activity |
| 雨天出行 | Lower cycling and outdoor activity, increased illustrative elevator waits |

All eight places have independent 07:00–22:00 profiles, interpolated between
hourly samples. Nine representative history rows and four time shortcuts select
the same clock as the overview and detail map. Changing scenarios preserves the
selected place/time and pauses time replay. Movement is still controlled
separately in scene settings.

Pedestrian/cycling activity and parking are independent relative indices from
0–100, shown as qualitative bands. Parking is a synthetic dwell/occupancy index,
not an actual lot capacity or count. It drives occupancy of the existing fixed
illustrative parking slots; it does not create new parking facilities. Waits
remain absent at places without an existing synthetic wait profile, and are not
evidence that a building has an elevator. Trends compare the same scenario with
15 minutes earlier. Invalid place IDs return unknown metrics, never another
place's values. Nonfinite times and unknown scenario IDs use deterministic
defaults.

`src/campus/scene-data.js` contains the newly authored profiles. The retained
`sceneAttribution.scenarios` path identifies the historical prototype reference,
not the source of these new curves. Existing official/manual geometry, route
anchors, sprite artwork and lighting are retained with their existing provenance.
No new assets or third-party implementation code were imported for this change.

Switching to **现场观察** removes the selector, synthetic metrics/parking,
actors and waits, disables replay, and stops time playback. Returning to
simulation restores the locally selected profile and time. Site settings still
choose the initial mode; failed settings reads retain the existing field-mode
fallback. Simulation never seeds or writes D1, R2, device data or public API
observations.

Local verification:

```sh
npx vitest run tests/frontend
npm run build
# With a separate loopback Vite preview on port 5186:
node scripts/simulation-browser-smoke.mjs
```

The frontend suite passed 198 tests in 22 files, including eight simulation
tests covering every minute of all place/scenario combinations. Build passed.
Real Chromium passed scenario/metric/map synchronization, nine-row history,
playback/field isolation and 390px selector checks with zero API writes or page
errors. Browser acceptance stubs only the settings response on loopback; it does
not validate live backend settings, production deployment, GIS availability,
weather, radio collection or hardware.
