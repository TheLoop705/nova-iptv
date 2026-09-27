import React from 'react';
import { Text, View } from 'react-native';
import type { SeriesItem, VodItem } from '../types';
import { colors, radius } from '../theme';
import type { MenuAnchor } from '../store/ui';
import { Poster } from './Logo';
import { Focusable } from './Focusable';
import { Icon } from './Icon';

/** Movie / series poster with its name, rating, watched mark and progress. Used by the grids and Home's rows. */
export const PosterCard = React.memo(function PosterCard({
  item,
  width,
  focused,
  progress,
  watched,
  caption,
  tv,
  s,
  onPress,
  onMenu,
  onHoverIn,
}: {
  item: VodItem | SeriesItem;
  width: number;
  focused: boolean;
  progress: number;
  watched?: boolean;
  /** second line under the name (defaults to the year) */
  caption?: string;
  onMenu?: (anchor?: MenuAnchor) => void;
  onHoverIn?: () => void;
  tv: boolean;
  s: (n: number) => number;
  onPress: () => void;
}) {
  const sub = caption ?? ('year' in item ? item.year : undefined);
  return (
    <Focusable
      focused={focused}
      onPress={onPress}
      onLongPress={onMenu && (() => onMenu())}
      onContextMenu={onMenu}
      onHoverIn={onHoverIn}
      accessibilityLabel={item.name}
      style={{ width, borderRadius: radius.md, padding: 0 }}
      hoverStyle={{ transform: [{ scale: 1.03 }] }}
      focusStyle={{ transform: [{ scale: 1.07 }] }}
    >
      {({ focused: f, hovered }) => (
        <View>
          <View style={{ borderRadius: tv ? s(radius.md) : radius.md, borderWidth: tv ? s(2.5) : 2, borderColor: f ? colors.focus : hovered ? colors.borderStrong : 'transparent', overflow: 'hidden' }}>
            <Poster uri={item.poster} name={item.name} width={width - (tv ? s(5) : 4)} />
            {item.rating && Number(item.rating) > 0 ? (
              <View style={{ position: 'absolute', top: 6, right: 6, backgroundColor: colors.videoScrim, borderRadius: radius.xs, paddingHorizontal: 5, paddingVertical: 1, flexDirection: 'row', alignItems: 'center' }}>
                <Icon name="star" size={tv ? s(10) : 11} color={colors.star} />
                <Text style={{ color: colors.onVideo, fontSize: tv ? s(10.5) : 11, fontWeight: '700', marginLeft: 2, fontVariant: ['tabular-nums'] }}>{Number(item.rating).toFixed(1)}</Text>
              </View>
            ) : null}
            {watched && !(progress > 0) ? (
              <View style={{ position: 'absolute', top: 6, left: 6, backgroundColor: colors.videoScrim, borderRadius: radius.pill, padding: 2 }}>
                <Icon name="check-circle" size={tv ? s(13) : 15} color={colors.success} />
              </View>
            ) : null}
            {progress > 0 ? (
              <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: tv ? s(3) : 4, backgroundColor: colors.videoScrim }}>
                <View style={{ width: `${Math.min(100, progress * 100)}%`, height: '100%', backgroundColor: colors.accent }} />
              </View>
            ) : null}
          </View>
          <Text numberOfLines={1} style={{ color: f || hovered ? colors.text : colors.textDim, fontSize: tv ? s(11.5) : 13, fontWeight: f ? '700' : '600', marginTop: tv ? s(6) : 6 }}>
            {item.name}
          </Text>
          {sub ? (
            <Text numberOfLines={1} style={{ color: colors.muted, fontSize: tv ? s(11) : 12 }}>
              {sub}
            </Text>
          ) : null}
        </View>
      )}
    </Focusable>
  );
});
