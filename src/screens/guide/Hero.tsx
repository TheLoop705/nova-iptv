import React, { useCallback, useEffect, useRef } from 'react';
import { Text, View } from 'react-native';
import type { Channel, Program } from '../../types';
import { colors } from '../../theme';
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

/** Top area of the TV guide: programme details on the left, live preview on the right. */
export function Hero({ channel, program, next, now, h24, height, s, showPreview, previewActive }: Props) {
  const pad = s(14);
  const previewH = height - pad * 2;
  const previewW = (previewH * 16) / 9;
  const current = program && program.start <= now && program.end > now;
  const past = program && program.end <= now;
  const catchup = canCatchup(channel, program, now);
  const progress = current ? (now - program!.start) / (program!.end - program!.start) : 0;

  return (
    <View style={{ height, flexDirection: 'row', paddingHorizontal: pad, paddingTop: pad, paddingBottom: pad }}>
      <View style={{ flex: 1, paddingRight: s(18) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: s(8) }}>
          {channel ? <Logo uri={channel.logo} name={channel.name} size={s(20)} /> : null}
          <Text numberOfLines={1} style={{ color: colors.textDim, fontSize: s(12), fontWeight: '600', marginLeft: s(8), flexShrink: 1 }}>
            {channel ? `${channel.num}  ${channel.name}` : ''}
          </Text>
          <View style={{ flex: 1 }} />
          <Text style={{ color: colors.text, fontSize: s(15), fontWeight: '700' }}>{formatClock(now, h24)}</Text>
        </View>
        <Text numberOfLines={2} style={{ color: colors.text, fontSize: s(21), fontWeight: '800', letterSpacing: -0.2, lineHeight: s(26) }}>
          {program?.title || (channel ? channel.name : 'No channel selected')}
        </Text>
        {program ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: s(6), flexWrap: 'wrap' }}>
            {current ? <Badge label="LIVE" color={colors.live} s={s} /> : null}
            {catchup ? <Badge label="CATCH-UP" color={colors.accent} s={s} icon="history" /> : null}
            <Text style={{ color: colors.textDim, fontSize: s(11.5) }}>
              {formatDay(program.start, now)} · {formatRange(program.start, program.end, h24)} · {minutesLabel(program.end - program.start)}
              {program.category ? ` · ${program.category}` : ''}
            </Text>
          </View>
        ) : channel ? (
          <Text style={{ color: colors.muted, fontSize: s(11.5), marginTop: s(6) }}>No programme information</Text>
        ) : null}
        {current ? (
          <View style={{ height: s(3), backgroundColor: colors.surface3, borderRadius: 2, marginTop: s(8), width: '60%' }}>
            <View style={{ height: '100%', width: `${Math.round(progress * 100)}%`, backgroundColor: colors.accent, borderRadius: 2 }} />
          </View>
        ) : null}
        {program?.desc ? (
          <Text numberOfLines={past || !next ? 4 : 3} style={{ color: colors.textDim, fontSize: s(11.5), lineHeight: s(16), marginTop: s(8) }}>
            {program.desc}
          </Text>
        ) : null}
        {next && current ? (
          <Text numberOfLines={1} style={{ color: colors.muted, fontSize: s(11), marginTop: s(6) }}>
            Next · {formatClock(next.start, h24)} {next.title}
          </Text>
        ) : null}
      </View>
      {showPreview ? <PreviewSlot width={previewW} height={previewH} active={previewActive} s={s} /> : null}
    </View>
  );
}

function Badge({ label, color, s, icon }: { label: string; color: string; s: (n: number) => number; icon?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: color, borderRadius: s(3), paddingHorizontal: s(5), paddingVertical: s(1), marginRight: s(8) }}>
      {icon ? <Icon name={icon} size={s(10)} color="#fff" style={{ marginRight: s(3) }} /> : null}
      <Text style={{ color: '#fff', fontSize: s(9), fontWeight: '800', letterSpacing: 0.6 }}>{label}</Text>
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
      style={{ width, height, borderRadius: s(8), backgroundColor: '#000', overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border }}
    >
      {!active ? (
        <>
          <Icon name="television-play" size={s(30)} color={colors.muted} />
          <Text style={{ color: colors.muted, fontSize: s(11), marginTop: s(6) }}>Press OK on a channel to preview</Text>
        </>
      ) : null}
    </View>
  );
}
