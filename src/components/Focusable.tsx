import React, { memo, type ReactNode } from 'react';
import { Pressable, type StyleProp, type ViewStyle, Platform } from 'react-native';
import { useKeyMode } from '../input/keys';

interface Props {
  focused?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  onHoverIn?: () => void;
  style?: StyleProp<ViewStyle>;
  focusStyle?: StyleProp<ViewStyle>;
  /** show the focus style even in pointer/touch mode (e.g. the selected guide cell) */
  alwaysShowFocus?: boolean;
  children: ReactNode | ((state: { focused: boolean; hovered: boolean }) => ReactNode);
  testID?: string;
  accessibilityLabel?: string;
}

/**
 * Pressable that never takes native focus (JS owns focus on TV) and renders a focus state
 * driven by the screen's key-navigation model.
 */
export const Focusable = memo(function Focusable({
  focused = false,
  onPress,
  onLongPress,
  onHoverIn,
  style,
  focusStyle,
  alwaysShowFocus,
  children,
  testID,
  accessibilityLabel,
}: Props) {
  const keyMode = useKeyMode();
  const show = focused && (keyMode || alwaysShowFocus);
  return (
    <Pressable
      focusable={false}
      onPress={onPress}
      onLongPress={onLongPress}
      onHoverIn={onHoverIn}
      delayLongPress={450}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={(state) => {
        const hovered = Platform.OS === 'web' && !!(state as any).hovered;
        return [style, (show || (hovered && !keyMode)) && focusStyle, state.pressed && { opacity: 0.85 }];
      }}
    >
      {(state) => {
        const hovered = Platform.OS === 'web' && !!(state as any).hovered && !keyMode;
        return typeof children === 'function' ? children({ focused: !!show || hovered, hovered }) : children;
      }}
    </Pressable>
  );
});
