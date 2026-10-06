# Application performance review — 5 October 2026

The reported freezes had reproducible causes in shared code. This change fixes those causes and
adds regression checks against the exported production application, the Windows Electron app,
Android TV and a native iOS Release simulator build. The tests measure responsiveness while work is in progress, rather than only
checking that a download eventually finishes. Provider, codec and physical-device coverage remains
separate from these deterministic results.

## Findings and changes

| Area reviewed | Finding | Resulting behavior |
| --- | --- | --- |
| Live TV / XMLTV | Repeated searches through the remaining XML buffer made processing quadratic. Native global fetch could buffer the whole guide. Large decode, indexing and JSON cache operations occupied the JS thread. | Linear token scanning, native `expo/fetch` streaming, bounded decoding/decompression, cooperative indexing and small persisted cache pages. Input can run between batches. |
| Guide request lifecycle | Concurrent refreshes, valid empty guides and automatic error retries could cause repeated downloads. Missing short-guide entries were retried on revisits. | Requests share one active job. Empty results are cached, failures wait for an explicit retry, and missing per-channel fallback results are remembered until an explicit refresh. Active fallback requests still coalesce. |
| Guide rendering | Download progress subscribed the whole guide to frequent updates. | Progress has its own small subscriber. Existing virtualized guide rows and JS focus routing are retained. |
| Settings | Opening the screen fetched both entire VOD catalogs to display totals, then repeatedly scanned entries for counts. Settings was also inaccessible during initial library loading. | Opening Settings has no full-catalog request. Exact counts are stored when a full listing loads; an explicit Count action loads in the background. Settings remains accessible while the library loads. |
| Movies / series | Large whole-body JSON parsing and eager row slicing increased blocking and memory work. Category and complete-list requests could duplicate work or overwrite one another. | Record-by-record catalog parsing, cooperative grouping, virtualized poster rows/categories/seasons, shared requests and authoritative complete listings. Failed kinds can retry independently. |
| Search | Full-library matching ran inside a render, including unrelated guide updates. Rapid query changes repeated this work. | Debounced loading, cancellable cooperative matching, cached normalized titles and bounded result sets. Late exact matches remain discoverable. |
| Home / details | Metadata caches were unbounded, repeated requests duplicated work, and series history or late resume responses could start the previous provider's stream. | A bounded metadata cache shares pending requests, invalidates on playlist changes and guards late playback actions. Episode resume resolves current metadata instead of replaying a saved credential-bearing URL. Recently watched already has a bounded list. |
| Playlist editing | Changing credentials under the same ID could reuse old derived data. Cache clearing also removed imported M3U source files. | Source changes cancel the old generation and reload once. Display-name changes stay quiet. Imported sources survive ordinary cache clearing and are removed only by playlist deletion. |
| Network / cancellation | Some deadlines covered only headers; a stalled body could remain pending. Work completed after switching providers could publish stale data. | Full-body deadlines and cancellation, generation checks for guide/catalog/metadata work, cancellation of the Windows bridge's upstream request, and cancellation listeners released after every read. |
| Web playback | Old error/metadata callbacks and recovery attempts could affect a later source. HLS media recovery could repeat without a bound. | Per-attempt cleanup, current-player guards and one media recovery before trying the next supported engine. |
| Native playback | iOS used synchronous asset replacement, which can block the main thread. Old reconnect timers and asynchronous completions could affect later streams. | Asynchronous replacement with latest-request completion guards; reconnect timers cancel on source changes and recovery. |
| Settings synchronization | Comparing a large progress document serialized the whole document synchronously; asynchronous diffs introduced opportunities for stale edits. | Cooperative field comparison, local-intent tracking and guarded merges. Applying many remote edits reuses cloned containers. Device-only active-playlist changes avoid an unnecessary shared save. |
| Input / diagnostics | No repeatable numerical guard against a responsive-looking screen silently blocking input. | Optional bounded numeric samples for JS event-loop lag, key routing and key-to-next-frame time. Production builds pay no sampling cost unless enabled. Background time is excluded. |
| Startup / updates / desktop | Startup, persistence and updates need coverage when modifying shared storage and HTTP code. | Existing update and desktop restart/proxy/sandbox/codec checks retained; source regressions added to the Android release gate and browser performance checks run in separate Windows/Linux CI jobs. |

Native legacy playlist/guide cache files are deliberately refreshed once instead of parsing a large
old JSON blob during the first launch after upgrading. This changes derived caches; saved provider
settings and imported playlist sources are retained.

Expo's installed video API explicitly warns that synchronous replacement loads iOS asset data on
the UI thread. The asynchronous API is also described in the [Expo video documentation](https://docs.expo.dev/versions/v55.0.0/sdk/video/).

## Measurements

Parser, web, Windows and Android TV emulator observations are from this Windows 11 computer.
The native iOS Release simulator runs on the connected Mac. These are not physical-device benchmarks.

| Workload | Previous behavior | Changed behavior / observation |
| --- | --- | --- |
| 40,000 XMLTV programmes, approximately 4.1 MB | Approximately 29.2 seconds in the original parser, with superlinear growth. | Approximately 0.07–0.10 seconds in isolated parser runs. The actual download/decode/cache path additionally yields between bounded chunks. This is parser CPU time, not the complete network transfer. |
| 100,000 catalog records, approximately 9.1 MB | Whole-body parsing/counting occupied one task for approximately 73–103 ms on this PC. | Approximately 0.46–0.84 seconds total, with 29–54 input timer opportunities. The deliberate tradeoff is continuous responsiveness rather than the shortest single-task completion time. |
| 100,000 search titles | Matching could occupy a render for approximately 66 ms and run again on unrelated updates. | Isolated search completed in approximately 331 ms with 29 input turns and a maximum heartbeat gap of approximately 16 ms. Queries are cancellable and results bounded. |
| Exported web guide/navigation, 4× CPU slowdown | No automated input responsiveness check. | Final run: event-loop lag p95 18.4 ms; key-to-next-frame p95 95.9 ms while guide bytes arrived. |
| Actual Windows Electron large-library navigation | No application-level performance test. | Final run: event-loop lag p95 12.8 ms and key-to-next-frame p95 17.9 ms; one guide request, no automatic full-catalog download from Settings. |
| Android TV API 36 Release emulator, 1080p | No repeatable native remote/input or decoding regression check. | Final run: event-loop lag p95 30.7 ms, key-to-next-frame p95 32.5 ms, one completed guide. MP4 motion changed 192,112 center pixels; pause, seek and resume passed. |
| iOS 26.4 Release simulator, iPhone 17 Pro | No native UI/decoding regression runner. | Two XCTest cases passed, with 21 screen observations at 1.34–1.52 seconds including XCTest idle overhead. MP4 changed 122,103 center pixels; pause, seek and post-seek resume passed. |

The assertion budgets tolerate CI scheduling: web event-loop p95 <100 ms, individual lag <1 second,
key-to-next-frame p95 <250 ms, navigation observed within two seconds, and <6,000 DOM elements.
Windows uses the same one-second and 250 ms limits, with a 150 ms event-loop p95 allowance.
These are regression thresholds, not a claim of consistent 60 fps. A visible, inactive Electron
fixture window is used because Windows suppresses animation frames for hidden windows.
Android reported 227,995 KiB total PSS and 16.64% janky rendered frames on the software-rendered
emulator. Passing input budgets does not imply smooth rendering on every frame; physical-device
profiling must distinguish app rendering costs from emulator scheduling and graphics overhead.
Android screen observations also include roughly two seconds of accessibility dump overhead.

## Repeatable validation

- Source tests exercise actual application code with explicit platform-boundary mocks: large XMLTV,
  M3U, JSON catalogs and search; chunk boundaries; gzip failures; deadlines; cancellation; retries;
  cache invalidation and metadata bounds; source transitions; settings synchronization; stale player
  completion; diagnostic sample bounds.
- Browser tests use a production export, isolated SQLite storage, real app screens and capture-phase
  remote input. Fixtures include 1,000 channels, 144,000 programmes, 25,000 movies and 10,000 series.
  Empty/failing guides and a compact phone layout have separate checks. Repeated navigation checks
  ensure cached requests stop growing and rendered content stays bounded.
- Generated local H.264/AAC MP4 and HLS fixtures provide playback coverage without external test
  streams. They do not represent every provider codec or DRM configuration.
- Windows checks run the real Electron shell in an isolated temporary data directory and validate
  restart persistence, the local proxy, codec support and large-library navigation.
- Android checks drive the APK through ADB on Android TV, exercise the native key-capture path,
  visit every main screen, search a late exact result and inspect crash/ANR, frame, memory and optional
  numeric JS summaries. MP4 checks compare actual video pixels and exercise pause/seek/resume.
- iOS checks build a Release app and run XCTest in a newly created simulator: large-library
  navigation/search, repeated screen changes and decoded MP4 motion with pause/seek/resume. The
  runner removes its own simulator afterward. iOS Release console sampling was unavailable, so
  its report explicitly has `monitor: null` and makes no JS p95 claim.
- Provider tests load credentials from ignored `.env` files in Node. Sequential requests have
  deadlines and a guide transfer cap. Reports contain counts/timings, with raw provider network
  traces, screenshots and videos disabled.

The final shared-code run passed all **80 performance tests**, the typecheck and all five existing
update tests. The final browser run passed **eight cases**, with the private-provider case explicitly
skipped because credentials are absent. Playback also passed three consecutive repetitions. Windows
startup/restart checks and its large-library and actual MP4/HLS playback test passed.
The final Android Release APK built for `armeabi-v7a` and `x86_64`; the Android TV smoke passed
all six main screens, exact guide completion, large-catalog search, native D-pad routing and MP4
motion/controls. The final iOS Release build and both XCTest UI cases passed on the connected Mac.

See [the testing guide](performance-testing.md) for commands, credentials and device setup. Generated
reports live under `output/performance/`, `output/playwright/` and `output/playwright-playback/`;
those directories are ignored.

## Coverage limits and follow-up checks

The user's actual provider has not been exercised because credentials have not been supplied.
Deterministic tests can establish that the known loops and processing freezes are fixed; they
cannot guarantee every provider response, authentication scheme, playlist size or stream format.

Physical Fire TV still needs its ADB run. Android TV emulation validates Android code and key
capture, but does not model a Fire Stick's CPU/memory limits, hardware decoder or Amazon keyboard.
Native iOS simulator checks cover AVPlayer with the local MP4 fixture. MobileVLCKit, AirPlay,
physical iPhone/iPad decoders and background playback need representative-device validation.

Before a release intended for all devices, use the same representative provider on physical Fire
TV and iPhone/iPad: live playback, channel changes, catch-up, seek/resume, next episode, audio and
subtitle selection, background/foreground, guide refresh during playback, offline/recovery, and a
long viewing session. Investigate samples above the budgets rather than raising thresholds to
make a failing device pass. Native settings still serialize and write the complete saved settings
document synchronously; guide and channel caches are now paged. Extremely large watch-progress
stores therefore need measurement on physical hardware before claiming that path is fully bounded.
Provider-specific images, codecs and long-session memory behavior also remain follow-up workloads.
