import React, { useEffect, useRef, useState } from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import { isPictureInPictureSupported, useVideoPlayer, VideoView, type VideoSource } from 'expo-video';
import { useEventListener } from 'expo';
import { usePlayer, type Source } from '../store/player';
import { useSettings } from '../store/settings';
import { imageUrl } from '../services/http';
import { guessContentType, preferVlc, usePlayback } from './playback';
import { VlcSurface } from './VlcSurface';
import { VlcPlayerView } from '../../modules/vlc-player';

interface Props {
  source: Source | null;
  nonce: number;
  resumeAt?: number;
  style?: StyleProp<ViewStyle>;
}

function toVideoSource(uri: string, src: Source): VideoSource {
  const type = guessContentType(uri);
  return {
    uri,
    headers: { 'User-Agent': src.userAgent },
    contentType: type === 'auto' ? 'auto' : type,
    // Feeds the iOS lock screen / Control Center and the Android media session (Alexa, Bluetooth)
    metadata: { title: src.title, artist: src.subtitle, artwork: imageUrl(src.artwork) },
  };
}

/**
 * Picks the playback engine. Android/Fire TV: ExoPlayer (handles MKV/TS/HLS itself).
 * iOS: AVPlayer for HLS/MP4 (hardware-friendly), libVLC for MKV/AVI/raw TS and anything
 * AVPlayer fails on — AVPlayer can't open those containers at all.
 */
export function VideoSurface(props: Props) {
  const iosPlayer = useSettings((s) => s.prefs.iosPlayer ?? 'auto');
  const [failedOnNative, setFailedOnNative] = useState<string | null>(null);
  const vlc = Platform.OS === 'ios' && !!VlcPlayerView;
  // keyed by URL only, so reconnects of a stream AVPlayer can't handle stay on VLC
  const key = props.source?.uri ?? '';

  let engine: 'native' | 'vlc' = 'native';
  if (vlc && props.source) {
    if (iosPlayer === 'vlc') engine = 'vlc';
    else if (iosPlayer === 'auto' && (preferVlc(props.source.uri) || failedOnNative === key)) engine = 'vlc';
  }

  if (engine === 'vlc') return <VlcSurface {...props} />;
  return <NativeSurface {...props} onFail={vlc && iosPlayer === 'auto' ? () => setFailedOnNative(key) : undefined} />;
}

const PIP = !Platform.isTV && isPictureInPictureSupported();

/** expo-video: ExoPlayer on Android/Fire TV, AVPlayer on iOS. */
function NativeSurface({ source, nonce, resumeAt, style, onFail }: Props & { onFail?: () => void }) {
  const fit = usePlayback((s) => s.fit);
  const set = usePlayback((s) => s.set);
  const fullscreen = usePlayer((s) => s.fullscreen);
  const viewRef = useRef<VideoView>(null);
  const triedFallback = useRef(false);
  const pendingSeek = useRef<number | undefined>(undefined);
  // ExoPlayer reports "ended" for a fresh player with nothing loaded yet; only trust
  // playToEnd once the current source has actually played.
  const hasPlayed = useRef(false);

  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 1;
    p.keepScreenOnWhilePlaying = true;
    p.bufferOptions = { preferredForwardBufferDuration: 20, minBufferForPlayback: 1.5 };
    // Lock screen / Control Center controls on iOS; media session + notification on Android
    p.showNowPlayingNotification = true;
  });

  useEffect(() => {
    set({
      engine: 'native',
      caps: { speed: true, mute: true, volume: false, quality: false, pip: PIP, airplay: Platform.OS === 'ios', fullscreen: false },
      rate: 1,
      muted: false,
      qualities: [],
      qualityIndex: -1,
      cmd: {
        play: () => player.play(),
        pause: () => player.pause(),
        seekTo: (sec) => {
          player.currentTime = Math.max(0, sec);
        },
        seekBy: (sec) => player.seekBy(sec),
        setAudio: (i) => {
          const t = player.availableAudioTracks[i];
          if (t) player.audioTrack = t;
          set({ audioIndex: i });
        },
        setSubtitle: (i) => {
          player.subtitleTrack = i < 0 ? null : (player.availableSubtitleTracks[i] ?? null);
          set({ subtitleIndex: i });
        },
        setRate: (rate) => {
          player.playbackRate = rate;
          set({ rate });
        },
        setMuted: (muted) => {
          player.muted = muted;
          set({ muted });
        },
        setVolume: (volume) => {
          player.volume = volume;
          set({ volume });
        },
        setQuality: () => {},
        togglePip: () => {
          if (!PIP) return;
          if (usePlayback.getState().pip) void viewRef.current?.stopPictureInPicture();
          else void viewRef.current?.startPictureInPicture();
        },
        toggleFullscreen: () => {},
      },
    });
  }, [player, set]);

  useEffect(() => {
    triedFallback.current = false;
    hasPlayed.current = false;
    if (!source) {
      player.pause();
      player.replace(null);
      set({ status: 'idle', position: 0, duration: 0, error: undefined });
      return;
    }
    pendingSeek.current = resumeAt;
    set({ status: 'loading', error: undefined, position: 0, duration: 0, audioTracks: [], subtitleTracks: [], audioIndex: -1, subtitleIndex: -1 });
    player.playbackRate = 1;
    player.replace(toVideoSource(source.uri, source), true);
    player.play();
    set({ rate: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.uri, source?.userAgent, nonce, player]);

  useEventListener(player, 'statusChange', ({ status, error }) => {
    if (status === 'error') {
      // iOS: hand the stream to VLC instead of retrying AVPlayer
      if (onFail) {
        player.pause();
        onFail();
        return;
      }
      if (source?.fallback && !triedFallback.current) {
        triedFallback.current = true;
        player.replace(toVideoSource(source.fallback, source), true);
        player.play();
        return;
      }
      set({ status: 'error', error: error?.message ?? 'Playback failed' });
    } else if (status === 'loading') {
      set({ status: 'loading' });
    } else if (status === 'readyToPlay') {
      if (pendingSeek.current) {
        player.currentTime = pendingSeek.current;
        pendingSeek.current = undefined;
      }
      set({ status: player.playing ? 'playing' : 'paused' });
    }
  });

  useEventListener(player, 'playingChange', ({ isPlaying }) => {
    if (isPlaying) hasPlayed.current = true;
    if (usePlayback.getState().status === 'error') return;
    set({ status: isPlaying ? 'playing' : player.status === 'loading' ? 'loading' : 'paused' });
  });

  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    set({ position: currentTime, duration: player.duration || 0 });
  });

  useEventListener(player, 'playToEnd', () => {
    if (hasPlayed.current) set({ status: 'ended' });
  });

  useEventListener(player, 'mutedChange', ({ muted }) => set({ muted }));

  useEventListener(player, 'sourceLoad', ({ duration, availableAudioTracks, availableSubtitleTracks }) => {
    set({
      duration: duration || 0,
      audioTracks: availableAudioTracks.map((t, i) => ({ id: String(i), label: t.label || t.language || `Track ${i + 1}` })),
      subtitleTracks: availableSubtitleTracks.map((t, i) => ({ id: String(i), label: t.label || t.language || `Subtitle ${i + 1}` })),
      audioIndex: Math.max(0, availableAudioTracks.findIndex((t) => t.id === player.audioTrack?.id)),
      subtitleIndex: availableSubtitleTracks.findIndex((t) => t.id === player.subtitleTrack?.id),
    });
  });

  return (
    <VideoView
      ref={viewRef}
      player={player}
      nativeControls={false}
      contentFit={fit}
      style={style}
      allowsPictureInPicture={PIP}
      // Leaving the app while watching fullscreen continues in Picture in Picture (iOS, Android 12+)
      startsPictureInPictureAutomatically={PIP && fullscreen}
      onPictureInPictureStart={() => set({ pip: true })}
      onPictureInPictureStop={() => set({ pip: false })}
    />
  );
}
