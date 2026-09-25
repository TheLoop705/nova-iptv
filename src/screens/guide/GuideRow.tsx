import React, { memo, useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { Channel, Program } from '../../types';
import { cellAt, cellsInRange, type Cell } from '../../services/epg';
import { colors } from '../../theme';
import { formatRange } from '../../utils/format';
import { Logo } from '../../components/Logo';
import { Icon } from '../../components/Icon';

export interface RowMetrics {
  rowH: number;
  chanW: number;
  gridW: number;
  compact: boolean;
  s: (n: number) => number;
}

interface Props {
  index: number;
  channel: Channel;
  programs?: Program[];
  windowStart: number;
  windowEnd: number;
  now: number;
  /** 'channel' | 'cell' when this row holds focus */
  focusMode: 'none' | 'channel' | 'cell';
  focusTime: number;
  playing: boolean;
  favorite: boolean;
  showNumber: boolean;
  h24: boolean;
  m: RowMetrics;
  onPressChannel: (index: number) => void;
  onLongPressChannel: (index: number) => void;
  onPressCell: (index: number, cell: Cell) => void;
}

export const GuideRow = memo(function GuideRow(p: Props) {
  const { m, windowStart, windowEnd, now } = p;
  const { s, rowH, chanW, gridW, compact } = m;
  const span = windowEnd - windowStart;
  const px = gridW / span;
  const cells = useMemo(() => cellsInRange(p.programs, windowStart, windowEnd), [p.programs, windowStart, windowEnd]);
  const focusedStart = p.focusMode === 'cell' ? cellAt(p.programs, p.focusTime).start : null;
  const chanFocused = p.focusMode === 'channel';

  return (
    <View style={{ height: rowH, flexDirection: 'row' }}>
      <Pressable
        focusable={false}
        onPress={() => p.onPressChannel(p.index)}
        onLongPress={() => p.onLongPressChannel(p.index)}
        style={{
          width: chanW,
          height: rowH - s(3),
          marginTop: s(1.5),
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: compact ? 6 : s(8),
          backgroundColor: chanFocused ? colors.focus : colors.surface,
          borderRadius: s(5),
          marginRight: s(2),
        }}
      >
        {p.playing ? (
          <View style={{ position: 'absolute', left: 0, top: s(6), bottom: s(6), width: s(3), borderRadius: 2, backgroundColor: colors.accent }} />
        ) : null}
        {p.showNumber && !compact ? (
          <Text style={{ width: s(30), color: chanFocused ? colors.focusText : colors.muted, fontSize: s(11), fontWeight: '600' }} numberOfLines={1}>
            {p.channel.num}
          </Text>
        ) : null}
        <Logo uri={p.channel.logo} name={p.channel.name} size={compact ? 30 : s(24)} />
        {!compact ? (
          <Text
            numberOfLines={1}
            style={{ flex: 1, marginLeft: s(8), color: chanFocused ? colors.focusText : p.playing ? colors.accent : colors.text, fontSize: s(12), fontWeight: '600' }}
          >
            {p.channel.name}
          </Text>
        ) : null}
        {p.favorite && !compact ? <Icon name="star" size={s(11)} color={chanFocused ? colors.focusText : colors.warning} /> : null}
        {p.channel.catchup && !compact ? (
          <Icon name="history" size={s(11)} color={chanFocused ? colors.focusText : colors.muted} style={{ marginLeft: s(3) }} />
        ) : null}
      </Pressable>
      <View style={{ width: gridW, height: rowH, overflow: 'hidden' }}>
        {cells.map((c) => {
          const from = Math.max(c.start, windowStart);
          const to = Math.min(c.end, windowEnd);
          const left = (from - windowStart) * px;
          const width = Math.max(0, (to - from) * px - s(2));
          const focused = focusedStart === c.start;
          const past = c.end <= now;
          const current = c.start <= now && c.end > now;
          const bg = focused ? colors.focus : current ? colors.nowCell : past ? colors.pastCell : colors.surface;
          const fg = focused ? colors.focusText : past ? colors.muted : colors.text;
          const clipped = c.start < windowStart;
          const narrow = width < s(64);
          return (
            <Pressable
              key={c.start}
              focusable={false}
              onPress={() => p.onPressCell(p.index, c)}
              style={{
                position: 'absolute',
                left,
                width,
                top: s(1.5),
                height: rowH - s(3),
                backgroundColor: bg,
                borderRadius: s(5),
                paddingHorizontal: width > s(20) ? s(7) : 0,
                justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              {width > s(14) ? (
                <>
                  <Text numberOfLines={1} style={{ color: fg, fontSize: compact ? 13 : s(12), fontWeight: current || focused ? '700' : '500' }}>
                    {clipped ? '‹ ' : ''}
                    {c.program ? c.program.title || 'Untitled' : 'No information'}
                  </Text>
                  {!narrow && c.program ? (
                    <Text numberOfLines={1} style={{ color: focused ? '#3A4252' : colors.muted, fontSize: compact ? 11 : s(9.5), marginTop: s(1) }}>
                      {formatRange(c.start, c.end, p.h24)}
                    </Text>
                  ) : null}
                </>
              ) : null}
              {current && !focused ? (
                <View style={{ position: 'absolute', left: 0, bottom: 0, height: s(2), width: Math.max(0, ((now - from) / (to - from)) * width), backgroundColor: 'rgba(76,141,255,0.55)' }} />
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
});
