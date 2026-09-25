import React, { useCallback, useEffect, useRef } from 'react';
import { Text, View } from 'react-native';
import type { Channel, Program } from '../../types';
import { colors, fonts, radius } from '../../theme';
import { Badge } from '../../components/Badge';
import { formatClock, formatDay, formatRange, minutesLabel } from '../../utils/format';
import { useVideoRect } from '../../utils/hooks';
import { Logo } from '../../components/Logo';
import { Icon } from '../../components/Icon';
import { canCatchup } from '../../services/catchup';

interface Props {
  channel?: Channel;
  program?: Program;
  next?: Program;
  now: number;
  h24: boolean;
  height: number;
  s: (n: number) => number;
  showPreview: boolean;
  previewActive: boolean;
}

/**
 * Slim strip above the guide: the focused programme on the left, live preview on the right. Kept
 * short so categories and channels get most of the screen.
 */
export function Hero({ channel, program, next, now, h24, height, s, showPreview, previewActive }: Props) {
  const padX = s(14);
  const padY = s(8);
  const previewH = height - padY * 2;
  const previewW = (previewH * 16) / 9;
  const current = program && program.start <= now && program.end > now;
  const catchup = canCatchup(channel, program, now);
  const progress = current ? (now - program!.start) / (program!.end - program!.start) : 0;

  return (
    <View style={{ height, flexDirection: 'row', alignItems: 'center', paddingHorizontal: padX, paddingVertical: padY }}>
      <View style={{ flex: 1, paddingRight: s(16) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {channel ? <Logo uri={channel.logo} name={channel.name} size={s(18)} /> : null}
          <Text numberOfLines={1} style={{ color: colors.textDim, fontSize: s(12), fontWeight: '600', marginLeft: s(7), flexShrink: 1, fontFamily: fonts.regular }}>
            {channel ? `${channel.num}  ${channel.name}` : ''}
          </Text>
          <View style={{ flex: 1 }} />
          <Text style={{ color: colors.text, fontSize: s(15), fontWeight: '700', fontFamily: fonts.regular, fontVariant: ['tabular-nums'] }}>{formatClock(now, h24)}</Text>
        </View>
        <Text numberOfLines={1} style={{ color: colors.text, fontSize: s(19), fontWeight: '800', letterSpacing: -0.3, lineHeight: s(24), marginTop: s(3), fontFamily: fonts.regular }}>
          {program?.title || (channel ? channel.name : 'No channel selected')}
        </Text>
        {program ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: s(4) }}>
            {current ? <Badge label="LIVE" tone="live" /> : null}
            {catchup ? <Badge label="CATCH-UP" tone="catchup" icon="history" /> : null}
            <Text numberOfLines={1} style={{ color: colors.textDim, fontSize: s(11.5), fontFamily: fonts.regular, flexShrink: 1 }}>
              {formatDay(program.start, now)} · {formatRange(program.start, program.end, h24)} · {minutesLabel(program.end - program.start)}
              {program.category ? ` · ${program.category}` : ''}
            </Text>
            {current ? (
              <View style={{ width: s(90), height: s(3), backgroundColor: colors.surface3, borderRadius: radius.pill, marginLeft: s(10) }}>
                <View style={{ height: '100%', width: `${Math.round(progress * 100)}%`, backgroundColor: colors.accent, borderRadius: radius.pill }} />
              </View>
            ) : null}
          </View>
        ) : channel ? (
          <Text style={{ color: colors.muted, fontSize: s(11.5), marginTop: s(4) }}>No programme information</Text>
        ) : null}
        {program?.desc ? (
          <Text numberOfLines={2} style={{ color: colors.muted, fontSize: s(11.5), lineHeight: s(15.5), marginTop: s(5), fontFamily: fonts.regular }}>
            {next && current ? (
              <Text style={{ color: colors.textDim, fontWeight: '700' }}>
                Next {formatClock(next.start, h24)} {next.title}
                {'  ·  '}
              </Text>
            ) : null}
            {program.desc}
          </Text>
        ) : next && current ? (
          <Text numberOfLines={1} style={{ color: colors.muted, fontSize: s(11.5), marginTop: s(5), fontFamily: fonts.regular }}>
            <Text style={{ color: colors.textDim, fontWeight: '700' }}>Next </Text>
            {formatClock(next.start, h24)} · {next.title}
          </Text>
        ) : null}
      </View>
      {showPreview ? <PreviewSlot width={previewW} height={previewH} active={previewActive} s={s} /> : null}
    </View>
  );
}

/** Reserves space for the preview; the actual video is drawn by the app-level VideoLayer. */
export function PreviewSlot({ width, height, active, s }: { width: number; height: number; active: boolean; s: (n: number) => number }) {
  const ref = useRef<View>(null);
  const setRect = useVideoRect((st) => st.setRect);
  const measure = useCallback(() => {
    ref.current?.measureInWindow((x, y, w, h) => {
      if (w > 0 && h > 0) setRect({ x, y, w, h });
    });
  }, [setRect]);
  useEffect(() => () => setRect(null), [setRect]);
  useEffect(() => {
    const t = setTimeout(measure, 50);
    return () => clearTimeout(t);
  }, [measure, width, height]);

  return (
    <View
      ref={ref}
      onLayout={measure}
      style={{ width, height, borderRadius: s(radius.md), backgroundColor: colors.video, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border }}
    >
      {!active ? (
        <>
          <Icon name="television-play" size={s(22)} color={colors.muted} />
          <Text style={{ color: colors.muted, fontSize: s(10.5), marginTop: s(4), textAlign: 'center', paddingHorizontal: s(8) }}>OK on a channel to preview</Text>
        </>
      ) : null}
    </View>
  );
}
