import React, { useEffect, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useUI } from '../store/ui';
import { Layer, useKeys } from '../input/keys';
import { colors, useLayout } from '../theme';
import { Focusable } from './Focusable';
import { Icon } from './Icon';

/** Modal option list (TiviMate-style side menu on TV, bottom sheet on phones). */
export function SheetHost() {
  const sheet = useUI((s) => s.sheet);
  const close = useUI((s) => s.closeSheet);
  const { s, mode } = useLayout();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (sheet) setIndex(Math.max(0, sheet.options.findIndex((o) => o.selected)));
  }, [sheet]);

  useKeys(
    (e) => {
      if (!sheet) return false;
      const n = sheet.options.length;
      if (e.key === 'up') setIndex((i) => (i - 1 + n) % n);
      else if (e.key === 'down') setIndex((i) => (i + 1) % n);
      else if (e.key === 'select') {
        const opt = sheet.options[index];
        close();
        opt?.onSelect();
      } else if (e.key === 'back' || e.key === 'left' || e.key === 'menu') close();
    },
    !!sheet,
    Layer.sheet
  );

  if (!sheet) return null;
  const tv = mode === 'tv';
  const panel = tv
    ? { position: 'absolute' as const, right: 0, top: 0, bottom: 0, width: s(300), paddingTop: s(28) }
    : { position: 'absolute' as const, left: 0, right: 0, bottom: 0, maxHeight: '75%' as const, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 16, paddingBottom: 28 };

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]} onPress={close} focusable={false} />
      <Animated.View style={[panel, { backgroundColor: colors.bgElevated, borderLeftWidth: tv ? 1 : 0, borderColor: colors.border }]}>
        <View style={{ paddingHorizontal: tv ? s(20) : 20, marginBottom: tv ? s(10) : 10 }}>
          <Text numberOfLines={2} style={{ color: colors.text, fontSize: tv ? s(17) : 18, fontWeight: '700' }}>
            {sheet.title}
          </Text>
          {sheet.subtitle ? (
            <Text numberOfLines={4} style={{ color: colors.textDim, fontSize: tv ? s(11.5) : 13, marginTop: 4, lineHeight: tv ? s(16) : 18 }}>
              {sheet.subtitle}
            </Text>
          ) : null}
        </View>
        <ScrollView contentContainerStyle={{ paddingHorizontal: tv ? s(10) : 10 }}>
          {sheet.options.map((o, i) => (
            <Focusable
              key={o.label + i}
              focused={i === index}
              onPress={() => {
                close();
                o.onSelect();
              }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: tv ? s(12) : 12,
                paddingVertical: tv ? s(9) : 13,
                borderRadius: tv ? s(8) : 10,
                marginBottom: 2,
              }}
              focusStyle={{ backgroundColor: colors.focus }}
            >
              {({ focused }) => (
                <>
                  {o.icon ? (
                    <Icon name={o.icon} size={tv ? s(17) : 20} color={focused ? colors.focusText : o.destructive ? colors.live : colors.textDim} style={{ marginRight: tv ? s(12) : 14 }} />
                  ) : null}
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ color: focused ? colors.focusText : o.destructive ? colors.live : colors.text, fontSize: tv ? s(13) : 15, fontWeight: '600' }}>
                      {o.label}
                    </Text>
                    {o.detail ? (
                      <Text numberOfLines={1} style={{ color: focused ? '#394253' : colors.muted, fontSize: tv ? s(10.5) : 12, marginTop: 2 }}>
                        {o.detail}
                      </Text>
                    ) : null}
                  </View>
                  {o.selected ? <Icon name="check" size={tv ? s(16) : 18} color={focused ? colors.focusText : colors.accent} /> : null}
                </>
              )}
            </Focusable>
          ))}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

export function Toast() {
  const toast = useUI((s) => s.toast);
  const { s, mode } = useLayout();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast || !visible) return null;
  const tv = mode === 'tv';
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: tv ? s(28) : 90, alignItems: 'center' }}>
      <View style={{ backgroundColor: colors.surface3, paddingHorizontal: tv ? s(16) : 16, paddingVertical: tv ? s(9) : 10, borderRadius: 999, borderWidth: 1, borderColor: colors.border }}>
        <Text style={{ color: colors.text, fontSize: tv ? s(12.5) : 14, fontWeight: '600' }}>{toast.text}</Text>
      </View>
    </View>
  );
}
