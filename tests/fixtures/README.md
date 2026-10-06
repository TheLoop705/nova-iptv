# Local playback fixture

These files are generated test media: a moving colour pattern and a 440 Hz tone.
They contain no provider content and require no external streaming service.
The 40-second, 160×90 H.264 baseline/AAC movie and HLS segments together are under 1 MiB.
The mock panel serves them for live TV, movies and episodes, including byte ranges.

Regenerate with an existing FFmpeg installation:

```powershell
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=160x90:rate=10 -f lavfi -i sine=frequency=440:sample_rate=44100 -t 40 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -preset veryslow -crf 30 -g 40 -keyint_min 40 -sc_threshold 0 -c:a aac -b:a 32k -ac 1 -movflags +faststart -fflags +bitexact -flags:v +bitexact -flags:a +bitexact -y tests/fixtures/playback.mp4
ffmpeg -hide_banner -loglevel error -i tests/fixtures/playback.mp4 -c copy -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_filename tests/fixtures/playback-%03d.mpegts -y tests/fixtures/playback.m3u8
```

The `.mpegts` suffix keeps TypeScript from treating transport-stream binaries as source files.
Run `npx playwright test tests/e2e/playback.spec.mjs` after building the performance web app.
