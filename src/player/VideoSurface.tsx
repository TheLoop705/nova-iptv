import React, { useEffect, useRef, useState } from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import { useVideoPlayer, VideoView, type VideoSource } from 'expo-video';
import { useEventListener } from 'expo';
import type { Source } from '../store/player';
import { useSettings } from '../store/settings';
import { guessContentType, preferVlc, usePlayback } from './playback';
import { VlcSurface } from './VlcSurface';
import { VlcPlayerView } from '../../modules/vlc-player';

interface Props {
  source: Source | null;
  nonce: number;
  resumeAt?: number;
  style?: StyleProp<ViewStyle>;
}

function toVideoSource(uri: string, ua: string): VideoSource {
  const type = guessContentType(uri);
  return {
    uri,
    headers: { 'User-Agent': ua },
    contentType: type === 'auto' ? 'auto' : type,
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
  const key = props.source ? `${props.source.uri}#${props.nonce}` : '';

  let engine: 'native' | 'vlc' = 'native';
  if (vlc && props.source) {
    if (iosPlayer === 'vlc') engine = 'vlc';
    else if (iosPlayer === 'auto' && (preferVlc(props.source.uri) || failedOnNative === key)) engine = 'vlc';
  }

  if (engine === 'vlc') return <VlcSurface {...props} />;
  return <NativeSurface {...props} onFail={vlc && iosPlayer === 'auto' ? () => setFailedOnNative(key) : undefined} />;
}

/** expo-video: ExoPlayer on Android/Fire TV, AVPlayer on iOS. */
function NativeSurface({ source, nonce, resumeAt, style, onFail }: Props & { onFail?: () => void }) {
  const fit = usePlayback((s) => s.fit);
  const set = usePlayback((s) => s.set);
  const triedFallback = useRef(false);
  const pendingSeek = useRef<number | undefined>(undefined);

  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 1;
    p.keepScreenOnWhilePlaying = true;
    p.bufferOptions = { preferredForwardBufferDuration: 20, minBufferForPlayback: 1.5 };
  });

  useEffect(() => {
    set({
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
      },
    });
  }, [player, set]);

  useEffect(() => {
    triedFallback.current = false;
    if (!source) {
      player.pause();
      player.replace(null);
      set({ status: 'idle', position: 0, duration: 0, error: undefined });
      return;
    }
    pendingSeek.current = resumeAt;
    set({ status: 'loading', error: undefined, position: 0, duration: 0, audioTracks: [], subtitleTracks: [], audioIndex: -1, subtitleIndex: -1 });
    player.replace(toVideoSource(source.uri, source.userAgent), true);
    player.play();
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
        player.replace(toVideoSource(source.fallback, source.userAgent), true);
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
    if (usePlayback.getState().status === 'error') return;
    set({ status: isPlaying ? 'playing' : player.status === 'loading' ? 'loading' : 'paused' });
  });

  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    set({ position: currentTime, duration: player.duration || 0 });
  });

  useEventListener(player, 'playToEnd', () => set({ status: 'ended' }));

  useEventListener(player, 'sourceLoad', ({ duration, availableAudioTracks, availableSubtitleTracks }) => {
    set({
      duration: duration || 0,
      audioTracks: availableAudioTracks.map((t, i) => ({ id: String(i), label: t.label || t.language || `Track ${i + 1}` })),
      subtitleTracks: availableSubtitleTracks.map((t, i) => ({ id: String(i), label: t.label || t.language || `Subtitle ${i + 1}` })),
      audioIndex: Math.max(0, availableAudioTracks.findIndex((t) => t.id === player.audioTrack?.id)),
      subtitleIndex: availableSubtitleTracks.findIndex((t) => t.id === player.subtitleTrack?.id),
    });
  });

  return <VideoView player={player} nativeControls={false} contentFit={fit} style={style} allowsPictureInPicture={false} />;
}
