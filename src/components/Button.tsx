import React from 'react';
import { Text, View } from 'react-native';
import { colors, radius, useLayout } from '../theme';
import { Focusable } from './Focusable';
import { Icon } from './Icon';

interface Props {
  label: string;
  icon?: string;
  focused?: boolean;
  onPress?: () => void;
  /** filled accent: the one main action of a view */
  primary?: boolean;
  /** red label for actions that delete or sign out */
  destructive?: boolean;
  small?: boolean;
  testID?: string;
}

/** Action button. Focus is the white fill on every variant; touch layouts keep a 44pt target. */
export function Button({ label, icon, focused, onPress, primary, destructive, small, testID }: Props) {
  const { s, k, mode, type } = useLayout();
  const tv = mode === 'tv';
  const h = tv ? s(small ? 30 : 36) : small ? 40 : 48;
  const fill = primary ? colors.accentFill : colors.surface2;
  const ink = primary ? colors.onAccent : destructive ? colors.live : colors.text;
  return (
    <Focusable
      focused={focused}
      onPress={onPress}
      testID={testID}
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: k(small ? 14 : 18),
        height: h,
        minWidth: tv ? undefined : 44,
        borderRadius: tv ? s(radius.md) : radius.md,
        backgroundColor: fill,
        borderWidth: 1,
        borderColor: primary ? colors.accentFill : colors.border,
      }}
      hoverStyle={{ backgroundColor: primary ? '#3D78F2' : colors.surface3, borderColor: primary ? '#3D78F2' : colors.borderStrong }}
      focusStyle={{ backgroundColor: colors.focus, borderColor: colors.focus, transform: [{ scale: tv ? 1.05 : 1.02 }] }}
    >
      {({ focused: f }) => (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {icon ? <Icon name={icon} size={k(small ? 15 : 17)} color={f ? colors.focusText : ink} style={{ marginRight: k(7) }} /> : null}
          <Text style={[type('label'), small && !tv ? { fontSize: 13.5 } : null, { color: f ? colors.focusText : ink }]}>{label}</Text>
        </View>
      )}
    </Focusable>
  );
}
