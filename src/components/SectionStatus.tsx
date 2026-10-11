import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { colors, radius, useLayout } from '../theme';
import { Focusable } from './Focusable';

export function SectionStatus({ label, loading, onRetry, focused = false, testID }: {
  label: string; loading?: boolean; onRetry?: () => void; focused?: boolean; testID?: string;
}) {
  const { k, type } = useLayout();
  return (
    <View testID={testID} style={{ flexDirection: 'row', alignItems: 'center', gap: k(8), paddingVertical: k(6), paddingHorizontal: k(12) }}>
      {loading ? <ActivityIndicator size="small" color={colors.accent} /> : null}
      <Text style={[type('caption'), { color: colors.textDim, flexShrink: 1 }]}>{label}</Text>
      {onRetry && !loading ? (
        <Focusable focused={focused} onPress={onRetry} accessibilityLabel={`Retry ${label}`} testID={testID && `${testID}-retry`}
          style={{ paddingHorizontal: k(10), paddingVertical: k(5), borderRadius: radius.sm, backgroundColor: colors.surface }}
          focusStyle={{ backgroundColor: colors.focus }}>
          {({ focused: f }) => <Text style={[type('label'), { color: f ? colors.focusText : colors.text }]}>Retry</Text>}
        </Focusable>
      ) : null}
    </View>
  );
}
