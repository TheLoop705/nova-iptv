import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, fonts, useLayout } from '../theme';
import { useUI } from '../store/ui';
import { useSettings } from '../store/settings';
import { useKeys } from '../input/keys';
import { Button } from '../components/Button';
import { NovaMark } from '../components/NovaMark';

export function Onboarding() {
  const { s, mode } = useLayout();
  const tv = mode === 'tv';
  const k = tv ? s : (n: number) => n * 1.15;
  const openEditor = useUI((st) => st.openEditor);
  const editorOpen = useUI((st) => !!st.editor);
  const addPlaylist = useSettings((st) => st.addPlaylist);
  const [btn, setBtn] = useState(0);

  const actions = [
    () => openEditor(),
    () => addPlaylist({ id: 'demo', name: 'Demo channels', type: 'demo', createdAt: Date.now() }),
  ];

  useKeys(
    (e) => {
      if (e.key === 'left' || e.key === 'up') return setBtn(0);
      if (e.key === 'right' || e.key === 'down') return setBtn(1);
      if (e.key === 'select') return actions[btn]();
      return false;
    },
    !editorOpen
  );

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <LinearGradient colors={[colors.nowCell, colors.bg]} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: '70%' }} />
      <NovaMark size={k(64)} />
      <Text style={{ color: colors.text, fontSize: k(36), fontWeight: '800', marginTop: k(18), letterSpacing: -0.8, fontFamily: fonts.regular }}>Nova</Text>
      <Text style={{ color: colors.textDim, fontSize: k(14), marginTop: k(8), textAlign: 'center', maxWidth: k(460), lineHeight: k(21), fontFamily: fonts.regular }}>
        A fast IPTV player with a full TV guide, catch-up, movies and series. Bring your own M3U playlist or Xtream Codes account.
      </Text>
      <View style={{ flexDirection: tv ? 'row' : 'column', gap: k(12), marginTop: k(28), alignSelf: tv ? 'center' : 'stretch', maxWidth: tv ? undefined : 420, width: tv ? undefined : '100%' }}>
        <Button label="Add playlist" icon="plus" primary focused={btn === 0} onPress={actions[0]} testID="onboarding-add" />
        <Button label="Try demo channels" icon="play-circle-outline" focused={btn === 1} onPress={actions[1]} testID="onboarding-demo" />
      </View>
      <Text style={{ color: colors.muted, fontSize: k(11.5), marginTop: k(22), textAlign: 'center', maxWidth: k(420), fontFamily: fonts.regular }}>
        Nova is a player only and ships no channels.
      </Text>
    </View>
  );
}
