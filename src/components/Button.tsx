import React from 'react';
import { Text, View } from 'react-native';
import { colors, useLayout } from '../theme';
import { Focusable } from './Focusable';
import { Icon } from './Icon';

interface Props {
  label: string;
  icon?: string;
  focused?: boolean;
  onPress?: () => void;
  primary?: boolean;
  small?: boolean;
  testID?: string;
}

export function Button({ label, icon, focused, onPress, primary, small, testID }: Props) {
  const { s, mode } = useLayout();
  const k = mode === 'tv' ? s : (n: number) => n * 1.15;
  return (
    <Focusable
      focused={focused}
      onPress={onPress}
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: k(small ? 12 : 16),
        height: k(small ? 30 : 36),
        borderRadius: k(8),
        backgroundColor: primary ? colors.accent : colors.surface2,
        borderWidth: 1,
        borderColor: primary ? colors.accent : colors.border,
      }}
      focusStyle={{ backgroundColor: colors.focus, borderColor: colors.focus, transform: [{ scale: 1.04 }] }}
    >
      {({ focused: f }) => (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {icon ? <Icon name={icon} size={k(small ? 14 : 16)} color={f ? colors.focusText : colors.text} style={{ marginRight: k(6) }} /> : null}
          <Text style={{ color: f ? colors.focusText : colors.text, fontWeight: '700', fontSize: k(small ? 11.5 : 12.5) }}>{label}</Text>
        </View>
      )}
    </Focusable>
  );
}
