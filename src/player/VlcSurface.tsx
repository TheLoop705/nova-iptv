import React, { useEffect, useRef, useState } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { VlcPlayerView, type VlcPlayerRef, type VlcStatus } from '../../modules/vlc-player';
import type { Source } from '../store/player';
import { usePlayback } from './playback';

interface Props {
  source: Source | null;
  nonce: number;
  resumeAt?: number;
  style?: StyleProp<ViewStyle>;
}

const MAX_LIVE_RECONNECTS = 3;

/** iOS playback through libVLC: MKV, AVI, raw MPEG-TS and anything else AVPlayer can't open. */
export function VlcSurface({ source, nonce, resumeAt, style }: Props) {
  const fit = usePlayback((s) => s.fit);
  const set = usePlayback((s) => s.set);
  const ref = useRef<VlcPlayerRef>(null);
  const [uri, setUri] = useState(source?.uri);
  const [reload, setReload] = useState(0);
  const triedFallback = useRef(false);
  const pendingSeek = useRef<number | undefined>(undefined);
  const reconnects = useRef(0);
  const trackIds = useRef<{ audio: number[]; subs: number[] }>({ audio: [], subs: [] });

  useEffect(() => {
    triedFallback.current = false;
    reconnects.current = 0;
    pendingSeek.current = resumeAt;
    setUri(source?.uri);
    set({ status: 'loading', error: undefined, position: 0, duration: 0, audioTracks: [], subtitleTracks: [], audioIndex: -1, subtitleIndex: -1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.uri, source?.userAgent, nonce]);

  useEffect(() => {
    set({
      engine: 'vlc',
      caps: { speed: true, mute: true, quality: false, pip: false, airplay: false, fullscreen: false },
      rate: 1,
      muted: false,
      qualities: [],
      qualityIndex: -1,
      pip: false,
      cmd: {
        setRate: (rate) => {
          void ref.current?.setRate(rate);
          set({ rate });
        },
        setMuted: (muted) => {
          void ref.current?.setMuted(muted);
          set({ muted });
        },
        setQuality: () => {},
        togglePip: () => {},
        toggleFullscreen: () => {},
        play: () => void ref.current?.play(),
        pause: () => void ref.current?.pause(),
        seekTo: (sec) => void ref.current?.seekTo(sec),
        seekBy: (sec) => void ref.current?.seekBy(sec),
        setAudio: (i) => {
          const id = trackIds.current.audio[i];
          if (id !== undefined) void ref.current?.setAudioTrack(id);
          set({ audioIndex: i });
        },
        setSubtitle: (i) => {
          void ref.current?.setSubtitleTrack(i < 0 ? -1 : (trackIds.current.subs[i] ?? -1));
          set({ subtitleIndex: i });
        },
      },
    });
  }, [set]);

  const onStatus = (status: VlcStatus, error?: string) => {
    switch (status) {
      case 'opening':
      case 'buffering':
        return set({ status: 'loading' });
      case 'playing':
        reconnects.current = 0;
        if (pendingSeek.current) {
          const at = pendingSeek.current;
          pendingSeek.current = undefined;
          void ref.current?.seekTo(at);
        }
        return set({ status: 'playing', error: undefined });
      case 'paused':
        return set({ status: 'paused' });
      case 'ended':
        // Live streams "end" when the provider drops the connection: reconnect a few times
        if (source?.isLive && reconnects.current < MAX_LIVE_RECONNECTS) {
          reconnects.current++;
          set({ status: 'loading' });
          setTimeout(() => setReload((r) => r + 1), 800);
          return;
        }
        return set({ status: 'ended' });
      case 'error':
        if (source?.fallback && !triedFallback.current) {
          triedFallback.current = true;
          setUri(source.fallback);
          return;
        }
        return set({ status: 'error', error: error ?? "This stream can't be played" });
    }
  };

  if (!VlcPlayerView || !source || !uri) return null;
  return (
    <VlcPlayerView
      ref={ref}
      style={style}
      fit={fit}
      source={{ uri, userAgent: source.userAgent, isLive: source.isLive, nonce: nonce * 1000 + reload, title: source.title, subtitle: source.subtitle }}
      onStatus={(e) => onStatus(e.nativeEvent.status, e.nativeEvent.error)}
      onProgress={(e) => set({ position: e.nativeEvent.position, duration: e.nativeEvent.duration })}
      onTracks={(e) => {
        const { audio, subtitles, audioId, subtitleId } = e.nativeEvent;
        trackIds.current = { audio: audio.map((t) => t.id), subs: subtitles.map((t) => t.id) };
        set({
          audioTracks: audio.map((t) => ({ id: String(t.id), label: t.label })),
          subtitleTracks: subtitles.map((t) => ({ id: String(t.id), label: t.label })),
          audioIndex: audio.findIndex((t) => t.id === audioId),
          subtitleIndex: subtitles.findIndex((t) => t.id === subtitleId),
        });
      }}
    />
  );
}
