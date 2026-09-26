import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { usePlayer } from '../store/player';
import { useLibrary, useAllGroups, ALL } from '../store/library';
import { flushSettings, useSettings } from '../store/settings';
import { useUI } from '../store/ui';
import { Layer, useKeys, type KeyEvt } from '../input/keys';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, radius, useLayout } from '../theme';
import { Badge } from '../components/Badge';
import { usePlayback, type Fit } from './playback';
import { nextProgram, programAt } from '../services/epg';
import { canCatchup } from '../services/catchup';
import { formatClock, formatDuration, formatRange } from '../utils/format';
import { useNow } from '../utils/hooks';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';
import { Focusable } from '../components/Focusable';
import { PlayerGestures, PlayerNotices, SeekBar, TOUCH_MIN, VolumeSlider } from './PlayerExtras';
import { SPEEDS } from './playback';
import { playNextItem } from '../services/vod';
import type { Channel } from '../types';

interface Control {
  id: string;
  icon: string;
  label: string;
  active?: boolean;
}

const FIT_LABEL: Record<Fit, string> = { contain: 'Fit', cover: 'Zoom', fill: 'Stretch' };
const FIT_NEXT: Record<Fit, Fit> = { contain: 'cover', cover: 'fill', fill: 'contain' };

export function PlayerOverlay() {
  const { mode, safe, player: k } = useLayout();
  const tv = mode === 'tv';
  // phones in landscape: keep controls clear of the notch and home indicator; TVs: of the overscan
  const ins = useSafeAreaInsets();
  const edgeX = Math.max(ins.left, ins.right, safe.x);
  const edgeY = Math.max(ins.bottom, safe.y);

  const item = usePlayer((st) => st.item)!;
  const groupId = usePlayer((st) => st.groupId);
  const playChannel = usePlayer((st) => st.playChannel);
  const playCatchup = usePlayer((st) => st.playCatchup);
  const setFullscreen = usePlayer((st) => st.setFullscreen);
  const stop = usePlayer((st) => st.stop);
  const retry = usePlayer((st) => st.retry);
  const recall = usePlayer((st) => st.recall);

  const byId = useLibrary((st) => st.byId);
  const epg = useLibrary((st) => st.epg);
  const pid = useLibrary((st) => st.playlistId);
  const groups = useAllGroups();
  const prefs = useSettings((st) => st.prefs);
  const favorites = useSettings((st) => (pid ? st.favorites[pid] : undefined));
  const toggleFavorite = useSettings((st) => st.toggleFavorite);
  const saveVodProgress = useSettings((st) => st.saveVodProgress);
  const openSheet = useUI((st) => st.openSheet);
  const showToast = useUI((st) => st.showToast);
  const sheetOpen = useUI((st) => !!st.sheet);

  const status = usePlayback((st) => st.status);
  const error = usePlayback((st) => st.error);
  const position = usePlayback((st) => st.position);
  const duration = usePlayback((st) => st.duration);
  const audioTracks = usePlayback((st) => st.audioTracks);
  const subtitleTracks = usePlayback((st) => st.subtitleTracks);
  const fit = usePlayback((st) => st.fit);
  const cmd = usePlayback((st) => st.cmd);
  const caps = usePlayback((st) => st.caps);
  const rate = usePlayback((st) => st.rate);
  const muted = usePlayback((st) => st.muted);
  const volume = usePlayback((st) => st.volume);
  const qualities = usePlayback((st) => st.qualities);
  const qualityIndex = usePlayback((st) => st.qualityIndex);
  const autoQuality = usePlayback((st) => st.autoQuality);
  const autoplayNext = useSettings((st) => st.prefs.autoplayNext ?? true);

  const now = useNow(5000);
  const live = item.kind === 'live';
  const ch: Channel | undefined = item.kind !== 'vod' ? byId[item.channelId] : undefined;
  const programs = ch ? epg[ch.id] : undefined;
  const program = item.kind === 'catchup' ? item.program : ch ? programAt(programs, now) : undefined;
  const next = program ? nextProgram(programs, program.end - 1) : undefined;
  const isFav = !!ch && !!favorites?.includes(ch.id);

  const [visible, setVisible] = useState(true);
  const [row, setRow] = useState<'seek' | 'controls'>(live ? 'controls' : 'seek');
  const [ctrl, setCtrl] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const [digits, setDigits] = useState('');
  const [upNext, setUpNext] = useState<NonNullable<Extract<typeof item, { kind: 'vod' }>['next']> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const digitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poke = useCallback(() => {
    setVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      const st = usePlayback.getState().status;
      if (st === 'playing') setVisible(false);
    }, 5000);
  }, []);

  useEffect(() => {
    poke();
    setUpNext(null);
    setRow(live ? 'controls' : 'seek');
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  useEffect(() => {
    if (status === 'playing') poke();
    else if (status === 'paused' || status === 'error') setVisible(true);
  }, [status, poke]);

  // VOD resume points
  const posRef = useRef({ position, duration });
  posRef.current = { position, duration };
  useEffect(() => {
    if (item.kind !== 'vod') return;
    const t = setInterval(() => {
      const { position: p, duration: d } = posRef.current;
      if (p > 0 && d > 0) saveVodProgress(item.key, p, d);
    }, 10000);
    return () => clearInterval(t);
  }, [item, saveVodProgress]);

  // Web: a refresh or closed tab keeps the exact position, not the last 10 s tick
  useEffect(() => {
    if (item.kind !== 'vod' || Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onHide = () => {
      const { position: p, duration: d } = posRef.current;
      if (p > 0 && d > 0) useSettings.getState().saveVodProgress(item.key, p, d);
      flushSettings();
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [item]);

  // Only an item that actually played can end: never act on a stale "ended" left by the previous one
  const played = useRef(false);
  useEffect(() => {
    played.current = false;
  }, [item]);
  useEffect(() => {
    if (status === 'playing') played.current = true;
  }, [status]);

  useEffect(() => {
    if (status === 'ended' && item.kind !== 'live' && played.current) {
      if (item.kind === 'vod') saveVodProgress(item.key, duration, duration);
      // Series: offer the next episode with a countdown instead of closing the player
      if (item.kind === 'vod' && item.next && autoplayNext) {
        setVisible(false);
        setUpNext(item.next);
      } else stop();
    }
  }, [status, item, duration, saveVodProgress, stop, autoplayNext]);

  const exit = useCallback(() => {
    if (item.kind === 'vod') {
      const { position: p, duration: d } = posRef.current;
      if (p > 0) saveVodProgress(item.key, p, d);
      stop();
    } else if (item.kind === 'catchup') {
      stop();
    } else {
      setFullscreen(false);
    }
  }, [item, saveVodProgress, stop, setFullscreen]);

  const zapList = useMemo(() => {
    const g = groups.find((x) => x.id === groupId) ?? groups.find((x) => x.id === ALL);
    return g?.channelIds ?? [];
  }, [groups, groupId]);

  const zap = (delta: number) => {
    if (!ch || !zapList.length) return;
    const i = zapList.indexOf(ch.id);
    const n = zapList.length;
    const nextId = zapList[(((i < 0 ? 0 : i) + delta) % n + n) % n];
    playChannel(nextId);
    poke();
  };

  const controls: Control[] = useMemo(() => {
    const list: Control[] = [];
    if (live) {
      list.push({ id: 'list', icon: 'format-list-bulleted', label: 'Channels' });
      list.push({ id: 'guide', icon: 'view-dashboard-outline', label: 'Guide' });
      list.push({ id: 'fav', icon: isFav ? 'star' : 'star-outline', label: isFav ? 'Favorited' : 'Favorite', active: isFav });
      if (ch && program && canCatchup(ch, program, now)) list.push({ id: 'restart', icon: 'restart', label: 'Restart' });
    } else {
      list.push({ id: 'playpause', icon: status === 'paused' ? 'play' : 'pause', label: status === 'paused' ? 'Play' : 'Pause' });
      list.push({ id: 'rw', icon: 'rewind-10', label: '-10s' });
      list.push({ id: 'ff', icon: 'fast-forward-10', label: '+10s' });
      if (item.kind === 'catchup') list.push({ id: 'golive', icon: 'broadcast', label: 'Live' });
    }
    if (audioTracks.length > 1) list.push({ id: 'audio', icon: 'volume-high', label: 'Audio' });
    if (subtitleTracks.length) list.push({ id: 'subs', icon: 'subtitles-outline', label: 'Subtitles' });
    list.push({ id: 'fit', icon: 'aspect-ratio', label: FIT_LABEL[fit] });
    if (!live && caps.speed) list.push({ id: 'speed', icon: 'speedometer', label: `${rate}x`, active: rate !== 1 });
    if (caps.quality) {
      const q = qualityIndex >= 0 ? qualities[qualityIndex]?.label : autoQuality ? `Auto · ${autoQuality}` : 'Auto';
      list.push({ id: 'quality', icon: 'high-definition-box', label: q ?? 'Auto' });
    }
    if (caps.mute && caps.fullscreen) list.push({ id: 'mute', icon: muted ? 'volume-off' : 'volume-high', label: muted ? 'Unmute' : 'Mute', active: muted });
    if (caps.pip) list.push({ id: 'pip', icon: 'picture-in-picture-bottom-right', label: 'PiP' });
    if (caps.fullscreen) list.push({ id: 'fullscreen', icon: 'fullscreen', label: 'Fullscreen' });
    return list;
  }, [live, isFav, ch, program, now, status, item.kind, audioTracks.length, subtitleTracks.length, fit, caps, rate, qualities, qualityIndex, autoQuality, muted]);

  useEffect(() => {
    if (ctrl >= controls.length) setCtrl(controls.length - 1);
  }, [controls.length, ctrl]);

  const togglePlay = () => (usePlayback.getState().status === 'playing' ? cmd.pause() : cmd.play());

  const audioSheet = () =>
    openSheet({
      title: 'Audio track',
      options: audioTracks.map((t, i) => ({ label: t.label, selected: i === usePlayback.getState().audioIndex, onSelect: () => cmd.setAudio(i) })),
    });
  const subsSheet = () =>
    openSheet({
      title: 'Subtitles',
      options: [
        { label: 'Off', selected: usePlayback.getState().subtitleIndex < 0, onSelect: () => cmd.setSubtitle(-1) },
        ...subtitleTracks.map((t, i) => ({ label: t.label, selected: i === usePlayback.getState().subtitleIndex, onSelect: () => cmd.setSubtitle(i) })),
      ],
    });
  const fitSheet = () =>
    openSheet({
      title: 'Aspect ratio',
      options: (['contain', 'cover', 'fill'] as Fit[]).map((f) => ({
        label: FIT_LABEL[f],
        detail: f === 'contain' ? 'Show the whole picture' : f === 'cover' ? 'Fill the screen, crop edges' : 'Stretch to the screen',
        selected: f === usePlayback.getState().fit,
        onSelect: () => usePlayback.getState().set({ fit: f }),
      })),
    });
  const speedSheet = () =>
    openSheet({
      title: 'Playback speed',
      options: SPEEDS.map((r) => ({ label: r === 1 ? 'Normal' : `${r}x`, selected: r === usePlayback.getState().rate, onSelect: () => cmd.setRate(r) })),
    });
  const qualitySheet = () =>
    openSheet({
      title: 'Quality',
      options: [
        { label: 'Auto', detail: 'Adapts to your connection', selected: usePlayback.getState().qualityIndex < 0, onSelect: () => cmd.setQuality(-1) },
        ...qualities.map((q, i) => ({ label: q.label, selected: i === usePlayback.getState().qualityIndex, onSelect: () => cmd.setQuality(i) })),
      ],
    });
  const stepRate = (dir: 1 | -1) => {
    const i = SPEEDS.indexOf(usePlayback.getState().rate);
    const r = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? SPEEDS.indexOf(1) : i) + dir))];
    cmd.setRate(r);
    showToast(r === 1 ? 'Normal speed' : `${r}x speed`);
  };
  const cycleCaptions = () => {
    if (!subtitleTracks.length) return showToast('No subtitles in this stream');
    const cur = usePlayback.getState().subtitleIndex;
    const nextIdx = cur + 1 >= subtitleTracks.length ? -1 : cur + 1;
    cmd.setSubtitle(nextIdx);
    showToast(nextIdx < 0 ? 'Subtitles off' : `Subtitles: ${subtitleTracks[nextIdx].label}`);
  };
  const optionsSheet = () =>
    openSheet({
      title: ch ? ch.name : item.kind === 'vod' ? item.title : 'Options',
      options: [
        ...(audioTracks.length > 1 ? [{ label: 'Audio track', icon: 'volume-high', onSelect: audioSheet }] : []),
        ...(subtitleTracks.length ? [{ label: 'Subtitles', icon: 'subtitles-outline', onSelect: subsSheet }] : []),
        { label: 'Aspect ratio', icon: 'aspect-ratio', detail: FIT_LABEL[fit], onSelect: fitSheet },
        ...(!live && caps.speed ? [{ label: 'Playback speed', icon: 'speedometer', detail: rate === 1 ? 'Normal' : `${rate}x`, onSelect: speedSheet }] : []),
        ...(caps.quality ? [{ label: 'Quality', icon: 'high-definition-box', onSelect: qualitySheet }] : []),
        ...(caps.pip ? [{ label: 'Picture in Picture', icon: 'picture-in-picture-bottom-right', onSelect: () => cmd.togglePip() }] : []),
        ...(ch && pid
          ? [{ label: isFav ? 'Remove from favorites' : 'Add to favorites', icon: 'star-outline', onSelect: () => toggleFavorite(pid, ch.id) }]
          : []),
        { label: 'Reload stream', icon: 'refresh', onSelect: retry },
      ],
    });

  const runControl = (id: string) => {
    poke();
    switch (id) {
      case 'list':
        return setListOpen(true);
      case 'guide':
        // the channel keeps playing in the guide's preview (started from Home, the guide isn't underneath)
        useUI.getState().setScreen('guide');
        return setFullscreen(false);
      case 'fav':
        if (ch && pid) {
          toggleFavorite(pid, ch.id);
          showToast(isFav ? 'Removed from favorites' : 'Added to favorites');
        }
        return;
      case 'restart':
        return ch && program && playCatchup(ch.id, program);
      case 'golive':
        return ch && playChannel(ch.id, { fullscreen: true });
      case 'playpause':
        return togglePlay();
      case 'rw':
        return cmd.seekBy(-10);
      case 'ff':
        return cmd.seekBy(10);
      case 'audio':
        return audioSheet();
      case 'subs':
        return subsSheet();
      case 'fit':
        return usePlayback.getState().set({ fit: FIT_NEXT[fit] });
      case 'speed':
        return speedSheet();
      case 'quality':
        return qualitySheet();
      case 'mute':
        return cmd.setMuted(!muted);
      case 'pip':
        return cmd.togglePip();
      case 'fullscreen':
        return cmd.toggleFullscreen();
    }
  };

  const onDigit = (d: number) => {
    if (!digits && d === 0) {
      recall();
      return;
    }
    const nextDigits = (digits + d).slice(-4);
    setDigits(nextDigits);
    if (digitTimer.current) clearTimeout(digitTimer.current);
    digitTimer.current = setTimeout(() => {
      setDigits('');
      const n = Number(nextDigits);
      const target = useLibrary.getState().channels.find((c) => c.num === n);
      if (target) playChannel(target.id, { groupId: zapList.includes(target.id) ? groupId : ALL });
      else showToast(`No channel ${n}`);
    }, 1300);
  };

  const onKey = (e: KeyEvt): boolean | void => {
    if (listOpen) return false; // channel list panel handles its own keys
    if (e.key === 'digit' && e.digit !== undefined) return live ? onDigit(e.digit) : undefined;
    if (status === 'error') {
      if (e.key === 'select') return retry();
      if (e.key === 'back') return exit();
      if (live && (e.key === 'up' || e.key === 'chup')) return zap(-1);
      if (live && (e.key === 'down' || e.key === 'chdown')) return zap(1);
      return;
    }
    // standard player shortcuts (web keyboard / remotes with dedicated keys)
    if (e.key === 'mute') return cmd.setMuted(!usePlayback.getState().muted);
    if (e.key === 'volup' || e.key === 'voldown') {
      if (!caps.volume) return;
      const pb = usePlayback.getState();
      poke();
      return cmd.setVolume((pb.muted ? 0 : pb.volume) + (e.key === 'volup' ? 0.1 : -0.1));
    }
    if (e.key === 'fullscreen') return cmd.toggleFullscreen();
    if (e.key === 'pip') return cmd.togglePip();
    if (e.key === 'captions') return cycleCaptions();
    if (e.key === 'faster' || e.key === 'slower') return live ? undefined : stepRate(e.key === 'faster' ? 1 : -1);
    if (e.key === 'menu' || (e.key === 'select' && e.long)) return optionsSheet();
    if (e.key === 'playpause') return togglePlay();
    if (e.key === 'info') return visible ? setVisible(false) : poke();
    if (e.key === 'back') return visible && status !== 'paused' ? setVisible(false) : exit();

    if (live) {
      switch (e.key) {
        case 'up':
        case 'chup':
          return zap(-1);
        case 'down':
        case 'chdown':
          return zap(1);
        case 'left':
          if (visible && ctrl > 0) {
            poke();
            return setCtrl(ctrl - 1);
          }
          return setListOpen(true);
        case 'right':
          if (!visible) return poke();
          poke();
          return setCtrl(Math.min(controls.length - 1, ctrl + 1));
        case 'select':
          if (!visible) return poke();
          return runControl(controls[ctrl]?.id);
        default:
          return;
      }
    }
    // VOD / catch-up
    const step = e.repeat > 6 ? 60 : e.repeat > 2 ? 30 : 10;
    switch (e.key) {
      case 'left':
      case 'right':
        if (visible && row === 'controls') {
          poke();
          return setCtrl(Math.max(0, Math.min(controls.length - 1, ctrl + (e.key === 'left' ? -1 : 1))));
        }
        cmd.seekBy(e.key === 'left' ? -step : step);
        return poke();
      case 'rw':
      case 'ff':
        // 10 s per press like Fire TV / Alexa / YouTube (J, L); holding accelerates
        cmd.seekBy(e.key === 'rw' ? -step : step);
        return poke();
      case 'up':
        setRow('seek');
        return poke();
      case 'down':
        if (visible) setRow('controls');
        return poke();
      case 'select':
        if (visible && row === 'controls') return runControl(controls[ctrl]?.id);
        togglePlay();
        return poke();
      default:
        return;
    }
  };

  useKeys(onKey, !sheetOpen, Layer.player);

  // ---- layout ----
  const title = item.kind === 'vod' ? item.title : program?.title || ch?.name || '';
  const subtitle = item.kind === 'vod' ? item.subtitle : ch ? `${ch.num}  ${ch.name}` : '';
  const liveProgress = live && program ? (now - program.start) / (program.end - program.start) : 0;
  const seekDuration = duration || (item.kind === 'catchup' ? (item.program.end - item.program.start) / 1000 : 0);

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable focusable={false} style={StyleSheet.absoluteFill} onPress={() => (visible ? setVisible(false) : poke())} />
      <PlayerGestures controlsVisible={visible} seekable={!live} onTap={() => (visible ? setVisible(false) : poke())} onSwipeDown={exit} onActivity={poke} />

      {status === 'loading' ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator size="large" color={colors.onVideo} />
        </View>
      ) : null}

      {status === 'error' ? (
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.videoScrim }]}>
          <Icon name="television-off" size={k(38)} color={colors.textDim} />
          <Text style={{ color: colors.text, fontSize: k(17), fontWeight: '700', marginTop: k(10) }}>Can't play this stream</Text>
          <Text style={{ color: colors.textDim, fontSize: k(12), marginTop: k(6), maxWidth: k(420), textAlign: 'center' }} numberOfLines={3}>
            {error}
          </Text>
          <View style={{ flexDirection: 'row', gap: k(10), marginTop: k(16) }}>
            <Focusable focused onPress={retry} style={pill(k)} focusStyle={{ backgroundColor: colors.focus }}>
              {({ focused }) => <Text style={{ color: focused ? colors.focusText : colors.text, fontWeight: '700', fontSize: k(12.5) }}>Retry</Text>}
            </Focusable>
            <Pressable focusable={false} onPress={exit} style={pill(k)}>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: k(12.5) }}>Back</Text>
            </Pressable>
          </View>
          {live ? <Text style={{ color: colors.muted, fontSize: k(11), marginTop: k(14) }}>Use ▲ ▼ to change channel</Text> : null}
        </View>
      ) : null}

      {visible && status !== 'error' && !listOpen ? (
        <>
          {/* top bar */}
          <LinearGradient colors={['rgba(0,0,0,0.75)', 'transparent']} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: k(110) }} pointerEvents="none" />
          <View style={{ position: 'absolute', left: k(18) + edgeX, right: k(18) + edgeX, top: k(14) + Math.max(ins.top, safe.y), flexDirection: 'row', alignItems: 'center' }}>
            <Pressable focusable={false} onPress={exit} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back" style={{ marginRight: k(10), width: tv ? k(42) : 52, height: tv ? k(42) : 52, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.glass }}>
              <Icon name="arrow-left" size={k(28)} color={colors.onVideo} />
            </Pressable>
            <View style={{ flex: 1 }} />
            <Text style={{ color: colors.onVideo, fontSize: k(16), fontWeight: '700', fontFamily: fonts.regular, fontVariant: ['tabular-nums'] }}>{formatClock(now, prefs.clock24)}</Text>
          </View>

          {/* center transport for touch */}
          {!tv || item.kind !== 'live' ? (
            <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: k(56) }]}>
              {live ? (
                <>
                  <RoundBtn icon="chevron-up" k={k} onPress={() => zap(-1)} />
                  <RoundBtn icon="chevron-down" k={k} onPress={() => zap(1)} />
                </>
              ) : (
                <>
                  <RoundBtn icon="rewind-10" k={k} onPress={() => (cmd.seekBy(-10), poke())} />
                  <RoundBtn icon={status === 'paused' ? 'play' : 'pause'} k={k} big onPress={() => (togglePlay(), poke())} />
                  <RoundBtn icon="fast-forward-10" k={k} onPress={() => (cmd.seekBy(10), poke())} />
                </>
              )}
            </View>
          ) : null}

          {/* bottom info panel */}
          <LinearGradient colors={['transparent', 'rgba(0,0,0,0.88)']} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: k(300) }} pointerEvents="none" />
          <View style={{ position: 'absolute', left: k(28) + edgeX, right: k(28) + edgeX, bottom: k(22) + edgeY }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: k(6) }}>
              {ch ? <Logo uri={ch.logo} name={ch.name} size={k(22)} style={{ marginRight: k(10) }} /> : null}
              <Text numberOfLines={1} style={{ color: colors.textDim, fontSize: k(12.5), fontWeight: '600', flexShrink: 1 }}>
                {subtitle}
              </Text>
              <View style={{ width: k(10) }} />
              {live ? <Badge label="LIVE" tone="live" /> : item.kind === 'catchup' ? <Badge label="CATCH-UP" tone="catchup" icon="history" /> : null}
            </View>
            <Text numberOfLines={1} style={{ color: colors.onVideo, fontSize: k(22), fontWeight: '800', letterSpacing: -0.3, fontFamily: fonts.regular }}>
              {title}
            </Text>

            {live ? (
              <>
                {program ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: k(8) }}>
                    <Text style={{ color: colors.textDim, fontSize: k(14), width: k(58), fontVariant: ['tabular-nums'] }}>{formatClock(program.start, prefs.clock24)}</Text>
                    <View style={{ flex: 1, height: k(6), backgroundColor: colors.glass, borderRadius: radius.pill }}>
                      <View style={{ width: `${Math.min(100, Math.max(0, liveProgress * 100))}%`, height: '100%', backgroundColor: colors.accent, borderRadius: 2 }} />
                    </View>
                    <Text style={{ color: colors.textDim, fontSize: k(14), width: k(58), textAlign: 'right', fontVariant: ['tabular-nums'] }}>{formatClock(program.end, prefs.clock24)}</Text>
                  </View>
                ) : null}
                {next ? (
                  <Text numberOfLines={1} style={{ color: colors.textDim, fontSize: k(11.5), marginTop: k(6) }}>
                    <Text style={{ fontWeight: '700', color: colors.text }}>Next </Text>
                    {formatRange(next.start, next.end, prefs.clock24)} · {next.title}
                  </Text>
                ) : null}
              </>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: k(12) }}>
                <Text style={{ color: colors.text, fontSize: k(14), width: k(72) }}>{formatDuration(position)}</Text>
                <SeekBar position={position} duration={seekDuration} active={row === 'seek' && visible} onSeek={(sec) => (cmd.seekTo(sec), poke())} />
                <Text style={{ color: colors.textDim, fontSize: k(14), width: k(72), textAlign: 'right' }}>{formatDuration(seekDuration)}</Text>
              </View>
            )}

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: k(10), marginTop: k(16) }}>
              {controls.map((c, i) => {
                const pill = (
                  <Focusable
                    key={c.id}
                    focused={row === 'controls' && i === ctrl}
                    onPress={() => {
                      setCtrl(i);
                      runControl(c.id);
                    }}
                    style={{ flexDirection: 'row', alignItems: 'center', height: tv ? Math.max(k(40), TOUCH_MIN) : 48, paddingHorizontal: k(16), borderRadius: radius.pill, backgroundColor: colors.glass }}
                    hoverStyle={{ backgroundColor: 'rgba(255,255,255,0.24)' }}
                    focusStyle={{ backgroundColor: colors.focus, transform: [{ scale: 1.05 }] }}
                  >
                    {({ focused }) => (
                      <>
                        <Icon name={c.icon} size={k(20)} color={focused ? colors.focusText : c.active ? colors.star : colors.onVideo} />
                        <Text
                          style={[
                            { color: focused ? colors.focusText : colors.onVideo, fontSize: k(15), fontWeight: '700', marginLeft: k(8), fontVariant: ['tabular-nums'] },
                            // fixed width so the slider beside it doesn't shift while the level changes
                            c.id === 'mute' && caps.volume ? { minWidth: k(44), textAlign: 'right' } : null,
                          ]}
                        >
                          {c.id === 'mute' && caps.volume ? (muted ? 'Off' : `${Math.round(volume * 100)}%`) : c.label}
                        </Text>
                      </>
                    )}
                  </Focusable>
                );
                if (c.id !== 'mute' || !caps.volume) return pill;
                // Mute button + volume slider side by side: the slider isn't inside the button, so
                // dragging it never toggles mute
                return (
                  <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center', gap: k(4) }}>
                    {pill}
                    <View style={{ height: tv ? Math.max(k(40), TOUCH_MIN) : 48, justifyContent: 'center', paddingLeft: k(6), paddingRight: k(16), borderRadius: radius.pill, backgroundColor: colors.glass }}>
                      <VolumeSlider width={k(110)} focused={false} />
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        </>
      ) : null}

      {status === 'paused' && !visible ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <Icon name="pause-circle-outline" size={k(56)} color={colors.onVideo} />
        </View>
      ) : null}

      {digits ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: k(24) + safe.y, right: k(28) + edgeX, backgroundColor: colors.videoScrim, borderRadius: k(radius.lg), paddingHorizontal: k(20), paddingVertical: k(8) }}>
          <Text style={{ color: colors.onVideo, fontSize: k(30), fontWeight: '800', letterSpacing: 2, fontVariant: ['tabular-nums'] }}>{digits}</Text>
        </View>
      ) : null}

      <PlayerNotices
        controlsVisible={visible && !listOpen}
        upNext={upNext}
        onPlayNext={() => {
          const n = upNext;
          setUpNext(null);
          if (n) playNextItem(n);
        }}
        onCancelNext={() => {
          setUpNext(null);
          stop();
        }}
      />

      {listOpen && live ? (
        <ChannelListPanel
          channelIds={zapList}
          currentId={ch?.id}
          onPick={(id) => {
            playChannel(id);
            setListOpen(false);
            poke();
          }}
          onClose={() => setListOpen(false)}
        />
      ) : null}
    </View>
  );
}

const pill = (k: (n: number) => number) => ({
  height: k(34),
  paddingHorizontal: k(22),
  borderRadius: k(17),
  backgroundColor: colors.glass,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
});

function RoundBtn({ icon, onPress, k, big }: { icon: string; onPress: () => void; k: (n: number) => number; big?: boolean }) {
  const size = big ? k(84) : k(62);
  return (
    <Pressable
      focusable={false}
      onPress={onPress}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' }}
    >
      <Icon name={icon} size={size * 0.52} color={colors.onVideo} />
    </Pressable>
  );
}

/** Mini channel list over the left side of the picture. */
function ChannelListPanel({ channelIds, currentId, onPick, onClose }: { channelIds: string[]; currentId?: string; onPick: (id: string) => void; onClose: () => void }) {
  const { mode, safe, player: k } = useLayout();
  const ins = useSafeAreaInsets();
  const byId = useLibrary((st) => st.byId);
  const epg = useLibrary((st) => st.epg);
  const h24 = useSettings((st) => st.prefs.clock24);
  const now = useNow(30000);
  const [index, setIndex] = useState(() => Math.max(0, channelIds.indexOf(currentId ?? '')));
  const ref = useRef<FlatList<string>>(null);
  const itemH = k(50);

  useEffect(() => {
    ref.current?.scrollToOffset({ offset: Math.max(0, (index - 3) * itemH), animated: true });
  }, [index, itemH]);

  useKeys(
    (e) => {
      const n = channelIds.length;
      switch (e.key) {
        case 'up':
          return setIndex((i) => Math.max(0, i - 1));
        case 'down':
          return setIndex((i) => Math.min(n - 1, i + 1));
        case 'chup':
          return setIndex((i) => Math.max(0, i - 8));
        case 'chdown':
          return setIndex((i) => Math.min(n - 1, i + 8));
        case 'select':
          return onPick(channelIds[index]);
        case 'back':
        case 'right':
        case 'left':
          return onClose();
        default:
          return;
      }
    },
    true,
    Layer.player + 1
  );

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable focusable={false} style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: k(340) + Math.max(ins.left, safe.x), paddingLeft: Math.max(ins.left, safe.x), backgroundColor: 'rgba(14,16,21,0.95)', borderRightWidth: 1, borderColor: colors.border, paddingTop: k(16) + Math.max(ins.top, safe.y) }}>
        <FlatList
          ref={ref}
          data={channelIds}
          keyExtractor={(id) => id}
          getItemLayout={(_d, i) => ({ length: itemH, offset: itemH * i, index: i })}
          initialScrollIndex={Math.max(0, index - 3)}
          renderItem={({ item: id, index: i }) => {
            const c = byId[id];
            if (!c) return <View style={{ height: itemH }} />;
            const p = programAt(epg[id], now);
            return (
              <Focusable
                focused={i === index}
                alwaysShowFocus
                onPress={() => onPick(id)}
                style={{ height: itemH - k(4), marginHorizontal: k(10), marginVertical: k(2), borderRadius: k(radius.md), flexDirection: 'row', alignItems: 'center', paddingHorizontal: k(10), backgroundColor: id === currentId ? colors.accentSoft : 'transparent' }}
                focusStyle={{ backgroundColor: colors.focus }}
              >
                {({ focused }) => (
                  <>
                    <Text style={{ width: k(32), color: focused ? colors.focusDim : colors.muted, fontSize: k(11.5), fontWeight: '700', fontVariant: ['tabular-nums'] }}>{c.num}</Text>
                    <Logo uri={c.logo} name={c.name} size={k(22)} />
                    <View style={{ flex: 1, marginLeft: k(10) }}>
                      <Text numberOfLines={1} style={{ color: focused ? colors.focusText : id === currentId ? colors.accent : colors.text, fontSize: k(12.5), fontWeight: '700' }}>
                        {c.name}
                      </Text>
                      <Text numberOfLines={1} style={{ color: focused ? '#3A4252' : colors.muted, fontSize: k(11), marginTop: k(1) }}>
                        {p ? `${formatClock(p.start, h24)}  ${p.title}` : 'No information'}
                      </Text>
                    </View>
                  </>
                )}
              </Focusable>
            );
          }}
        />
      </View>
    </View>
  );
}
