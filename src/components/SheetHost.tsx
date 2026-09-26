import React, { useEffect, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUI } from '../store/ui';
import { Layer, useKeys } from '../input/keys';
import { colors, radius, useLayout } from '../theme';
import { Focusable } from './Focusable';
import { Icon } from './Icon';

/** Modal option list (side menu on TV, bottom sheet on phones, context menu for a web right-click). */
export function SheetHost() {
  const sheet = useUI((s) => s.sheet);
  const close = useUI((s) => s.closeSheet);
  const { s, mode, type } = useLayout();
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
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

  if (sheet.anchor) {
    // Context menu at the pointer, kept inside the window
    const w = s(250);
    const itemH = s(34);
    const h = s(40) + sheet.options.length * itemH;
    const left = Math.max(8, Math.min(sheet.anchor.x, win.width - w - 8));
    const top = Math.max(8, sheet.anchor.y + h > win.height - 8 ? sheet.anchor.y - h : sheet.anchor.y);
    return (
      <View style={StyleSheet.absoluteFill}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} focusable={false} {...({ onContextMenu: (e: { preventDefault: () => void }) => (e.preventDefault(), close()) } as object)} />
        <View
          style={{
            position: 'absolute',
            left,
            top,
            width: w,
            backgroundColor: colors.surface2,
            borderRadius: s(radius.md),
            borderWidth: 1,
            borderColor: colors.borderStrong,
            paddingVertical: s(5),
            shadowColor: colors.video,
            shadowOpacity: 0.5,
            shadowRadius: 24,
            shadowOffset: { width: 0, height: 8 },
          }}
        >
          <Text numberOfLines={1} style={[type('caption'), { color: colors.muted, fontWeight: '700', paddingHorizontal: s(12), paddingTop: s(4), paddingBottom: s(6) }]}>
            {sheet.title}
          </Text>
          {sheet.options.map((o, i) => (
            <Focusable
              key={o.label + i}
              focused={i === index}
              onPress={() => {
                close();
                o.onSelect();
              }}
              style={{ height: itemH, marginHorizontal: s(5), borderRadius: s(radius.sm), flexDirection: 'row', alignItems: 'center', paddingHorizontal: s(8) }}
              focusStyle={{ backgroundColor: colors.focus }}
            >
              {({ focused }) => (
                <>
                  {o.icon ? <Icon name={o.icon} size={s(15)} color={focused ? colors.focusText : o.destructive ? colors.live : colors.textDim} style={{ marginRight: s(10) }} /> : null}
                  <Text numberOfLines={1} style={[type('label'), { flex: 1, fontWeight: '600', color: focused ? colors.focusText : o.destructive ? colors.live : colors.text }]}>
                    {o.label}
                  </Text>
                  {o.selected ? <Icon name="check" size={s(14)} color={focused ? colors.focusText : colors.accent} /> : null}
                </>
              )}
            </Focusable>
          ))}
        </View>
      </View>
    );
  }

  const panel = tv
    ? { position: 'absolute' as const, right: 0, top: 0, bottom: 0, width: s(320), paddingTop: s(32), paddingBottom: s(16) }
    : {
        position: 'absolute' as const,
        left: 0,
        right: 0,
        bottom: 0,
        maxHeight: '80%' as const,
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
        paddingTop: 8,
        paddingBottom: Math.max(insets.bottom, 16),
        alignSelf: 'center' as const,
        maxWidth: 560,
        marginHorizontal: 'auto' as const,
      };

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]} onPress={close} focusable={false} />
      <Animated.View style={[panel, { backgroundColor: colors.bgElevated, borderLeftWidth: tv ? 1 : 0, borderTopWidth: tv ? 0 : 1, borderColor: colors.border }]}>
        {!tv ? <View style={{ alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: colors.borderStrong, marginBottom: 14 }} /> : null}
        <View style={{ paddingHorizontal: tv ? s(22) : 20, marginBottom: tv ? s(12) : 10 }}>
          <Text numberOfLines={2} style={[type('heading'), { color: colors.text }]}>
            {sheet.title}
          </Text>
          {sheet.subtitle ? (
            <Text numberOfLines={tv ? 6 : 4} style={[type('caption'), { color: colors.textDim, marginTop: tv ? s(4) : 4, lineHeight: tv ? s(16) : 18 }]}>
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
                paddingVertical: tv ? s(9) : 0,
                minHeight: tv ? s(40) : 52,
                borderRadius: tv ? s(radius.md) : radius.md,
                marginBottom: tv ? s(2) : 2,
              }}
              focusStyle={{ backgroundColor: colors.focus }}
            >
              {({ focused }) => (
                <>
                  {o.icon ? (
                    <Icon name={o.icon} size={tv ? s(17) : 20} color={focused ? colors.focusText : o.destructive ? colors.live : colors.textDim} style={{ marginRight: tv ? s(12) : 14 }} />
                  ) : null}
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={[type('body'), { fontWeight: '600', color: focused ? colors.focusText : o.destructive ? colors.live : colors.text }]}>
                      {o.label}
                    </Text>
                    {o.detail ? (
                      <Text numberOfLines={1} style={[type('caption'), { color: focused ? colors.focusDim : colors.muted, marginTop: 1 }]}>
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
        {tv ? (
          <Text style={[type('caption'), { color: colors.muted, paddingHorizontal: s(22), paddingTop: s(10) }]}>▲▼ choose · OK select · Back close</Text>
        ) : null}
      </Animated.View>
    </View>
  );
}

export function Toast() {
  const toast = useUI((s) => s.toast);
  const { s, mode, type } = useLayout();
  const insets = useSafeAreaInsets();
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
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: tv ? s(32) : 76 + insets.bottom, alignItems: 'center', paddingHorizontal: 16 }}>
      <View style={{ backgroundColor: colors.surface3, paddingHorizontal: tv ? s(18) : 18, paddingVertical: tv ? s(10) : 11, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderStrong }}>
        <Text style={[type('label'), { color: colors.text }]}>{toast.text}</Text>
      </View>
    </View>
  );
}
