import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoAirPlayButton } from 'expo-video';
import { colors, useLayout } from '../theme';
import { Layer, useKeys } from '../input/keys';
import { Focusable } from '../components/Focusable';
import { Icon } from '../components/Icon';
import { usePlayback, type Fit } from './playback';
import { formatDuration } from '../utils/format';
import type { PlayItem } from '../types';

type NextItem = NonNullable<Extract<PlayItem, { kind: 'vod' }>['next']>;

/** Phones and tablets: tap targets never shrink below Apple's/Google's 44 pt minimum, whatever the scale. */
export const TOUCH_MIN = !Platform.isTV && (Platform.OS === 'ios' || Platform.OS === 'android') ? 44 : 0;

const useK = () => useLayout().player;

// ---------------------------------------------------------------------------------------------
// Gestures: the touch/mouse layer under the player controls
// ---------------------------------------------------------------------------------------------

interface GestureProps {
  /** overlay visible (web: hides the mouse cursor while it isn't) */
  controlsVisible: boolean;
  seekable: boolean;
  onTap: () => void;
  onSwipeDown: () => void;
  /** web: the mouse moved — show the controls (and cursor) again */
  onActivity?: () => void;
}

const DOUBLE_TAP_MS = 300;

/**
 * Industry-standard player gestures: tap toggles controls, double-tap left/right third seeks
 * ∓10 s (YouTube/Netflix), double-click toggles fullscreen (web), swipe down closes the player
 * (iOS), pinch zooms to fill / back to fit.
 */
export function PlayerGestures({ controlsVisible, seekable, onTap, onSwipeDown, onActivity }: GestureProps) {
  const k = useK();
  const width = useRef(1);
  const lastTap = useRef({ t: 0, side: '' });
  const pinchStart = useRef(0);
  const pinchEnd = useRef(0);
  const [ripple, setRipple] = useState<{ side: 'left' | 'right'; n: number } | null>(null);
  const rippleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ seekable, onTap, onSwipeDown, onActivity });
  live.current = { seekable, onTap, onSwipeDown, onActivity };

  // Web: moving the mouse brings back the cursor and controls; both hide again after the overlay's
  // idle timeout. Browsers also send "mousemove" when content changes under a still pointer, so
  // only real movement counts.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    let last = { x: -1, y: -1, t: 0 };
    const onMove = (e: MouseEvent) => {
      if (e.screenX === last.x && e.screenY === last.y) return;
      const now = Date.now();
      const throttled = now - last.t < 250;
      last = { x: e.screenX, y: e.screenY, t: throttled ? last.t : now };
      if (!throttled) live.current.onActivity?.();
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  const showRipple = (side: 'left' | 'right') => {
    setRipple((r) => ({ side, n: r && r.side === side ? r.n + 1 : 1 }));
    if (rippleTimer.current) clearTimeout(rippleTimer.current);
    rippleTimer.current = setTimeout(() => setRipple(null), 700);
  };

  const pan = useMemo(() => {
    const distance = (touches: readonly { pageX: number; pageY: number }[]) =>
      touches.length < 2 ? 0 : Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        pinchStart.current = distance(e.nativeEvent.touches);
        pinchEnd.current = pinchStart.current;
      },
      onPanResponderMove: (e) => {
        const d = distance(e.nativeEvent.touches);
        if (d) {
          if (!pinchStart.current) pinchStart.current = d;
          pinchEnd.current = d;
        }
      },
      onPanResponderRelease: (e, g) => {
        const { seekable: canSeek, onTap: tap, onSwipeDown: swipeDown } = live.current;
        // pinch
        if (pinchStart.current && pinchEnd.current) {
          const ratio = pinchEnd.current / pinchStart.current;
          const fit: Fit | null = ratio > 1.15 ? 'cover' : ratio < 0.87 ? 'contain' : null;
          pinchStart.current = 0;
          if (fit) return usePlayback.getState().set({ fit });
        }
        // swipe down to close
        if (g.dy > 110 && Math.abs(g.dx) < 80) return swipeDown();
        if (Math.abs(g.dx) > 12 || Math.abs(g.dy) > 12) return;
        // tap / double tap
        const now = Date.now();
        const x = e.nativeEvent.locationX / width.current;
        const side = x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : 'center';
        const isDouble = now - lastTap.current.t < DOUBLE_TAP_MS;
        lastTap.current = { t: isDouble ? 0 : now, side };
        if (isDouble) {
          if (Platform.OS === 'web') return usePlayback.getState().cmd.toggleFullscreen();
          if (canSeek && side !== 'center') {
            usePlayback.getState().cmd.seekBy(side === 'left' ? -10 : 10);
            return showRipple(side);
          }
        }
        tap();
      },
    });
  }, []);

  return (
    <View
      style={[StyleSheet.absoluteFill, Platform.OS === 'web' && !controlsVisible ? ({ cursor: 'none' } as object) : null]}
      onLayout={(e) => (width.current = e.nativeEvent.layout.width || 1)}
      {...pan.panHandlers}
    >
      {ripple ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            width: '34%',
            [ripple.side]: 0,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(255,255,255,0.08)',
          }}
        >
          <Icon name={ripple.side === 'left' ? 'rewind' : 'fast-forward'} size={k(28)} color="#fff" />
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: k(13), marginTop: k(4) }}>{ripple.n * 10} seconds</Text>
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Seek bar
// ---------------------------------------------------------------------------------------------

interface SeekBarProps {
  position: number;
  duration: number;
  /** the seek row has D-pad focus: thicker track and a knob */
  active: boolean;
  onSeek: (sec: number) => void;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Standard pointer seek bar: click or tap anywhere to jump there, drag to scrub (the time
 * follows the pointer and the seek happens on release), and on web a time preview follows the
 * mouse. The children ignore pointer events so every coordinate is relative to the bar itself.
 */
export function SeekBar({ position, duration, active, onSeek }: SeekBarProps) {
  const k = useK();
  const width = useRef(1);
  const left = useRef(0);
  const scrubRef = useRef<number | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const update = (f: number | null) => {
    scrubRef.current = f;
    setScrub(f);
  };

  const played = scrub ?? (duration ? clamp01(position / duration) : 0);
  const expanded = active || scrub !== null || hover !== null;
  const tip = scrub ?? hover;
  const web = Platform.OS === 'web';

  return (
    <View
      style={[{ flex: 1, height: Math.max(k(28), TOUCH_MIN), justifyContent: 'center' }, web ? ({ cursor: duration ? 'pointer' : 'default' } as object) : null]}
      onLayout={(e) => (width.current = e.nativeEvent.layout.width || 1)}
      onStartShouldSetResponder={() => duration > 0}
      onMoveShouldSetResponder={() => duration > 0}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        const { pageX, locationX } = e.nativeEvent;
        left.current = pageX - locationX;
        update(clamp01(locationX / width.current));
      }}
      onResponderMove={(e) => update(clamp01((e.nativeEvent.pageX - left.current) / width.current))}
      onResponderRelease={() => {
        if (scrubRef.current !== null) onSeek(scrubRef.current * duration);
        update(null);
      }}
      onResponderTerminate={() => update(null)}
      {...(web
        ? {
            onMouseMove: (e: { currentTarget: unknown; nativeEvent: { clientX: number } }) => {
              if (!duration) return;
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setHover(clamp01((e.nativeEvent.clientX - r.left) / (r.width || 1)));
            },
            onMouseLeave: () => setHover(null),
          }
        : null)}
    >
      <View pointerEvents="none" style={{ height: expanded ? k(10) : k(6), backgroundColor: 'rgba(255,255,255,0.22)', borderRadius: 999, overflow: 'hidden' }}>
        {hover !== null && scrub === null ? (
          <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${hover * 100}%`, backgroundColor: 'rgba(255,255,255,0.18)' }} />
        ) : null}
        <View style={{ width: `${played * 100}%`, height: '100%', backgroundColor: colors.accent }} />
      </View>
      {duration && expanded ? (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', left: played * width.current - k(11), width: k(22), height: k(22), borderRadius: k(11), backgroundColor: '#fff' }}
        />
      ) : null}
      {duration && tip !== null ? (
        <View pointerEvents="none" style={{ position: 'absolute', bottom: k(32), left: Math.min(width.current - k(88), Math.max(0, tip * width.current - k(44))), width: k(88), alignItems: 'center' }}>
          <View style={{ backgroundColor: 'rgba(0,0,0,0.85)', borderRadius: k(7), paddingHorizontal: k(11), paddingVertical: k(5) }}>
            <Text style={{ color: '#fff', fontSize: k(17), fontWeight: '800', fontVariant: ['tabular-nums'] }}>{formatDuration(tip * duration)}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Skip feedback and Next episode
// ---------------------------------------------------------------------------------------------

/** Running total while skipping with the remote or keyboard: "⏩ +30 s". */
export function SeekHint({ seconds }: { seconds: number }) {
  const k = useK();
  const back = seconds < 0;
  const abs = Math.abs(seconds);
  const label = abs >= 60 && abs % 60 === 0 ? `${abs / 60} min` : abs >= 60 ? `${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')} min` : `${abs} s`;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', paddingBottom: k(170) }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.videoScrim, borderRadius: 999, paddingHorizontal: k(18), paddingVertical: k(9) }}>
        <Icon name={back ? 'rewind' : 'fast-forward'} size={k(24)} color={colors.onVideo} />
        <Text style={{ color: colors.onVideo, fontSize: k(18), fontWeight: '800', marginLeft: k(10), fontVariant: ['tabular-nums'] }}>
          {back ? '−' : '+'}
          {label}
        </Text>
      </View>
    </View>
  );
}

/**
 * "Next episode" during the credits. Focused (white) whenever the controls are hidden, because OK
 * then plays it; with the controls up it sits above them and Up reaches it.
 */
export function NextEpisodeButton({ next, focused, raised, onPress }: { next: NextItem; focused: boolean; raised: boolean; onPress: () => void }) {
  const k = useK();
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', right: k(28), bottom: raised ? k(250) : k(40) }}>
      <Focusable
        focused={focused}
        alwaysShowFocus
        onPress={onPress}
        accessibilityLabel="Next episode"
        style={{ flexDirection: 'row', alignItems: 'center', minHeight: Math.max(k(52), TOUCH_MIN), paddingHorizontal: k(18), paddingVertical: k(8), borderRadius: k(12), backgroundColor: colors.videoScrim, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' }}
        hoverStyle={{ backgroundColor: 'rgba(255,255,255,0.2)' }}
        focusStyle={{ backgroundColor: colors.focus, borderColor: colors.focus, transform: [{ scale: 1.04 }] }}
      >
        {({ focused: f }) => (
          <>
            <Icon name="skip-next" size={k(26)} color={f ? colors.focusText : colors.onVideo} />
            <View style={{ marginLeft: k(10) }}>
              <Text style={{ color: f ? colors.focusText : colors.onVideo, fontSize: k(16), fontWeight: '800' }}>Next episode</Text>
              {next.subtitle ? (
                <Text numberOfLines={1} style={{ color: f ? colors.focusDim : colors.textDim, fontSize: k(12), marginTop: k(1), maxWidth: k(260) }}>
                  {next.subtitle}
                </Text>
              ) : null}
            </View>
          </>
        )}
      </Focusable>
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------------------------

/** Volume slider next to the Mute button (web): click or drag to set the level; raising it unmutes. */
export function VolumeSlider({ width, focused }: { width: number; focused: boolean }) {
  const k = useK();
  const volume = usePlayback((st) => st.volume);
  const muted = usePlayback((st) => st.muted);
  const left = useRef(0);
  const level = muted ? 0 : volume;
  const setAt = (x: number) => usePlayback.getState().cmd.setVolume(clamp01(x / width));
  const fg = focused ? colors.focusText : colors.onVideo;
  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel="Volume"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(level * 100) }}
      style={[{ width, height: k(28), justifyContent: 'center', marginLeft: k(10) }, Platform.OS === 'web' ? ({ cursor: 'pointer' } as object) : null]}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        const { pageX, locationX } = e.nativeEvent;
        left.current = pageX - locationX;
        setAt(locationX);
      }}
      onResponderMove={(e) => setAt(e.nativeEvent.pageX - left.current)}
    >
      <View pointerEvents="none" style={{ height: k(5), borderRadius: 999, backgroundColor: focused ? colors.textDim : 'rgba(255,255,255,0.28)', overflow: 'hidden' }}>
        <View style={{ width: `${level * 100}%`, height: '100%', backgroundColor: fg }} />
      </View>
      <View pointerEvents="none" style={{ position: 'absolute', left: level * width - k(7), width: k(14), height: k(14), borderRadius: k(7), backgroundColor: fg }} />
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Notices: reconnecting, tap to unmute, AirPlay, up next
// ---------------------------------------------------------------------------------------------

interface NoticeProps {
  controlsVisible: boolean;
  upNext: NextItem | null;
  onPlayNext: () => void;
  onCancelNext: () => void;
}

export function PlayerNotices({ controlsVisible, upNext, onPlayNext, onCancelNext }: NoticeProps) {
  const k = useK();
  const reconnect = usePlayback((s) => s.reconnect);
  const muted = usePlayback((s) => s.muted);
  const engine = usePlayback((s) => s.engine);
  const status = usePlayback((s) => s.status);
  const airplay = usePlayback((s) => s.caps.airplay);

  return (
    <>
      {reconnect > 0 ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <View style={{ marginTop: k(90), backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 999, paddingHorizontal: k(14), paddingVertical: k(6) }}>
            <Text style={{ color: '#fff', fontSize: k(12), fontWeight: '600' }}>Reconnecting… ({reconnect}/3)</Text>
          </View>
        </View>
      ) : null}

      {engine === 'web' && muted && status === 'playing' ? (
        <View pointerEvents="box-none" style={{ position: 'absolute', top: k(56), left: 0, right: 0, alignItems: 'center' }}>
          <Pressable
            focusable={false}
            onPress={() => usePlayback.getState().cmd.setMuted(false)}
            accessibilityLabel="Unmute"
            style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.focus, borderRadius: 999, paddingHorizontal: k(14), paddingVertical: k(7) }}
          >
            <Icon name="volume-off" size={k(16)} color={colors.focusText} />
            <Text style={{ color: colors.focusText, fontWeight: '700', fontSize: k(12.5), marginLeft: k(6) }}>Tap to unmute</Text>
          </Pressable>
        </View>
      ) : null}

      {airplay && controlsVisible ? (
        <View style={{ position: 'absolute', top: k(14), right: k(84), width: k(42), height: k(42), alignItems: 'center', justifyContent: 'center' }}>
          <VideoAirPlayButton style={{ width: k(34), height: k(34) }} tint="#ffffff" activeTint={colors.accent} prioritizeVideoDevices />
        </View>
      ) : null}

      {upNext ? <UpNextCard next={upNext} raised={controlsVisible} onPlay={onPlayNext} onCancel={onCancelNext} /> : null}
    </>
  );
}

const UP_NEXT_SECONDS = 10;

/** Netflix-style "Up next" with a countdown; OK plays now, Back cancels. */
function UpNextCard({ next, raised, onPlay, onCancel }: { next: NextItem; raised: boolean; onPlay: () => void; onCancel: () => void }) {
  const k = useK();
  const [left, setLeft] = useState(UP_NEXT_SECONDS);
  const [btn, setBtn] = useState(0);

  useEffect(() => {
    if (left <= 0) {
      onPlay();
      return;
    }
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left, onPlay]);

  useKeys(
    (e) => {
      if (e.key === 'left') return setBtn(0);
      if (e.key === 'right') return setBtn(1);
      if (e.key === 'select') return btn === 0 ? onPlay() : onCancel();
      if (e.key === 'back') return onCancel();
      return;
    },
    true,
    Layer.player + 2
  );

  return (
    <View style={{ position: 'absolute', right: k(28), bottom: raised ? k(200) : k(28), width: k(300), backgroundColor: 'rgba(12,14,19,0.94)', borderRadius: k(12), padding: k(14), borderWidth: 1, borderColor: colors.border }}>
      <Text style={{ color: colors.textDim, fontSize: k(11), fontWeight: '800', letterSpacing: 1 }}>UP NEXT · {left}s</Text>
      <Text numberOfLines={1} style={{ color: colors.text, fontSize: k(15), fontWeight: '800', marginTop: k(6) }}>
        {next.subtitle ?? next.title}
      </Text>
      <Text numberOfLines={1} style={{ color: colors.muted, fontSize: k(11.5), marginTop: k(2) }}>
        {next.title}
      </Text>
      <View style={{ height: k(3), backgroundColor: colors.surface3, borderRadius: 2, marginTop: k(10) }}>
        <View style={{ height: '100%', width: `${((UP_NEXT_SECONDS - left) / UP_NEXT_SECONDS) * 100}%`, backgroundColor: colors.accent, borderRadius: 2 }} />
      </View>
      <View style={{ flexDirection: 'row', gap: k(8), marginTop: k(12) }}>
        {[
          { label: 'Play now', icon: 'play', run: onPlay },
          { label: 'Cancel', icon: 'close', run: onCancel },
        ].map((b, i) => (
          <Focusable
            key={b.label}
            focused={btn === i}
            onPress={b.run}
            style={{ flexDirection: 'row', alignItems: 'center', height: k(32), paddingHorizontal: k(12), borderRadius: k(16), backgroundColor: 'rgba(255,255,255,0.12)' }}
            focusStyle={{ backgroundColor: colors.focus }}
          >
            {({ focused }) => (
              <>
                <Icon name={b.icon} size={k(15)} color={focused ? colors.focusText : '#fff'} />
                <Text style={{ color: focused ? colors.focusText : '#fff', fontSize: k(12), fontWeight: '700', marginLeft: k(6) }}>{b.label}</Text>
              </>
            )}
          </Focusable>
        ))}
      </View>
    </View>
  );
}
