import React, { memo, type ReactNode } from 'react';
import { Pressable, type StyleProp, type ViewStyle, Platform } from 'react-native';
import { useKeyMode } from '../input/keys';
import { colors } from '../theme';
import { contextMenuProps } from '../utils/contextMenu';
import type { MenuAnchor } from '../store/ui';

const DEFAULT_HOVER: ViewStyle = { backgroundColor: colors.hover };

interface Props {
  focused?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  /** web right-click (TV/phones use Menu / long-press for the same menu) */
  onContextMenu?: (anchor: MenuAnchor) => void;
  onHoverIn?: () => void;
  style?: StyleProp<ViewStyle>;
  focusStyle?: StyleProp<ViewStyle>;
  /** pointer hover on the web; a quieter cue than focus (defaults to the `hover` surface) */
  hoverStyle?: StyleProp<ViewStyle>;
  /** show the focus style even in pointer/touch mode (e.g. the selected guide cell) */
  alwaysShowFocus?: boolean;
  children: ReactNode | ((state: { focused: boolean; hovered: boolean }) => ReactNode);
  testID?: string;
  accessibilityLabel?: string;
}

/**
 * Pressable that never takes native focus (JS owns focus on TV) and renders a focus state
 * driven by the screen's key-navigation model. Focus (remote/keyboard) is the white fill;
 * mouse hover gets its own quieter style so the pointer never fakes a remote focus.
 */
export const Focusable = memo(function Focusable({
  focused = false,
  onPress,
  onLongPress,
  onContextMenu,
  onHoverIn,
  style,
  focusStyle,
  hoverStyle = DEFAULT_HOVER,
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
      {...contextMenuProps(onContextMenu)}
      onHoverIn={onHoverIn}
      delayLongPress={450}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={(state) => {
        const hovered = Platform.OS === 'web' && !!(state as any).hovered;
        return [style, hovered && !keyMode && !show && hoverStyle, show && focusStyle, state.pressed && { opacity: 0.85 }];
      }}
    >
      {(state) => {
        const hovered = Platform.OS === 'web' && !!(state as any).hovered && !keyMode;
        return typeof children === 'function' ? children({ focused: !!show, hovered }) : children;
      }}
    </Pressable>
  );
});
