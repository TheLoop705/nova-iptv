import React from 'react';
// Per-set entry point: the package barrel pulls every icon set (and its font) into the bundle.
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { StyleProp, TextStyle } from 'react-native';

export type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

export function Icon({ name, size = 20, color = '#fff', style }: { name: IconName | string; size?: number; color?: string; style?: StyleProp<TextStyle> }) {
  return <MaterialCommunityIcons name={name as IconName} size={size} color={color} style={style} />;
}
