import React, { useEffect, useRef } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import type { Source } from '../store/player';
import { useSettings } from '../store/settings';
import { proxify } from '../services/http';
import { BUFFER_PROFILES, guessContentType, refillAfterStall, usePlayback, type BufferProfile } from './playback';

interface Props {
  source: Source | null;
  nonce: number;
  resumeAt?: number;
  style?: StyleProp<ViewStyle>;
}

type Engine = 'hls' | 'mpegts' | 'native';

function enginesFor(uri: string, video: HTMLVideoElement): Engine[] {
  const type = guessContentType(uri);
  const nativeHls = !!video.canPlayType('application/vnd.apple.mpegurl');
  const hls: Engine[] = Hls.isSupported() ? ['hls'] : nativeHls ? ['native'] : [];
  const ts: Engine[] = mpegts.isSupported() ? ['mpegts'] : [];
  const path = uri.toLowerCase().split('?')[0];
  if (type === 'hls') return [...hls, 'native'];
  if (path.endsWith('.ts')) return [...ts, ...hls, 'native'];
  if (type === 'progressive' || type === 'dash') return ['native'];
  // unknown (e.g. extension-less panel URLs): TS is most common, then HLS
  return [...ts, ...hls, 'native'];
}

/** Seconds of media buffered ahead of the playhead. */
function bufferedAhead(v: HTMLVideoElement): number {
  const t = v.currentTime;
  for (let i = 0; i < v.buffered.length; i++) {
    if (v.buffered.start(i) <= t + 0.3 && v.buffered.end(i) > t) return v.buffered.end(i) - t;
  }
  return 0;
}

// Live playlists from IPTV panels hiccup (a 404 or a slow reload) far more often than VOD CDNs;
// ride those out from the buffer instead of tearing the stream down after two failures.
const retry = (maxNumRetry: number) => ({ maxNumRetry, retryDelayMs: 1000, maxRetryDelayMs: 8000 });
const hlsConfig = (p: BufferProfile): Partial<ConstructorParameters<typeof Hls>[0]> => ({
  enableWorker: true,
  backBufferLength: 30,
  maxBufferLength: p.ahead,
  liveSyncDurationCount: p.hlsLiveSegments,
  // start multi-bitrate streams near HD instead of at the lowest rendition and stepping up
  abrEwmaDefaultEstimate: 4_000_000,
  // an unplayable URL fails fast so the next engine / format can be tried
  manifestLoadPolicy: { default: { maxTimeToFirstByteMs: 10000, maxLoadTimeMs: 20000, timeoutRetry: retry(1), errorRetry: retry(1) } },
  playlistLoadPolicy: { default: { maxTimeToFirstByteMs: 10000, maxLoadTimeMs: 20000, timeoutRetry: retry(4), errorRetry: retry(6) } },
  fragLoadPolicy: { default: { maxTimeToFirstByteMs: 10000, maxLoadTimeMs: 120000, timeoutRetry: retry(4), errorRetry: retry(6) } },
});

// The volume is remembered per browser (TVs and phones use their own volume keys)
const VOLUME_KEY = 'nova.volume';
function savedVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return localStorage.getItem(VOLUME_KEY) !== null && isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  } catch {
    return 1;
  }
}

/** Browser playback: hls.js for HLS, mpegts.js for raw MPEG-TS, <video> for everything else. */
export function VideoSurface({ source, nonce, resumeAt, style }: Props) {
  const fit = usePlayback((s) => s.fit);
  const set = usePlayback((s) => s.set);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const tsRef = useRef<mpegts.Player | null>(null);
  const bufferMode = useSettings((s) => s.prefs.liveBuffer ?? 'balanced');
  const profile = BUFFER_PROFILES[bufferMode] ?? BUFFER_PROFILES.balanced;
  // Live stall handling: the element resumes as soon as a few frames arrive, which turns one network
  // hiccup into a stop-start loop. Instead it's held paused until the buffer has refilled.
  const live = useRef({ isLive: false, played: false, stalls: 0, holding: false, timer: 0 as ReturnType<typeof setInterval> | 0, profile });
  live.current.profile = profile;
  const endHold = () => {
    const l = live.current;
    if (l.timer) clearInterval(l.timer);
    l.timer = 0;
    l.holding = false;
  };

  // commands
  useEffect(() => {
    const doc = typeof document !== 'undefined' ? (document as any) : null;
    set({
      engine: 'web',
      volume: savedVolume(),
      caps: {
        speed: true,
        mute: true,
        volume: true,
        quality: false,
        pip: !!doc?.pictureInPictureEnabled,
        airplay: false,
        fullscreen: !!doc?.fullscreenEnabled,
      },
      cmd: {
        play: () => {
          endHold();
          void videoRef.current?.play().catch(() => {});
        },
        pause: () => {
          endHold();
          videoRef.current?.pause();
        },
        seekTo: (sec) => {
          endHold();
          if (videoRef.current) videoRef.current.currentTime = Math.max(0, sec);
        },
        seekBy: (sec) => {
          endHold();
          const v = videoRef.current;
          if (v) v.currentTime = Math.max(0, Math.min((v.duration || Infinity) - 1, v.currentTime + sec));
        },
        setAudio: (i) => {
          if (hlsRef.current) hlsRef.current.audioTrack = i;
          set({ audioIndex: i });
        },
        setSubtitle: (i) => {
          if (hlsRef.current) {
            hlsRef.current.subtitleTrack = i;
            hlsRef.current.subtitleDisplay = i >= 0;
          }
          set({ subtitleIndex: i });
        },
        setRate: (rate) => {
          if (videoRef.current) videoRef.current.playbackRate = rate;
          set({ rate });
        },
        setMuted: (muted) => {
          if (videoRef.current) videoRef.current.muted = muted;
          set({ muted });
        },
        setVolume: (value) => {
          const volume = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
          const v = videoRef.current;
          if (v) {
            v.volume = volume;
            if (volume > 0 && v.muted) v.muted = false;
          }
          set({ volume, muted: v ? v.muted : usePlayback.getState().muted });
          try {
            localStorage.setItem(VOLUME_KEY, String(volume));
          } catch {
            // private mode: just not remembered
          }
        },
        setQuality: (i) => {
          const hls = hlsRef.current;
          if (!hls) return;
          const q = usePlayback.getState().qualities[i];
          // qualities are listed best-first; the id is hls.js' level index
          hls.currentLevel = q ? Number(q.id) : -1;
          set({ qualityIndex: q ? i : -1 });
        },
        togglePip: () => {
          const v = videoRef.current as any;
          if (!v || !doc?.pictureInPictureEnabled) return;
          if (doc.pictureInPictureElement) void doc.exitPictureInPicture();
          else void v.requestPictureInPicture?.().catch(() => {});
        },
        toggleFullscreen: () => {
          if (!doc?.fullscreenEnabled) return;
          // the whole app goes fullscreen so Nova's own controls stay on top of the video
          if (doc.fullscreenElement) void doc.exitFullscreen();
          else void doc.documentElement.requestFullscreen?.().catch(() => {});
        },
      },
    });
  }, [set]);

  // DOM listeners
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = savedVolume();
    const on = (ev: string, fn: () => void) => {
      v.addEventListener(ev, fn);
      return () => v.removeEventListener(ev, fn);
    };
    const refill = () => {
      const l = live.current;
      if (!l.isLive || !l.played || l.holding || v.paused || v.seeking) return;
      l.stalls++;
      l.holding = true;
      const need = refillAfterStall(l.profile, l.stalls);
      const since = Date.now();
      v.pause();
      l.timer = setInterval(() => {
        const ahead = bufferedAhead(v);
        // give up waiting for the full amount on a slow line: better some video than none
        if (ahead >= need || (Date.now() - since > 10000 && ahead > 0.5)) {
          endHold();
          void v.play().catch(() => {});
        }
      }, 250);
    };
    const offs = [
      on('waiting', () => {
        if (usePlayback.getState().status !== 'error') set({ status: 'loading' });
        refill();
      }),
      on('playing', () => {
        live.current.played = true;
        set({ status: 'playing', error: undefined });
      }),
      on('pause', () => usePlayback.getState().status !== 'error' && set({ status: live.current.holding ? 'loading' : 'paused' })),
      on('ended', () => set({ status: 'ended' })),
      on('timeupdate', () => {
        const st = usePlayback.getState().status;
        // 'playing' isn't always re-fired after a seek, so derive it from progress
        const status = !v.paused && v.readyState >= 3 && st !== 'error' ? 'playing' : st;
        set({ position: v.currentTime, duration: isFinite(v.duration) ? v.duration : 0, status });
      }),
      on('durationchange', () => set({ duration: isFinite(v.duration) ? v.duration : 0 })),
      on('volumechange', () => set({ muted: v.muted, volume: v.volume })),
      on('ratechange', () => set({ rate: v.playbackRate })),
      on('enterpictureinpicture', () => set({ pip: true })),
      on('leavepictureinpicture', () => set({ pip: false })),
    ];
    return () => {
      endHold();
      offs.forEach((f) => f());
    };
  }, [set]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;

    const teardown = () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (tsRef.current) {
        try {
          tsRef.current.pause();
          tsRef.current.unload();
          tsRef.current.detachMediaElement();
          tsRef.current.destroy();
        } catch {
          // already torn down
        }
        tsRef.current = null;
      }
      video.removeAttribute('src');
      video.load();
    };

    teardown();
    endHold();
    Object.assign(live.current, { isLive: !!source?.isLive, played: false, stalls: 0 });
    if (!source) {
      set({ status: 'idle', position: 0, duration: 0, error: undefined });
      return;
    }
    set({
      status: 'loading',
      error: undefined,
      position: 0,
      duration: 0,
      audioTracks: [],
      subtitleTracks: [],
      audioIndex: -1,
      subtitleIndex: -1,
      qualities: [],
      qualityIndex: -1,
      autoQuality: undefined,
      rate: 1,
      caps: { ...usePlayback.getState().caps, quality: false },
    });
    video.playbackRate = 1;

    const candidates = [source.uri, source.fallback].filter(Boolean) as string[];
    const attempts: { uri: string; engine: Engine }[] = candidates.flatMap((uri) => enginesFor(uri, video).map((engine) => ({ uri, engine })));
    let attempt = -1;
    let lastError = 'Playback failed';

    const startPlay = () => {
      if (resumeAt) {
        const seek = () => {
          video.currentTime = resumeAt;
          video.removeEventListener('loadedmetadata', seek);
        };
        video.addEventListener('loadedmetadata', seek);
      }
      video.play().catch((e) => {
        if (cancelled || e?.name !== 'NotAllowedError') return;
        // Browsers block autoplay with sound: start muted (the player offers "tap to unmute")
        video.muted = true;
        set({ muted: true });
        video.play().catch(() => !cancelled && set({ status: 'paused' }));
      });
    };

    const next = (reason?: string) => {
      if (cancelled) return;
      if (reason) lastError = reason;
      teardown();
      attempt++;
      if (attempt >= attempts.length) {
        set({ status: 'error', error: lastError });
        return;
      }
      const { uri, engine } = attempts[attempt];
      const url = proxify(uri, source.userAgent);

      if (engine === 'hls') {
        const hls = new Hls(hlsConfig(profile));
        hlsRef.current = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // Quality menu: one entry per resolution, best first ("Auto" = ABR)
          const seen = new Set<number>();
          const levels = hls.levels
            .map((l, i) => ({ i, h: l.height || 0, br: l.bitrate || 0 }))
            .filter((l) => l.h > 0)
            .sort((a, b) => b.h - a.h || b.br - a.br)
            .filter((l) => (seen.has(l.h) ? false : (seen.add(l.h), true)));
          set({
            qualities: levels.map((l) => ({ id: String(l.i), label: `${l.h}p` })),
            qualityIndex: -1,
            caps: { ...usePlayback.getState().caps, quality: levels.length > 1 },
          });
          startPlay();
        });
        hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
          const h = hls.levels[data.level]?.height;
          set({ autoQuality: h ? `${h}p` : undefined });
        });
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
          set({
            audioTracks: hls.audioTracks.map((t, i) => ({ id: String(i), label: t.name || t.lang || `Audio ${i + 1}` })),
            audioIndex: hls.audioTrack,
          });
        });
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
          set({
            subtitleTracks: hls.subtitleTracks.map((t, i) => ({ id: String(i), label: t.name || t.lang || `Subtitle ${i + 1}` })),
            subtitleIndex: hls.subtitleTrack,
          });
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }
          const status = (data.response as any)?.code;
          next(status ? `Stream returned HTTP ${status}` : `Stream error (${data.details})`);
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      } else if (engine === 'mpegts') {
        const player = mpegts.createPlayer(
          // mpegts.js fetches from a Web Worker, where the same-origin "/api/proxy?…" path has no base to resolve against
          { type: 'mpegts', isLive: source.isLive, url: new URL(url, location.href).href },
          // No latency chasing: it skipped ahead whenever more than 1.5 s was buffered, which showed as
          // jumps and left too little buffer to ride out the next hiccup
          { enableWorker: true, lazyLoad: false, liveBufferLatencyChasing: false, autoCleanupSourceBuffer: true }
        );
        tsRef.current = player;
        let gotData = false;
        player.on(mpegts.Events.MEDIA_INFO, () => {
          gotData = true;
        });
        player.on(mpegts.Events.ERROR, (type: string, detail: string) => {
          next(gotData ? `Stream error: ${detail}` : `Stream unavailable (${type})`);
        });
        player.attachMediaElement(video);
        player.load();
        startPlay();
      } else {
        const onErr = () => {
          video.removeEventListener('error', onErr);
          next(video.error?.message || 'This format is not supported in the browser');
        };
        video.addEventListener('error', onErr);
        video.src = url;
        startPlay();
      }
    };

    next();
    return () => {
      cancelled = true;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.uri, source?.userAgent, nonce]);

  return (
    <View style={[{ backgroundColor: '#000', overflow: 'hidden' }, style]}>
      {React.createElement('video', {
        ref: videoRef,
        playsInline: true,
        autoPlay: true,
        style: { width: '100%', height: '100%', objectFit: fit, backgroundColor: '#000', display: 'block' },
      })}
    </View>
  );
}
