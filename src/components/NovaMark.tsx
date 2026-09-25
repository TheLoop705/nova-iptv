import React from 'react';
import { View } from 'react-native';
import { colors } from '../theme';
import { Icon } from './Icon';

/** The Nova mark: a four-point star on the accent fill, corner radius 30% of the side. */
export function NovaMark({ size }: { size: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: colors.accentFill, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="star-four-points" size={size * 0.58} color={colors.onAccent} />
    </View>
  );
}
