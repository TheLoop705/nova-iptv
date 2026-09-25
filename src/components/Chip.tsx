import React from 'react';
import { Pressable, Text } from 'react-native';
import { colors, radius, useLayout } from '../theme';
import { Icon } from './Icon';

/** Filter chip for touch layouts (guide groups, VOD categories). Selected = accent fill. */
export function Chip({ label, icon, selected, onPress }: { label: string; icon?: string; selected?: boolean; onPress: () => void }) {
  const { k, type } = useLayout();
  return (
    <Pressable
      focusable={false}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6 }}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: k(14),
        height: k(34),
        borderRadius: radius.pill,
        backgroundColor: selected ? colors.accentFill : colors.surface2,
        borderWidth: 1,
        borderColor: selected ? colors.accentFill : colors.border,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={k(14)} color={selected ? colors.onAccent : colors.star} style={{ marginRight: k(5) }} /> : null}
      <Text numberOfLines={1} style={[type('label'), { fontSize: k(13.5), color: selected ? colors.onAccent : colors.text }]}>
        {label}
      </Text>
    </Pressable>
  );
}
