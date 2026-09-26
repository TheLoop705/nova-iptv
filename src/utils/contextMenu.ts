import { Platform } from 'react-native';
import type { MenuAnchor } from '../store/ui';

/**
 * Web right-click opens Nova's own menu at the pointer instead of the browser's. Spread the result
 * on a Pressable or View; on TV and phones the same menus open with Menu / long-press.
 */
export function contextMenuProps(open?: (anchor: MenuAnchor) => void): object {
  if (Platform.OS !== 'web' || !open) return {};
  return {
    onContextMenu: (e: { preventDefault: () => void; stopPropagation?: () => void; nativeEvent: { clientX: number; clientY: number } }) => {
      e.preventDefault();
      e.stopPropagation?.();
      open({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
    },
  };
}
