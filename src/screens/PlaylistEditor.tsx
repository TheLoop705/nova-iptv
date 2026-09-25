import React, { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
  const scrollRef = useRef<ScrollView>(null);

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
  type Item = { kind: 'tabs' } | { kind: 'file' } | { kind: 'field'; field: Field } | { kind: 'save' } | { kind: 'cancel' };
  const items: Item[] = [
    { kind: 'tabs' },
    ...(kind === 'file' ? [{ kind: 'file' as const }] : []),
    ...fields.map((f) => ({ kind: 'field' as const, field: f })),
    { kind: 'save' },
    { kind: 'cancel' },
  ];
  const kinds: Kind[] = ['m3u', 'xtream', 'file'];

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
  const saveIdx = items.findIndex((i) => i.kind === 'save');

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]}>
      <ScrollView ref={scrollRef} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: tv ? s(32) : 20, paddingTop: tv ? s(28) : 24 + insets.top, paddingBottom: tv ? s(32) : 24 + insets.bottom, maxWidth: tv ? s(620) : 560, width: '100%', alignSelf: 'center' }}>
        <Text style={{ color: colors.text, fontSize: k(24), fontWeight: '800', letterSpacing: -0.3, fontFamily: fonts.regular }}>{editing ? 'Edit playlist' : 'Add playlist'}</Text>
        <Text style={{ color: colors.muted, fontSize: k(12), marginTop: k(4), marginBottom: k(16) }}>
          Nova doesn't provide any channels — add the M3U link or Xtream Codes login from your IPTV provider.
        </Text>

        <View style={{ flexDirection: 'row', backgroundColor: colors.surface, borderRadius: k(10), padding: k(4), borderWidth: 2, borderColor: focusedItem?.kind === 'tabs' ? colors.focus : 'transparent' }}>
          {kinds.map((kd) => (
            <Focusable
              key={kd}
              focused={false}
              onPress={() => setKind(kd)}
              style={{ flex: 1, height: k(34), borderRadius: k(8), alignItems: 'center', justifyContent: 'center', backgroundColor: kd === kind ? colors.surface3 : 'transparent' }}
            >
              <Text style={{ color: kd === kind ? colors.text : colors.textDim, fontWeight: '700', fontSize: k(12) }}>
                {kd === 'm3u' ? 'M3U URL' : kd === 'xtream' ? 'Xtream Codes' : 'M3U file'}
              </Text>
            </Focusable>
          ))}
        </View>

        {kind === 'file' ? (
          <Focusable
            focused={focusedItem?.kind === 'file'}
            onPress={pick}
            style={{ marginTop: k(14), flexDirection: 'row', alignItems: 'center', padding: k(14), borderRadius: k(10), borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border, backgroundColor: colors.surface }}
            focusStyle={{ borderColor: colors.focus, borderStyle: 'solid' }}
          >
            <Icon name="file-upload-outline" size={k(22)} color={colors.accent} />
            <Text style={{ color: colors.text, marginLeft: k(10), fontSize: k(13), fontWeight: '600', flex: 1 }} numberOfLines={1}>
              {file ? file.name : editing?.inline ? 'Using the imported file — choose another to replace' : 'Choose .m3u file'}
            </Text>
          </Focusable>
        ) : null}

        {fields.map((f) => {
          const idx = items.findIndex((i) => i.kind === 'field' && i.field.id === f.id);
          const focused = focus === idx;
          return (
            <View key={f.id} style={{ marginTop: k(14) }}>
              <Text style={{ color: colors.textDim, fontSize: k(11.5), fontWeight: '600', marginBottom: k(6) }}>
                {f.label}
                {f.optional ? <Text style={{ color: colors.muted, fontWeight: '400' }}>  optional</Text> : null}
              </Text>
              <Focusable
                focused={focused}
                onPress={() => {
                  setFocus(idx);
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
                  onFocus={() => setFocus(idx)}
                  placeholder={f.placeholder}
                  placeholderTextColor={colors.muted}
                  secureTextEntry={f.secure}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType={f.id === 'url' || f.id === 'server' || f.id === 'epgUrl' ? 'url' : 'default'}
                  returnKeyType="next"
                  onSubmitEditing={() => setFocus(Math.min(items.length - 1, idx + 1))}
                  style={{ color: colors.text, fontSize: k(13.5), paddingHorizontal: k(12), height: k(40), fontFamily: fonts.regular, outlineStyle: 'none' } as any}
                  testID={`field-${f.id}`}
                />
              </Focusable>
            </View>
          );
        })}

        {error ? <Text style={{ color: colors.live, fontSize: k(12.5), marginTop: k(14) }}>{error}</Text> : null}

        <View style={{ flexDirection: 'row', gap: k(10), marginTop: k(22) }}>
          <Button label={editing ? 'Save' : 'Add playlist'} icon="check" primary focused={focus === saveIdx} onPress={save} testID="editor-save" />
          <Button label="Cancel" focused={focus === saveIdx + 1} onPress={close} />
        </View>
      </ScrollView>
    </View>
  );
}
