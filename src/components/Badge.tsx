import React from 'react';
import { Text, View } from 'react-native';
import { colors, useLayout } from '../theme';
import { Icon } from './Icon';

type Tone = 'live' | 'catchup' | 'neutral';

const TONES: Record<Tone, { bg: string; fg: string }> = {
  live: { bg: colors.liveFill, fg: colors.onLive },
  catchup: { bg: colors.accentFill, fg: colors.onAccent },
  neutral: { bg: colors.glass, fg: colors.onVideo },
};

/** Status tag: LIVE, CATCH-UP, HD… Always a word (and optionally an icon), never colour alone. */
export function Badge({ label, tone = 'neutral', icon }: { label: string; tone?: Tone; icon?: string }) {
  const { k, mode, type } = useLayout();
  const t = TONES[tone];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: t.bg, borderRadius: k(4), paddingHorizontal: k(6), paddingVertical: k(1.5), marginRight: k(8) }}>
      {tone === 'live' ? <View style={{ width: k(5), height: k(5), borderRadius: k(3), backgroundColor: t.fg, marginRight: k(4) }} /> : null}
      {icon ? <Icon name={icon} size={k(10)} color={t.fg} style={{ marginRight: k(3) }} /> : null}
      <Text style={[type('overline'), { fontSize: mode === 'tv' ? k(11) : 10.5, lineHeight: mode === 'tv' ? k(13) : 13, color: t.fg }]}>{label}</Text>
    </View>
  );
}
