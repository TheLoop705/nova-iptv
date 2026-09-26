import React from 'react';
import { ActivityIndicator, Platform, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, useLayout } from '../theme';
import { useUpdater } from '../services/updates';

/** Pill at the bottom while an app update downloads and the installer opens. */
export function UpdateProgress() {
  const status = useUpdater((st) => st.status);
  const progress = useUpdater((st) => st.progress);
  const version = useUpdater((st) => st.update?.version);
  const { k, mode, type } = useLayout();
  const insets = useSafeAreaInsets();
  if (status !== 'downloading' && status !== 'installing') return null;
  const tv = mode === 'tv';
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: tv ? k(32) : 76 + insets.bottom, alignItems: 'center', paddingHorizontal: 16 }}>
      <View style={{ minWidth: k(280), backgroundColor: colors.surface3, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: k(16), paddingVertical: k(10) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={[type('label'), { color: colors.text, marginLeft: k(10), flex: 1 }]}>
            {status === 'installing' ? (Platform.OS === 'web' ? `Reloading Nova ${version}…` : `Opening the installer for Nova ${version}…`) : `Downloading Nova ${version}…`}
          </Text>
          {status === 'downloading' ? <Text style={[type('label'), { color: colors.textDim, marginLeft: k(10), fontVariant: ['tabular-nums'] }]}>{Math.round(progress * 100)}%</Text> : null}
        </View>
        <View style={{ height: k(4), backgroundColor: colors.surface, borderRadius: radius.pill, marginTop: k(8), overflow: 'hidden' }}>
          <View style={{ width: `${Math.round(progress * 100)}%`, height: '100%', backgroundColor: colors.accent }} />
        </View>
      </View>
    </View>
  );
}
