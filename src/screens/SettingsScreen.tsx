import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Platform, Text, TextInput, View } from 'react-native';
import { colors, fonts, useLayout } from '../theme';
import { useSettings, type Prefs } from '../store/settings';
import { useLibrary } from '../store/library';
import { useUI } from '../store/ui';
import { usePlayer } from '../store/player';
import { useKeys, type KeyEvt } from '../input/keys';
import { Focusable } from '../components/Focusable';
import { Icon } from '../components/Icon';
import type { Playlist } from '../types';
import { formatDay, formatClock } from '../utils/format';
import { DEFAULT_UA } from '../services/http';

type Row =
  | { kind: 'header'; label: string }
  | { kind: 'item'; id: string; label: string; value?: string; icon: string; detail?: string; run: () => void; toggle?: boolean; on?: boolean };

const cycle = <T,>(list: T[], v: T) => list[(list.indexOf(v) + 1) % list.length];

export function SettingsScreen() {
  const { s, mode } = useLayout();
  const tv = mode === 'tv';
  const k = tv ? s : (n: number) => n * 1.1;
  const playlists = useSettings((st) => st.playlists);
  const activeId = useSettings((st) => st.activeId);
  const prefs = useSettings((st) => st.prefs);
  const setPrefs = useSettings((st) => st.setPrefs);
  const setActive = useSettings((st) => st.setActive);
  const removePlaylist = useSettings((st) => st.removePlaylist);
  const hidden = useSettings((st) => (activeId ? st.hiddenGroups[activeId] : undefined));
  const account = useLibrary((st) => st.account);
  const epgFetchedAt = useLibrary((st) => st.epgFetchedAt);
  const epgStatus = useLibrary((st) => st.epgStatus);
  const channelsCount = useLibrary((st) => st.channels.length);
  const menuFocused = useUI((st) => st.menuFocused);
  const openSheet = useUI((st) => st.openSheet);
  const openEditor = useUI((st) => st.openEditor);
  const editorOpen = useUI((st) => !!st.editor);
  const showToast = useUI((st) => st.showToast);
  const [idx, setIdx] = useState(0);
  const [uaEditing, setUaEditing] = useState(false);
  const uaRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<Row>>(null);

  const active = playlists.find((p) => p.id === activeId) ?? playlists[0];

  const playlistSheet = (p: Playlist) =>
    openSheet({
      title: p.name,
      subtitle: p.type === 'xtream' ? `Xtream Codes · ${p.server}` : p.type === 'demo' ? 'Built-in demo' : p.inline ? 'Imported M3U file' : p.url,
      options: [
        ...(p.id !== active?.id ? [{ label: 'Use this playlist', icon: 'check-circle-outline', onSelect: () => (usePlayer.getState().stop(), setActive(p.id)) }] : []),
        {
          label: 'Refresh now',
          icon: 'refresh',
          onSelect: () => {
            if (p.id !== active?.id) setActive(p.id);
            else void useLibrary.getState().load(p, { force: true });
            showToast('Refreshing playlist…');
          },
        },
        ...(p.type !== 'demo' ? [{ label: 'Edit', icon: 'pencil-outline', onSelect: () => openEditor(p) }] : []),
        {
          label: 'Delete',
          icon: 'delete-outline',
          destructive: true,
          onSelect: () =>
            openSheet({
              title: `Delete “${p.name}”?`,
              subtitle: 'Favorites and history for this playlist will be removed too.',
              options: [
                {
                  label: 'Delete',
                  icon: 'delete-outline',
                  destructive: true,
                  onSelect: () => {
                    usePlayer.getState().stop();
                    void useLibrary.getState().clearCache(p.id);
                    removePlaylist(p.id);
                  },
                },
                { label: 'Cancel', icon: 'close', onSelect: () => {} },
              ],
            }),
        },
      ],
    });

  const pickNumber = (title: string, key: keyof Prefs, values: number[], unit: string) =>
    openSheet({
      title,
      options: values.map((v) => ({ label: `${v} ${unit}${v === 1 ? '' : 's'}`, selected: prefs[key] === v, onSelect: () => setPrefs({ [key]: v } as Partial<Prefs>) })),
    });

  const rows: Row[] = useMemo(() => {
    const r: Row[] = [{ kind: 'header', label: 'Playlists' }];
    for (const p of playlists) {
      r.push({
        kind: 'item',
        id: 'pl:' + p.id,
        label: p.name,
        icon: p.id === active?.id ? 'playlist-check' : 'playlist-play',
        value: p.id === active?.id ? 'Active' : undefined,
        detail: p.type === 'xtream' ? 'Xtream Codes' : p.type === 'demo' ? 'Demo' : p.inline ? 'M3U file' : 'M3U URL',
        run: () => playlistSheet(p),
      });
    }
    r.push({ kind: 'item', id: 'add', label: 'Add playlist', icon: 'plus-circle-outline', run: () => openEditor() });
    if (account) {
      r.push({
        kind: 'item',
        id: 'account',
        label: 'Subscription',
        icon: 'account-circle-outline',
        value: account.expDate ? `Expires ${formatDay(account.expDate)} ${new Date(account.expDate).getFullYear()}` : account.status ?? 'Active',
        detail: account.maxConnections ? `${account.activeConnections ?? 0} of ${account.maxConnections} connections in use` : undefined,
        run: () => {},
      });
    }

    r.push({ kind: 'header', label: 'TV Guide' });
    r.push({
      kind: 'item',
      id: 'epg',
      label: 'Update TV guide now',
      icon: 'calendar-refresh',
      value: epgStatus === 'loading' ? 'Updating…' : epgFetchedAt ? `Updated ${formatDay(epgFetchedAt)} ${formatClock(epgFetchedAt, prefs.clock24)}` : undefined,
      run: () => {
        void useLibrary.getState().refreshEpg(true);
        showToast('Updating TV guide…');
      },
    });
    r.push({ kind: 'item', id: 'past', label: 'Keep past programmes', icon: 'history', value: `${prefs.epgPastDays} days`, run: () => pickNumber('Keep past programmes', 'epgPastDays', [1, 2, 3, 5, 7], 'day') });
    r.push({ kind: 'item', id: 'future', label: 'Load future programmes', icon: 'calendar-arrow-right', value: `${prefs.epgFutureDays} days`, run: () => pickNumber('Load future programmes', 'epgFutureDays', [1, 2, 3, 5, 7], 'day') });
    r.push({ kind: 'item', id: 'refresh', label: 'Auto-update every', icon: 'update', value: `${prefs.epgRefreshHours} hours`, run: () => pickNumber('Auto-update guide every', 'epgRefreshHours', [6, 12, 24, 48], 'hour') });

    r.push({ kind: 'header', label: 'Playback' });
    r.push({
      kind: 'item',
      id: 'format',
      label: 'Live stream format',
      icon: 'video-outline',
      detail: 'Xtream Codes playlists',
      value: prefs.streamFormat === 'auto' ? 'Automatic' : prefs.streamFormat === 'ts' ? 'MPEG-TS' : 'HLS',
      run: () => setPrefs({ streamFormat: cycle(['auto', 'ts', 'm3u8'] as const, prefs.streamFormat) as Prefs['streamFormat'] }),
    });
    r.push({ kind: 'item', id: 'preview', label: 'Preview in TV guide', icon: 'picture-in-picture-top-right', toggle: true, on: prefs.previewInGuide, run: () => setPrefs({ previewInGuide: !prefs.previewInGuide }) });
    r.push({ kind: 'item', id: 'autostart', label: 'Start with last channel', icon: 'play-box-outline', toggle: true, on: prefs.startWithLastChannel, run: () => setPrefs({ startWithLastChannel: !prefs.startWithLastChannel }) });
    r.push({ kind: 'item', id: 'ua', label: 'User-Agent', icon: 'badge-account-horizontal-outline', value: prefs.userAgent ? 'Custom' : 'Default', detail: prefs.userAgent || DEFAULT_UA, run: () => setUaEditing(true) });

    r.push({ kind: 'header', label: 'Interface' });
    r.push({ kind: 'item', id: 'clock', label: '24-hour clock', icon: 'clock-outline', toggle: true, on: prefs.clock24, run: () => setPrefs({ clock24: !prefs.clock24 }) });
    r.push({ kind: 'item', id: 'numbers', label: 'Show channel numbers', icon: 'numeric', toggle: true, on: prefs.showChannelNumbers, run: () => setPrefs({ showChannelNumbers: !prefs.showChannelNumbers }) });
    if (hidden?.length && activeId) {
      r.push({
        kind: 'item',
        id: 'unhide',
        label: 'Show hidden groups',
        icon: 'eye-outline',
        value: `${hidden.length} hidden`,
        run: () => useSettings.setState((st) => ({ hiddenGroups: { ...st.hiddenGroups, [activeId]: [] } })),
      });
    }

    r.push({ kind: 'header', label: 'About' });
    r.push({
      kind: 'item',
      id: 'about',
      label: 'Nova IPTV 1.1',
      icon: 'information-outline',
      value: Platform.OS === 'web' ? 'Web' : Platform.isTV ? 'Android TV' : Platform.OS === 'ios' ? 'iOS' : 'Android',
      detail: `${channelsCount} channels loaded`,
      run: () => {},
    });
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlists, active?.id, account, epgStatus, epgFetchedAt, prefs, hidden, activeId, channelsCount]);

  const items = rows.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'item');
  const rowPos = items[idx]?.i ?? 0;
  const rowH = tv ? s(44) : 56;
  const headerH = tv ? s(34) : 40;
  const offsets = useMemo(() => {
    const o: number[] = [];
    let y = 0;
    for (const r of rows) {
      o.push(y);
      y += r.kind === 'header' ? headerH : rowH;
    }
    return o;
  }, [rows, rowH, headerH]);

  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: Math.max(0, offsets[rowPos] - rowH * 3), animated: true });
  }, [rowPos, offsets, rowH]);
  useEffect(() => {
    if (idx >= items.length) setIdx(Math.max(0, items.length - 1));
  }, [items.length, idx]);
  useEffect(() => {
    if (uaEditing) setTimeout(() => uaRef.current?.focus(), 50);
  }, [uaEditing]);

  const onKey = (e: KeyEvt): boolean | void => {
    if (uaEditing) {
      if (e.key === 'back') return setUaEditing(false);
      if (e.key === 'select') return uaRef.current?.focus();
      return;
    }
    switch (e.key) {
      case 'up':
        return setIdx((i) => Math.max(0, i - 1));
      case 'down':
        return setIdx((i) => Math.min(items.length - 1, i + 1));
      case 'select': {
        const r = items[idx]?.r;
        if (r && r.kind === 'item') r.run();
        return;
      }
      case 'left':
      case 'back':
        return false;
      default:
        return;
    }
  };
  useKeys(onKey, !menuFocused && !editorOpen);

  return (
    <View style={{ flex: 1 }}>
      <Text style={{ color: colors.text, fontSize: k(22), fontWeight: '800', paddingHorizontal: tv ? s(22) : 16, paddingTop: tv ? s(18) : 14, paddingBottom: tv ? s(6) : 4 }}>Settings</Text>
      {uaEditing ? (
        <View style={{ marginHorizontal: tv ? s(22) : 16, marginBottom: 10, padding: k(12), backgroundColor: colors.surface, borderRadius: k(10), borderWidth: 1, borderColor: colors.border }}>
          <Text style={{ color: colors.textDim, fontSize: k(11.5), marginBottom: k(6) }}>Custom User-Agent (leave empty for default) — press Enter to save</Text>
          <TextInput
            ref={uaRef}
            defaultValue={prefs.userAgent}
            placeholder={DEFAULT_UA}
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={(ev) => {
              setPrefs({ userAgent: ev.nativeEvent.text.trim() });
              setUaEditing(false);
            }}
            onBlur={() => setUaEditing(false)}
            style={{ color: colors.text, fontSize: k(13), height: k(38), paddingHorizontal: k(10), backgroundColor: colors.surface2, borderRadius: k(8), fontFamily: fonts.regular, outlineStyle: 'none' } as any}
          />
        </View>
      ) : null}
      <FlatList
        ref={listRef}
        data={rows}
        keyExtractor={(r, i) => (r.kind === 'header' ? 'h' + r.label : r.id) + i}
        contentContainerStyle={{ paddingHorizontal: tv ? s(18) : 12, paddingBottom: 40, maxWidth: tv ? s(700) : undefined }}
        getItemLayout={(_d, i) => ({ length: rows[i]?.kind === 'header' ? headerH : rowH, offset: offsets[i] ?? 0, index: i })}
        renderItem={({ item: r, index }) =>
          r.kind === 'header' ? (
            <View style={{ height: headerH, justifyContent: 'flex-end', paddingBottom: k(6), paddingLeft: k(10) }}>
              <Text style={{ color: colors.accent, fontSize: k(11), fontWeight: '800', letterSpacing: 1 }}>{r.label.toUpperCase()}</Text>
            </View>
          ) : (
            <Focusable
              focused={index === rowPos}
              onPress={() => {
                setIdx(items.findIndex((x) => x.i === index));
                r.run();
              }}
              style={{ height: rowH - k(4), marginBottom: k(4), borderRadius: k(8), flexDirection: 'row', alignItems: 'center', paddingHorizontal: k(12), backgroundColor: colors.surface }}
              focusStyle={{ backgroundColor: colors.focus }}
            >
              {({ focused }) => (
                <>
                  <Icon name={r.icon} size={k(18)} color={focused ? colors.focusText : colors.textDim} />
                  <View style={{ flex: 1, marginLeft: k(12) }}>
                    <Text numberOfLines={1} style={{ color: focused ? colors.focusText : colors.text, fontSize: k(13), fontWeight: '600' }}>
                      {r.label}
                    </Text>
                    {r.detail ? (
                      <Text numberOfLines={1} style={{ color: focused ? '#3A4252' : colors.muted, fontSize: k(10.5), marginTop: 1 }}>
                        {r.detail}
                      </Text>
                    ) : null}
                  </View>
                  {r.toggle ? (
                    <View style={{ width: k(34), height: k(20), borderRadius: k(10), backgroundColor: r.on ? colors.accent : focused ? '#C9CFD9' : colors.surface3, justifyContent: 'center', paddingHorizontal: k(2) }}>
                      <View style={{ width: k(16), height: k(16), borderRadius: k(8), backgroundColor: '#fff', alignSelf: r.on ? 'flex-end' : 'flex-start' }} />
                    </View>
                  ) : r.value ? (
                    <Text numberOfLines={1} style={{ color: focused ? '#3A4252' : colors.textDim, fontSize: k(11.5), maxWidth: '45%' }}>
                      {r.value}
                    </Text>
                  ) : null}
                </>
              )}
            </Focusable>
          )
        }
      />
    </View>
  );
}
