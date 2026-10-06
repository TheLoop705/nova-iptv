# Performance review and repeatable checks

The checks distinguish total download time from responsiveness. A large provider can take seconds
to return a guide or catalog; remote navigation should continue throughout that work. Passing these
checks is a regression signal, not a guarantee for every provider, codec or device.

## Quick start on Windows 11

```powershell
npm ci
npx playwright install chromium
npm run typecheck
npm run test:performance
npm run test:updates
npm run build:perf:web
npm run test:e2e
```

The browser suite serves an exported production bundle, uses its real key router and screens, and
creates an isolated temporary SQLite database. It never opens your saved Nova database. The
1,000-channel fixture streams 144,000 programmes as gzip while movie/series catalogs contain
25,000/10,000 items. Web tests cover:

- D-pad navigation from Live TV to Settings while guide bytes are still arriving, including 4× CPU slowdown.
- One guide request across screen changes, successful completion, explicit retry after failure and no negative-fallback retry storm.
- Settings opening without downloading entire movie/series catalogs for counts.
- Explicit Count action stays navigable while a catalog body is delayed, shares duplicate requests and caches completed totals.
- Movie/series categories, virtualized poster lists, detail pages, canceling rapid searches and shared full-catalog downloads.
- Large-catalog counts after loading and navigation in a narrow phone browser layout.
- Twelve rounds / 72 warm screen changes: request counts stop growing and rendered DOM stays bounded.

Numerical release-bundle budgets: event-loop p95 below 100 ms, no individual one-second main-thread
freeze, key-to-next-frame p95 below 250 ms, screen navigation observed within two seconds, and fewer
than 6,000 DOM elements. These budgets are deliberately tolerant of CI scheduling; they do not
certify 60 fps or Fire TV hardware performance. Numeric reports are attached under
`output/playwright/`. CI runs the same deterministic suite on Windows and Linux.
When Chromium exposes precise heap figures, reports include initial/final byte snapshots. Those
snapshots are observations, not a heap-leak guarantee; garbage collection and media buffers vary.

The shared-service tests include 100,000 catalog records, 50,000 M3U channels, 100,000 search titles,
XMLTV boundary/large-guide cases, cancellation, body deadlines, coalescing, detail-cache bounds,
and malformed provider responses. Timers prove that heavy processing gives input a turn.

## Private provider credentials

Copy `.env.example` to `.env`, then set `NOVA_TEST_SERVER`, `NOVA_TEST_USERNAME` and
`NOVA_TEST_PASSWORD`. Use an optional `NOVA_TEST_EPG_URL` or `NOVA_TEST_USER_AGENT` when required.
The test scripts load this file in Node; credentials never use `EXPO_PUBLIC_*` or become build constants.
All `.env` files except the example are ignored by Git.

```powershell
npm run test:provider
# Opt-in real-browser checks after the deterministic suite passes:
$env:NOVA_TEST_PROVIDER='1'
npm run test:e2e -- --grep 'optional real provider'
Remove-Item Env:NOVA_TEST_PROVIDER
```

The provider command makes sequential, bounded login/category/catalog/guide requests and prints only
counts, bytes and durations, and checks XMLTV completion/programmes. It does not open video streams. The browser check uses the real app and
provider, keeps test settings in memory, disables previews, verifies guide data and navigation, and
checks that navigation does not restart the guide. It does not certify stream playback. Browser
network traces, screenshots and videos are disabled; failure output is sanitized and the provider
page closes before a DOM failure snapshot can be saved.

The guide transfer limit defaults to 128 MiB and each provider request to 120 seconds, adjustable in
the example. Do not paste provider URLs, raw browser traces, raw device UI dumps or full logs into
public issues: providers often embed passwords or tokens in those values.

## Fire TV and Android TV

The ADB runner discovers the Windows SDK under `%LOCALAPPDATA%\Android\Sdk` even when ADB is absent
from PATH. `NOVA_TEST_ADB`, `ANDROID_HOME` and `NOVA_TEST_ANDROID_SERIAL` override discovery.

```powershell
npm run test:android:doctor
# On a Fire TV, enable ADB debugging, then connect using its IP:
& "$env:LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe" connect 'FIRE-TV-IP:5555'
# Optional install/update; existing saved data is preserved:
$env:NOVA_TEST_APK='android/app/build/outputs/apk/release/app-release.apk'
npm run test:android:smoke
# Explicitly add a large local fixture playlist to the selected TV:
npm run test:android:smoke -- --mock
# Also verify local MP4 decoding, visible motion, pause/resume and seeking:
npm run test:android:smoke -- --mock --playback
```

`--mock` runs a local panel and uses ADB reverse so the device can reach it. It adds a
`Performance-test` playlist through the real editor using fixed demo credentials. `--playback`
serves the committed small MP4/HLS test clips and compares center video pixels in memory (no
screenshots are written), alongside playback progress and pause/resume/seek checks. Remove that
playlist in Settings after testing. Default smoke uses the device's configured playlist; it never
erases app data. `--demo` is available for an empty app's public demo playlist.

The runner launches Nova, visits all six main screens, exercises native D-pad capture and the menu
rail, checks for a crash/ANR, and prints frame, memory and sanitized JS timing summaries. The numeric
report is saved at `output/performance/android.json`; screen-observation durations include the
roughly two-second ADB UI-dump overhead. With `--mock`, it also checks guide completion, Settings
request counts and a late exact match in the large catalog. It never
saves raw UI dumps or logs. Enable `EXPO_PUBLIC_PERF_MONITOR=1` **at APK build time** to include numeric
JS budgets in native smoke checks; without it, the report explicitly has `monitor: null`.

Android TV emulation is available on this Windows machine through WHPX. The installed test AVD is
`Nova_TV_API36` (Android TV API 36, x86_64, 1080p). For a clean machine:

```powershell
$sdkPath="$env:LOCALAPPDATA/Android/Sdk"
& "$sdkPath/cmdline-tools/latest/bin/sdkmanager.bat" --install 'emulator' 'system-images;android-36;android-tv;x86_64'
'no' | & "$sdkPath/cmdline-tools/latest/bin/avdmanager.bat" create avd --name Nova_TV_API36 --package 'system-images;android-36;android-tv;x86_64' --device tv_1080p
Start-Process -FilePath "$sdkPath/emulator/emulator.exe" -ArgumentList @('-avd','Nova_TV_API36','-no-window','-no-audio','-no-snapshot','-gpu','software') -WindowStyle Hidden
```

An emulator APK must include `x86_64`; the downloadable Fire TV APK is `armeabi-v7a`.
Build through Expo/config plugins, not by editing generated native sources:

```powershell
$env:EXPO_PUBLIC_PERF_MONITOR='1'
npx expo prebuild --platform android
Push-Location android
./gradlew.bat :app:assembleRelease '-PreactNativeArchitectures=armeabi-v7a,x86_64'
Pop-Location
```

An Android TV emulator checks the Android TV code path and key capture. The physical Fire TV still
needs a run for its CPU, memory, codecs and Amazon behavior.

## Windows desktop

```powershell
npm ci --prefix desktop
$env:EXPO_PUBLIC_PERF_MONITOR='1'
npm --prefix desktop run prepare:app
npm run test:windows
npm run test:perf:windows
```

The existing desktop checks verify the Electron sandbox, proxy, codecs and persistence across
restart. The added performance runner drives the actual isolated Electron application with a large
mock library, checks guide/catalog request counts and UI responsiveness, and saves a numerical
report under `output/performance/windows.json`. Browser results alone do not replace this check.

## iOS and playback coverage

The connected `local-macmini` host has Xcode, iOS simulator runtimes and XcodeGen. Run
`npm run test:ios:smoke` in an isolated checkout on that Mac after Expo iOS prebuild and
`LANG=en_US.UTF-8 pod install`. The runner creates and later deletes its own simulator, builds
a Release app, seeds only local mock credentials, runs two XCTest UI cases (large library
navigation/search and MP4 progress/pause/resume/seek with changing decoded video pixels), and saves `output/performance/ios.json`
plus an `.xcresult` bundle. Existing simulators and the user's library stay untouched.

```powershell
ssh local-macmini 'export PATH=/opt/homebrew/bin:$PATH LANG=en_US.UTF-8; cd /path/to/isolated/nova; npm run test:ios:smoke'
```

`NOVA_TEST_IOS_APP` can point to an already-built Release simulator `.app`;
`NOVA_TEST_IOS_RUNTIME` and `NOVA_TEST_IOS_DEVICE_TYPE` select a different installed runtime/device.
The default build cache is ignored under `output/performance/ios-derived-data`. UI navigation
observations include XCTest's idle/snapshot overhead and fail after five seconds. The fixture
asserts Settings makes no full-catalog requests and the guide finishes exactly once.
This harness covers AVPlayer with the local fixture. A physical iPhone/iPad and the provider's actual
VLC formats, AirPlay and background playback still need separate checks.

For each physical target, test the provider's actual HLS/TS live playback, switching channels,
catch-up, seeking, subtitles/audio tracks, background resume and long sessions. The stress fixtures
disable external video playback so unreliable public streams do not mask a request-loop or
responsiveness regression. Separate local playback tests use a 40-second H.264/AAC MP4 and HLS clip
to check decoding, controls and retention of the single video surface.

## Manual larger/failure workloads

```powershell
npm run mock:stress
# Overrides for manual exploration:
$env:MOCK_CHANNELS='10000'
$env:MOCK_MOVIES='100000'
$env:MOCK_XMLTV_MODE='stall' # normal / empty / fail / stall
npm run mock:stress
```

The mock binds to loopback by default and logs no request URLs. `/__test/stats` reports endpoint
counts, guide completion/cancellation and generated byte totals. These endpoints exist only in the
development mock. Set `MOCK_HOST` explicitly if another device needs LAN access.
