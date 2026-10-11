import React from 'react';
import { Text, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

export interface HoverTitleProps {
  text: string;
  active?: boolean;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
}

export function HoverTitle({ text, style, containerStyle }: HoverTitleProps) {
  return <Text numberOfLines={1} style={[containerStyle as TextStyle, style]}>{text}</Text>;
}
