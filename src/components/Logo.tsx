import React, { memo, useState } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { imageUrl } from '../services/http';
import { hashString, initials } from '../utils/format';
import { colors, monogram, radius } from '../theme';

const PALETTE = monogram;

/** Channel logo with a generated monogram fallback when there's no (or a broken) image. */
export const Logo = memo(function Logo({
  uri,
  name,
  size,
  style,
  rounded = 6,
}: {
  uri?: string;
  name: string;
  size: number;
  style?: StyleProp<ViewStyle>;
  rounded?: number;
}) {
  const [failed, setFailed] = useState(false);
  const bg = PALETTE[parseInt(hashString(name), 36) % PALETTE.length];
  const box: ViewStyle = { width: size * 1.6, height: size, borderRadius: rounded, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' };
  if (!uri || failed) {
    return (
      <View style={[box, { backgroundColor: bg }, style]}>
        <Text numberOfLines={1} style={{ color: colors.text, fontWeight: '800', fontSize: size * 0.34, letterSpacing: 0.5 }}>
          {initials(name)}
        </Text>
      </View>
    );
  }
  return (
    <View style={[box, style]}>
      <Image
        source={{ uri: imageUrl(uri) }}
        style={{ width: '100%', height: '100%' }}
        contentFit="contain"
        cachePolicy="memory-disk"
        recyclingKey={uri}
        onError={() => setFailed(true)}
        transition={120}
      />
    </View>
  );
});

/** Poster art with a title card fallback. */
export const Poster = memo(function Poster({ uri, name, width, style }: { uri?: string; name: string; width: number; style?: StyleProp<ViewStyle> }) {
  const [failed, setFailed] = useState(false);
  const h = hashString(name);
  const c1 = PALETTE[parseInt(h, 36) % PALETTE.length];
  const height = width * 1.5;
  if (!uri || failed) {
    return (
      <View style={[{ width, height, borderRadius: radius.md, backgroundColor: c1, padding: width * 0.08, justifyContent: 'flex-end', overflow: 'hidden' }, style]}>
        <View style={{ position: 'absolute', top: -width * 0.3, right: -width * 0.3, width: width * 0.9, height: width * 0.9, borderRadius: width, backgroundColor: 'rgba(255,255,255,0.06)' }} />
        <Text numberOfLines={4} style={{ color: colors.text, fontWeight: '800', fontSize: Math.max(11, width * 0.11), lineHeight: Math.max(13, width * 0.13) }}>
          {name}
        </Text>
      </View>
    );
  }
  return (
    <View style={[{ width, height, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.surface2 }, style]}>
      <Image
        source={{ uri: imageUrl(uri) }}
        style={{ width: '100%', height: '100%' }}
        contentFit="cover"
        cachePolicy="memory-disk"
        recyclingKey={uri}
        onError={() => setFailed(true)}
        transition={150}
      />
    </View>
  );
});
