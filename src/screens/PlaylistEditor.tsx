import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { colors, fonts, useLayout } from '../theme';
import { useUI } from '../store/ui';
import { useSettings } from '../store/settings';
import { useLibrary } from '../store/library';
import { Layer, useKeys } from '../input/keys';
import { Focusable } from '../components/Focusable';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import type { Playlist, PlaylistType } from '../types';
import { setItem } from '../services/storage';
import { normalizeServer } from '../services/xtream';
import { pickTextFile } from '../services/filepick';
import { uid } from '../utils/format';
import { PlaylistPairing, type PairedPlaylist } from '../../modules/playlist-pairing';

type Kind = 'm3u' | 'xtream' | 'file';

interface Field {
  id: keyof Form;
  label: string;
  placeholder: string;
  secure?: boolean;
  optional?: boolean;
}

interface Form {
  name: string;
  url: string;
  server: string;
  username: string;
  password: string;
  epgUrl: string;
  userAgent: string;
}

type PairingState =
  | { status: 'starting' }
  | { status: 'ready'; url: string; expiresAt: number }
  | { status: 'received' }
  | { status: 'error'; message: string };

export function PlaylistEditor() {
  const { s, mode } = useLayout();
  const insets = useSafeAreaInsets();
  const tv = mode === 'tv';
  const k = tv ? s : (n: number) => n * 1.1;
  const editing = useUI((st) => st.editor?.playlist);
  const close = useUI((st) => st.closeEditor);
  const showToast = useUI((st) => st.showToast);
  const sheetOpen = useUI((st) => !!st.sheet);
  const addPlaylist = useSettings((st) => st.addPlaylist);
  const updatePlaylist = useSettings((st) => st.updatePlaylist);

  const [kind, setKind] = useState<Kind>(editing ? (editing.type === 'xtream' ? 'xtream' : editing.inline ? 'file' : 'm3u') : 'm3u');
  const [form, setForm] = useState<Form>({
    name: editing?.name ?? '',
    url: editing?.url ?? '',
    server: editing?.server ?? '',
    username: editing?.username ?? '',
    password: editing?.password ?? '',
    epgUrl: editing?.epgUrl ?? '',
    userAgent: editing?.userAgent ?? '',
  });
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const inputs = useRef<Record<string, TextInput | null>>({});
  const viewportRef = useRef<View>(null);
  const scrollRef = useRef<ScrollView>(null);
  const focusRefs = useRef<Record<number, View | null>>({});
  const scrollY = useRef(0);
  const canPair = !editing && tv && Platform.OS === 'android' && !!PlaylistPairing;
  const [pairing, setPairing] = useState<PairingState | null>(canPair ? { status: 'starting' } : null);

  const startPairing = useCallback(async () => {
    if (!canPair || !PlaylistPairing) return;
    setPairing({ status: 'starting' });
    try {
      const session = await PlaylistPairing.start();
      setPairing({ status: 'ready', ...session });
    } catch (e: any) {
      setPairing({ status: 'error', message: e?.message ?? 'Could not start phone setup.' });
    }
  }, [canPair]);

  useEffect(() => {
    const pairingModule = PlaylistPairing;
    if (!canPair || !pairingModule) return;
    const sub = pairingModule.addListener('onPlaylist', (incoming: PairedPlaylist) => {
      setKind(incoming.kind);
      setForm({
        name: incoming.name,
        url: incoming.url,
        server: incoming.server,
        username: incoming.username,
        password: incoming.password,
        epgUrl: incoming.epgUrl,
        userAgent: incoming.userAgent,
      });
      setError(null);
      setPairing({ status: 'received' });
      // pairing card + type tabs + fields; put remote focus on the final review action
      setFocus(2 + (incoming.kind === 'xtream' ? 6 : 4));
    });
    void startPairing();
    return () => {
      sub.remove();
      pairingModule.stop();
    };
  }, [canPair, startPairing]);

  useEffect(() => {
    if (pairing?.status !== 'ready') return;
    const wait = Math.max(0, pairing.expiresAt - Date.now());
    const timer = setTimeout(() => setPairing({ status: 'error', message: 'The code expired. Select this card for a new one.' }), wait);
    return () => clearTimeout(timer);
  }, [pairing]);

  const fields: Field[] = [
    { id: 'name', label: 'Name', placeholder: 'My IPTV', optional: true },
    ...(kind === 'm3u' ? [{ id: 'url' as const, label: 'Playlist URL', placeholder: 'http://provider.com/get.php?username=…&type=m3u_plus' }] : []),
    ...(kind === 'xtream'
      ? [
          { id: 'server' as const, label: 'Server URL', placeholder: 'http://provider.com:8080' },
          { id: 'username' as const, label: 'Username', placeholder: 'username' },
          { id: 'password' as const, label: 'Password', placeholder: 'password', secure: true },
        ]
      : []),
    { id: 'epgUrl', label: 'EPG URL (XMLTV)', placeholder: kind === 'xtream' ? 'Automatic — leave empty' : 'From playlist — leave empty to auto-detect', optional: true },
    { id: 'userAgent', label: 'User-Agent', placeholder: 'Default', optional: true },
  ];

  // focus order: [type tabs] [file picker?] [fields...] [save] [cancel]
  type Item = { kind: 'pair' } | { kind: 'tabs' } | { kind: 'file' } | { kind: 'field'; field: Field } | { kind: 'save' } | { kind: 'cancel' };
  const items: Item[] = [
    ...(canPair ? [{ kind: 'pair' as const }] : []),
    { kind: 'tabs' },
    ...(kind === 'file' ? [{ kind: 'file' as const }] : []),
    ...fields.map((f) => ({ kind: 'field' as const, field: f })),
    { kind: 'save' },
    { kind: 'cancel' },
  ];
  const kinds: Kind[] = ['m3u', 'xtream', 'file'];

  /** Keep JS-owned D-pad focus visible whenever a fallback scroll is actually needed. */
  const revealFocus = useCallback(
    (index: number) => {
      const target = focusRefs.current[index];
      const scroll = scrollRef.current;
      const viewport = viewportRef.current;
      if (!target || !scroll || !viewport) return;
      target.measureInWindow((_x, y, _width, height) => {
        viewport.measureInWindow((_sx, scrollTop, _scrollWidth, scrollHeight) => {
          const inset = tv ? s(12) : 12;
          const visibleTop = scrollTop + inset;
          const visibleBottom = scrollTop + scrollHeight - inset;
          let delta = 0;
          if (y < visibleTop) delta = y - visibleTop;
          else if (y + height > visibleBottom) delta = y + height - visibleBottom;
          if (Math.abs(delta) > 1) scroll.scrollTo({ y: Math.max(0, scrollY.current + delta), animated: true });
        });
      });
    },
    [s, tv]
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => revealFocus(focus));
    return () => cancelAnimationFrame(frame);
  }, [focus, kind, pairing?.status, revealFocus]);

  const pick = async () => {
    try {
      const f = await pickTextFile();
      if (f) {
        setFile(f);
        if (!form.name) setForm((x) => ({ ...x, name: f.name.replace(/\.m3u8?$/i, '') }));
      }
    } catch (e: any) {
      setError(e?.message ?? 'Could not read the file');
    }
  };

  const save = async () => {
    setError(null);
    const f = { ...form };
    let type: PlaylistType = kind === 'xtream' ? 'xtream' : 'm3u';
    if (kind === 'm3u' && !/^https?:\/\//i.test(f.url.trim())) return setError('Enter a valid http(s) playlist URL.');
    if (kind === 'xtream' && (!f.server.trim() || !f.username.trim() || !f.password)) return setError('Server, username and password are required.');
    if (kind === 'file' && !file && !editing?.inline) return setError('Choose an .m3u file first.');
    const id = editing?.id ?? uid();
    const fallbackName =
      kind === 'xtream' ? (normalizeServer(f.server).replace(/^https?:\/\//, '').split(/[:/]/)[0] ?? 'Xtream') : kind === 'file' ? file?.name ?? 'Playlist' : (() => {
        try {
          return new URL(f.url).hostname;
        } catch {
          return 'Playlist';
        }
      })();
    const p: Playlist = {
      id,
      name: f.name.trim() || fallbackName,
      type,
      url: kind === 'm3u' ? f.url.trim() : undefined,
      inline: kind === 'file' ? true : undefined,
      server: kind === 'xtream' ? normalizeServer(f.server) : undefined,
      username: kind === 'xtream' ? f.username.trim() : undefined,
      password: kind === 'xtream' ? f.password : undefined,
      epgUrl: f.epgUrl.trim() || undefined,
      userAgent: f.userAgent.trim() || undefined,
      createdAt: editing?.createdAt ?? Date.now(),
    };
    if (kind === 'file' && file) await setItem('m3u:' + id, file.text);
    if (editing) {
      updatePlaylist(p);
      await useLibrary.getState().clearCache(id);
      if (useSettings.getState().activeId === id) void useLibrary.getState().load(p, { force: true });
      showToast('Playlist updated');
    } else {
      addPlaylist(p);
      showToast('Playlist added');
    }
    close();
  };

  const activate = (i: number) => {
    const it = items[i];
    if (!it) return;
    if (it.kind === 'pair') return void startPairing();
    if (it.kind === 'file') return void pick();
    if (it.kind === 'field') return inputs.current[it.field.id]?.focus();
    if (it.kind === 'save') return void save();
    if (it.kind === 'cancel') return close();
  };

  useKeys(
    (e) => {
      if (e.key === 'up') return setFocus((f) => Math.max(0, f - 1));
      if (e.key === 'down') return setFocus((f) => Math.min(items.length - 1, f + 1));
      if (e.key === 'left' || e.key === 'right') {
        const it = items[focus];
        if (it?.kind === 'tabs') {
          const i = kinds.indexOf(kind);
          setKind(kinds[Math.max(0, Math.min(kinds.length - 1, i + (e.key === 'left' ? -1 : 1)))]);
        } else if (it?.kind === 'save' && e.key === 'right') setFocus(focus + 1);
        else if (it?.kind === 'cancel' && e.key === 'left') setFocus(focus - 1);
        return;
      }
      if (e.key === 'select') return activate(focus);
      if (e.key === 'back') return close();
      return;
    },
    !sheetOpen,
    Layer.dialog
  );

  const focusedItem = items[focus];
  const pairIdx = items.findIndex((i) => i.kind === 'pair');
  const tabsIdx = items.findIndex((i) => i.kind === 'tabs');
  const fileIdx = items.findIndex((i) => i.kind === 'file');
  const saveIdx = items.findIndex((i) => i.kind === 'save');

  return (
    <View ref={viewportRef} collapsable={false} style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]}>
      <ScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        onScroll={(e) => {
          scrollY.current = e.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        contentContainerStyle={{
          paddingHorizontal: tv ? s(24) : 20,
          paddingTop: tv ? s(16) : 24 + insets.top,
          paddingBottom: tv ? s(16) : 24 + insets.bottom,
          maxWidth: tv ? s(920) : 560,
          width: '100%',
          alignSelf: 'center',
        }}
      >
        <Text style={{ color: colors.text, fontSize: tv ? k(22) : k(24), fontWeight: '800', letterSpacing: -0.3, fontFamily: fonts.regular }}>{editing ? 'Edit playlist' : 'Add playlist'}</Text>
        <Text style={{ color: colors.muted, fontSize: tv ? k(11) : k(12), marginTop: k(2), marginBottom: tv ? k(9) : k(16) }}>
          Nova doesn't provide any channels — add the M3U link or Xtream Codes login from your IPTV provider.
        </Text>

        <View style={{ flexDirection: tv ? 'row' : 'column', alignItems: tv ? 'flex-start' : 'stretch', justifyContent: 'center' }}>
          {canPair && pairing ? (
            <View
              ref={(r) => {
                focusRefs.current[pairIdx] = r;
              }}
              collapsable={false}
              style={{ width: tv ? s(205) : '100%', marginRight: tv ? s(16) : 0, marginBottom: tv ? 0 : k(14) }}
            >
              <Focusable
                focused={focusedItem?.kind === 'pair'}
                onPress={startPairing}
                accessibilityLabel={pairing.status === 'ready' ? 'Phone setup QR code. Select for a new code.' : 'Start phone setup'}
                style={{
                  alignItems: 'center',
                  padding: tv ? k(9) : k(12),
                  borderRadius: k(12),
                  borderWidth: 2,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                }}
                focusStyle={{ borderColor: colors.focus, backgroundColor: colors.focus }}
              >
                {({ focused }) => (
                  <>
                    {pairing.status === 'ready' ? (
                      <View style={{ padding: k(6), borderRadius: k(8), backgroundColor: colors.focus }}>
                        <QRCode value={pairing.url} size={tv ? k(96) : k(112)} color={colors.focusText} backgroundColor={colors.focus} />
                      </View>
                    ) : (
                      <View style={{ width: tv ? k(108) : k(126), height: tv ? k(108) : k(126), borderRadius: k(9), alignItems: 'center', justifyContent: 'center', backgroundColor: focused ? colors.surface2 : colors.bgElevated }}>
                        <Icon
                          name={pairing.status === 'received' ? 'check-circle-outline' : pairing.status === 'error' ? 'refresh' : 'qrcode-scan'}
                          size={k(40)}
                          color={pairing.status === 'received' ? colors.success : focused ? colors.focusText : colors.accent}
                        />
                      </View>
                    )}
                    <View style={{ width: '100%', marginTop: k(8) }}>
                      <Text style={{ color: focused ? colors.focusText : colors.text, fontSize: k(14), fontWeight: '800', textAlign: 'center' }}>
                        {pairing.status === 'received' ? 'Details received' : pairing.status === 'error' ? 'Phone setup unavailable' : 'Set up with your phone'}
                      </Text>
                      <Text style={{ color: focused ? colors.focusDim : colors.textDim, fontSize: k(10.5), lineHeight: k(14), marginTop: k(4), textAlign: 'center' }}>
                        {pairing.status === 'ready'
                          ? 'Scan, enter the playlist details, then review and save them here.'
                          : pairing.status === 'received'
                            ? 'Review the fields, then choose Add playlist.'
                            : pairing.status === 'error'
                              ? pairing.message
                              : 'Creating a private one-time code…'}
                      </Text>
                      <Text style={{ color: focused ? colors.focusDim : colors.muted, fontSize: k(9.5), marginTop: k(6), textAlign: 'center' }}>
                        {pairing.status === 'ready' ? 'Same trusted Wi-Fi · 10 minutes' : pairing.status === 'error' ? 'Press OK to try again' : 'Credentials stay on your network'}
                      </Text>
                    </View>
                  </>
                )}
              </Focusable>
            </View>
          ) : null}

          <View style={{ flex: tv ? 1 : undefined, width: tv ? undefined : '100%', maxWidth: tv ? s(650) : undefined }}>
            <View
              ref={(r) => {
                focusRefs.current[tabsIdx] = r;
              }}
              collapsable={false}
              style={{ flexDirection: 'row', backgroundColor: colors.surface, borderRadius: k(10), padding: tv ? k(3) : k(4), borderWidth: 2, borderColor: focusedItem?.kind === 'tabs' ? colors.focus : 'transparent' }}
            >
              {kinds.map((kd) => (
                <Focusable
                  key={kd}
                  focused={false}
                  onPress={() => setKind(kd)}
                  style={{ flex: 1, height: tv ? k(28) : k(34), borderRadius: k(8), alignItems: 'center', justifyContent: 'center', backgroundColor: kd === kind ? colors.surface3 : 'transparent' }}
                >
                  <Text style={{ color: kd === kind ? colors.text : colors.textDim, fontWeight: '700', fontSize: tv ? k(11) : k(12) }}>
                    {kd === 'm3u' ? 'M3U URL' : kd === 'xtream' ? 'Xtream Codes' : 'M3U file'}
                  </Text>
                </Focusable>
              ))}
            </View>

            {kind === 'file' ? (
              <View
                ref={(r) => {
                  focusRefs.current[fileIdx] = r;
                }}
                collapsable={false}
                style={{ marginTop: tv ? k(7) : k(14) }}
              >
                <Focusable
                  focused={focusedItem?.kind === 'file'}
                  onPress={pick}
                  style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: k(12), height: tv ? k(38) : undefined, paddingVertical: tv ? 0 : k(14), borderRadius: k(10), borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border, backgroundColor: colors.surface }}
                  focusStyle={{ borderColor: colors.focus, borderStyle: 'solid' }}
                >
                  <Icon name="file-upload-outline" size={k(20)} color={colors.accent} />
                  <Text style={{ color: colors.text, marginLeft: k(9), fontSize: tv ? k(11.5) : k(13), fontWeight: '600', flex: 1 }} numberOfLines={1}>
                    {file ? file.name : editing?.inline ? 'Using the imported file — choose another to replace' : 'Choose .m3u file'}
                  </Text>
                </Focusable>
              </View>
            ) : null}

            {fields.map((f) => {
              const idx = items.findIndex((i) => i.kind === 'field' && i.field.id === f.id);
              const focused = focus === idx;
              return (
                <View
                  key={f.id}
                  ref={(r) => {
                    focusRefs.current[idx] = r;
                  }}
                  collapsable={false}
                  style={{ marginTop: tv ? k(7) : k(14) }}
                >
                  <Text style={{ color: colors.textDim, fontSize: tv ? k(10.5) : k(11.5), fontWeight: '600', marginBottom: tv ? k(3) : k(6) }}>
                    {f.label}
                    {f.optional ? <Text style={{ color: colors.muted, fontWeight: '400' }}>  optional</Text> : null}
                  </Text>
                  <Focusable
                    focused={focused}
                    onPress={() => {
                      setFocus(idx);
                      revealFocus(idx);
                      inputs.current[f.id]?.focus();
                    }}
                    style={{ borderRadius: k(8), borderWidth: 2, borderColor: 'transparent', backgroundColor: colors.surface2 }}
                    focusStyle={{ borderColor: colors.focus }}
                  >
                    <TextInput
                      ref={(r) => {
                        inputs.current[f.id] = r;
                      }}
                      value={form[f.id]}
                      onChangeText={(v) => setForm((x) => ({ ...x, [f.id]: v }))}
                      onFocus={() => {
                        setFocus(idx);
                        revealFocus(idx);
                      }}
                      placeholder={f.placeholder}
                      placeholderTextColor={colors.muted}
                      secureTextEntry={f.secure}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType={f.id === 'url' || f.id === 'server' || f.id === 'epgUrl' ? 'url' : 'default'}
                      returnKeyType="next"
                      onSubmitEditing={() => setFocus(Math.min(items.length - 1, idx + 1))}
                      style={{ color: colors.text, fontSize: tv ? k(12) : k(13.5), paddingHorizontal: k(11), height: tv ? k(32) : k(40), fontFamily: fonts.regular, outlineStyle: 'none' } as any}
                      testID={`field-${f.id}`}
                    />
                  </Focusable>
                </View>
              );
            })}

            {error ? <Text style={{ color: colors.live, fontSize: tv ? k(11) : k(12.5), marginTop: tv ? k(7) : k(14) }}>{error}</Text> : null}

            <View
              ref={(r) => {
                focusRefs.current[saveIdx] = r;
                focusRefs.current[saveIdx + 1] = r;
              }}
              collapsable={false}
              style={{ flexDirection: 'row', gap: k(10), marginTop: tv ? k(12) : k(22) }}
            >
              <Button label={editing ? 'Save' : 'Add playlist'} icon="check" primary focused={focus === saveIdx} onPress={save} testID="editor-save" />
              <Button label="Cancel" focused={focus === saveIdx + 1} onPress={close} />
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
