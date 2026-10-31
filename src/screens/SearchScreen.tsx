import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { colors, fonts, radius, useLayout } from '../theme';
import { useLibrary } from '../store/library';
import { useSettings } from '../store/settings';
import { usePlayer } from '../store/player';
import { useUI, type MenuAnchor } from '../store/ui';
import { useKeyMode, useKeys, type KeyEvt } from '../input/keys';
import { Focusable } from '../components/Focusable';
import { Logo, Poster } from '../components/Logo';
import { Icon } from '../components/Icon';
import { programAt } from '../services/epg';
import { searchCatalog, type SearchHit, type SearchScope } from '../services/catalogSearch';
import { speechAvailable, startListening } from '../services/speech';
import { RemoteKeys } from '../../modules/remote-keys';
import { useBrowseSession } from '../utils/browseSession';
import { HoverTitle } from '../components/HoverTitle';
import { SectionStatus } from '../components/SectionStatus';

interface Result {
  key: string;
  type: 'channel' | 'movie' | 'series';
  title: string;
  subtitle?: string;
  image?: string;
  /** channels show what's on now, read by the row so guide data arriving doesn't redo the search */
  channelId?: string;
  run: () => void;
}

const scopes: { id: SearchScope; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'movie', label: 'Movies' },
  { id: 'series', label: 'Series' }, { id: 'channel', label: 'Live TV' },
];
const emptyCatalog = { channels: [], movies: {}, series: {} };
type Zone = 'input' | 'filters' | 'results' | 'retry';

export function SearchScreen() {
  const { s, mode } = useLayout();
  const tv = mode === 'tv';
  // stable, so the memoized result rows only redraw when their own focus changes
  const k = useMemo(() => (tv ? s : (n: number) => n * 1.1), [tv, s]);
  const channels = useLibrary((st) => st.channels);
  const playlistId = useLibrary((st) => st.playlistId);
  const sharedPlaylist = useSettings((st) => st.playlists.find((p) => p.id === playlistId)?.type === 'm3u');
  const { saved, remember, update } = useBrowseSession<{ q: string; scope?: SearchScope; zone: Zone; idx: number; key?: string; nonce: number; offset: number }>(playlistId, 'search');
  const libraryReady = useLibrary((st) => st.catalogStatus === 'ready');
  const movies = useLibrary((st) => st.movies);
  const series = useLibrary((st) => st.series);
  const pid = useLibrary((st) => st.playlistId);
  const history = useSettings((st) => (pid ? st.history[pid] : undefined));
  const vodStatus = useLibrary((st) => st.vodStatus);
  const channelStatus = useLibrary((st) => st.status);
  const loadAllVod = useLibrary((st) => st.loadAllVod);
  const menuFocused = useUI((st) => st.menuFocused);
  const detail = useUI((st) => st.detail);
  const sheetOpen = useUI((st) => !!st.sheet);
  const fullscreen = usePlayer((st) => st.fullscreen && !!st.item);
  const setDetail = useUI((st) => st.setDetail);
  const playChannel = usePlayer((st) => st.playChannel);
  const searchNonce = useUI((st) => st.searchNonce);
  const keyMode = useKeyMode();

  const [q, setQ] = useState(saved?.q ?? '');
  const [scope, setScope] = useState<SearchScope>(saved?.scope ?? 'all');
  const [filterIdx, setFilterIdx] = useState(() => scopes.findIndex((s) => s.id === (saved?.scope ?? 'all')));
  const [revision, setRevision] = useState(0);
  const [searchError, setSearchError] = useState(false);
  const [slow, setSlow] = useState(false);
  const needsChannels = scope === 'all' || scope === 'channel';
  const needsMovies = scope === 'all' || scope === 'movie';
  const needsSeries = scope === 'all' || scope === 'series';
  const searchChannels = needsChannels ? channels : emptyCatalog.channels;
  const searchMovies = needsMovies ? movies : emptyCatalog.movies;
  const searchSeries = needsSeries ? series : emptyCatalog.series;
  const loading = ((needsChannels || sharedPlaylist) && (channelStatus === 'loading' || channelStatus === 'idle'))
    || (needsMovies && vodStatus.allMovies === 'loading') || (needsSeries && vodStatus.allSeries === 'loading');
  const unavailable = searchError || ((needsChannels || sharedPlaylist) && channelStatus === 'error')
    || (needsMovies && vodStatus.allMovies === 'error') || (needsSeries && vodStatus.allSeries === 'error');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const stopVoice = useRef<(() => void) | null>(null);
  const canListen = useMemo(() => speechAvailable(), []);
  const [zone, setZone] = useState<Zone>(saved?.zone ?? 'input');
  const [idx, setIdx] = useState(saved?.idx ?? 0);
  const restoreKey = useRef(saved?.key);
  const offset = useRef(saved?.offset ?? 0);
  const inputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<Result>>(null);
  const keyboardTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const rowH = tv ? s(50) : 64;

  // Full catalogs load only when a query needs them; matching runs in cancellable slices.
  useEffect(() => {
    if (!libraryReady || q.trim().length < 2) return;
    if (scope === 'channel') return;
    const timer = setTimeout(() => void loadAllVod(scope === 'all' ? undefined : scope), 180);
    return () => clearTimeout(timer);
  }, [q, scope, playlistId, libraryReady, loadAllVod]);
  // Live data is lazy; channel rows subscribe separately to their programme.
  useEffect(() => {
    if (!needsChannels) return;
    useLibrary.getState().wantChannels();
    useLibrary.getState().wantEpg();
  }, [playlistId, needsChannels]);

  const refresh = () => {
    setRevision((n) => n + 1);
    if (needsChannels || sharedPlaylist) void useLibrary.getState().loadChannels({ force: true });
    if (scope !== 'channel') void loadAllVod(scope === 'all' ? undefined : scope, { force: true });
  };

  useEffect(() => {
    setSlow(false);
    if (q.trim().length < 2 || (!loading && !searching)) return;
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [q, scope, loading, searching]);

  const searchedQuery = useRef('');
  useEffect(() => {
    const identity = scope + ':' + q;
    if (searchedQuery.current !== identity) setHits([]);
    searchedQuery.current = identity;
    setSearchError(false);
    if (q.trim().length < 2) {
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      void searchCatalog(q, { channels: searchChannels, movies: searchMovies, series: searchSeries }, controller.signal, scope)
        .then((next) => {
          if (!controller.signal.aborted) {
            setHits(next);
            setSearching(false);
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setSearching(false);
            setSearchError(true);
            console.warn('Search failed', error);
          }
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, scope, revision, searchChannels, searchMovies, searchSeries]);

  // Voice-search shortcut (hold Menu / Search key / "/") and remote users: open the keyboard right away.
  // On Fire TV the open keyboard is what lets the remote's mic button dictate into the field.
  const focusInput = () => {
    setZone('input');
    const schedule = (run: () => void, ms: number) => {
      const timer = setTimeout(() => {
        keyboardTimers.current.delete(timer);
        run();
      }, ms);
      keyboardTimers.current.add(timer);
    };
    schedule(() => inputRef.current?.focus(), 120);
    // Focusing alone doesn't raise the Android TV keyboard, so ask for it explicitly — once now,
    // and again after the shortcut key (held Menu) has been released.
    if (Platform.OS === 'android') {
      for (const ms of [300, 900]) {
        schedule(() => {
          inputRef.current?.focus();
          RemoteKeys?.showKeyboard().catch(() => {});
        }, ms);
      }
    }
  };
  useEffect(() => {
    // Shortcut = new search: clear the old query so dictation doesn't append to it
    if (searchNonce > (saved?.nonce ?? 0)) {
      setQ('');
      focusInput();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchNonce]);
  useEffect(() => {
    if ((!saved?.q || saved.zone === 'input') && (Platform.isTV || keyMode || Platform.OS === 'web')) focusInput();
    return () => {
      stopVoice.current?.();
      keyboardTimers.current.forEach(clearTimeout);
      keyboardTimers.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleVoice = () => {
    if (listening) {
      stopVoice.current?.();
      setListening(false);
      return;
    }
    setVoiceError(null);
    setListening(true);
    stopVoice.current = startListening(
      (text) => setQ(text),
      (err) => {
        setListening(false);
        stopVoice.current = null;
        if (err) setVoiceError(err);
      }
    );
  };

  const lastEpisode = useMemo(() => {
    const watched = new Map<string, string>();
    for (const entry of history ?? []) {
      if (entry.kind === 'episode' && !watched.has(entry.series.id)) watched.set(entry.series.id, `Last watched S${entry.episode.season} E${entry.episode.episode}`);
    }
    return watched;
  }, [history]);
  const results = useMemo<Result[]>(() => hits.map((hit) => {
    const item = hit.item;
    if (hit.kind === 'channel') {
      const channel = hit.item;
      return {
        key: 'c' + channel.id, type: 'channel', title: channel.name,
        subtitle: channel.group, image: channel.logo, channelId: channel.id,
        run: () => playChannel(channel.id, { groupId: 'all', fullscreen: true }),
      };
    }
    return {
      key: (hit.kind === 'movie' ? 'm' : 's') + item.id,
      type: hit.kind, title: item.name, image: hit.item.poster,
      subtitle: [hit.kind === 'movie' ? 'Movie' : 'Series', hit.kind === 'series' ? lastEpisode.get(hit.item.id) ?? hit.item.year : hit.item.year].filter(Boolean).join(' · '),
      run: () => setDetail(hit.kind === 'movie' ? { kind: 'movie', item: hit.item } : { kind: 'series', item: hit.item }),
    };
  }), [hits, lastEpisode, playChannel, setDetail]);
  const previousQuery = useRef(q + ':' + scope);
  useEffect(() => {
    if (previousQuery.current === q + ':' + scope) return;
    previousQuery.current = q + ':' + scope;
    restoreKey.current = undefined;
    offset.current = 0;
    setIdx(0);
  }, [q, scope]);
  useEffect(() => {
    if (!results.length) return;
    const index = restoreKey.current ? results.findIndex((r) => r.key === restoreKey.current) : -1;
    if (index >= 0) restoreKey.current = undefined;
    setIdx((current) => index >= 0 ? index : Math.max(0, Math.min(current, results.length - 1)));
  }, [results]);
  remember({ q, scope, zone, idx, key: results[idx]?.key ?? restoreKey.current, nonce: searchNonce, offset: offset.current });
  const restoredScroll = useRef(false);
  useEffect(() => {
    if (!results.length || restoredScroll.current || !saved?.offset) return;
    const timer = setTimeout(() => {
      listRef.current?.scrollToOffset({ offset: saved.offset, animated: false });
      restoredScroll.current = true;
    }, 30);
    return () => clearTimeout(timer);
  }, [results.length, saved]);
  useEffect(() => {
    if (zone === 'results') listRef.current?.scrollToOffset({ offset: Math.max(0, (idx - 3) * rowH), animated: true });
  }, [idx, zone, rowH]);

  const resultMenu = useCallback((result: Result, anchor?: MenuAnchor) => {
    const pid = useLibrary.getState().playlistId;
    if (!pid || !result.channelId) return;
    const id = result.channelId;
    const favorite = useSettings.getState().favorites[pid]?.includes(id);
    useUI.getState().openSheet({
      title: result.title, subtitle: result.subtitle, anchor,
      options: [
        { label: 'Watch', icon: 'play-circle-outline', onSelect: result.run },
        { label: favorite ? 'Remove from favorites' : 'Add to favorites', icon: favorite ? 'star-off-outline' : 'star-outline',
          onSelect: () => {
            useSettings.getState().toggleFavorite(pid, id);
            useUI.getState().showToast(favorite ? 'Removed from favorites' : 'Added to Live TV → Favorites');
          } },
      ],
    });
  }, []);

  const chooseFilter = (index: number) => {
    setFilterIdx(index);
    setZone('filters');
    if (index === scopes.length) refresh();
    else setScope(scopes[index].id);
  };

  const onKey = (e: KeyEvt): boolean | void => {
    if (e.key === 'search') return focusInput();
    if (zone === 'retry') {
      if (e.key === 'select') { refresh(); return setZone(results.length ? 'results' : 'filters'); }
      if (e.key === 'down' && results.length) return setZone('results');
      if (e.key === 'up' || e.key === 'back') return setZone('filters');
      return false;
    }
    if (zone === 'input') {
      if (e.key === 'select') return inputRef.current?.focus();
      if (e.key === 'down') { inputRef.current?.blur(); return setZone('filters'); }
      if (e.key === 'left' || e.key === 'back') return false;
      return;
    }
    if (zone === 'filters') {
      if (e.key === 'left') { if (filterIdx === 0) return false; return setFilterIdx(filterIdx - 1); }
      if (e.key === 'right') return setFilterIdx(Math.min(scopes.length, filterIdx + 1));
      if (e.key === 'select') return chooseFilter(filterIdx);
      if (e.key === 'up' || e.key === 'back') return setZone('input');
      if (e.key === 'down') return setZone(unavailable ? 'retry' : results.length ? 'results' : 'filters');
      return;
    }
    switch (e.key) {
      case 'up':
        return idx === 0 ? setZone(unavailable ? 'retry' : 'filters') : setIdx(idx - 1);
      case 'down':
        return setIdx(Math.min(results.length - 1, idx + 1));
      case 'select':
        if (e.long && results[idx]?.channelId) return resultMenu(results[idx]);
        return results[idx]?.run();
      case 'menu':
        if (results[idx]?.channelId) return resultMenu(results[idx]);
        return;
      case 'back':
        return setZone('input');
      case 'left':
        return false;
      default:
        return;
    }
  };
  useKeys(onKey, !menuFocused && !detail && !sheetOpen && !fullscreen);

  const focusIdx = zone === 'results' ? idx : -1;
  const openResult = useCallback((result: Result, index: number) => {
    setIdx(index);
    setZone('results');
    result.run();
  }, []);
  const renderItem = useCallback(
    ({ item, index }: { item: Result; index: number }) => <ResultRow r={item} index={index} onOpen={openResult} onMenu={resultMenu} focused={index === focusIdx} rowH={rowH} k={k} />,
    [focusIdx, rowH, k, openResult, resultMenu]
  );

  return (
    <View style={{ flex: 1, padding: tv ? s(22) : 16 }}>
      <Text style={{ color: colors.text, fontSize: tv ? s(22) : 28, fontWeight: '800', letterSpacing: -0.3, fontFamily: fonts.regular, marginBottom: k(12) }}>Search</Text>
      <Focusable
        focused={zone === 'input'}
        onPress={() => inputRef.current?.focus()}
        style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface2, borderRadius: k(radius.md), paddingHorizontal: k(12), height: tv ? s(42) : 48, borderWidth: 2, borderColor: colors.border }}
        hoverStyle={{ borderColor: colors.borderStrong }}
        focusStyle={{ borderColor: colors.focus }}
      >
        <Icon name="magnify" size={k(18)} color={colors.textDim} />
        <TextInput
          ref={inputRef}
          value={q}
          onChangeText={setQ}
          placeholder={scope === 'all' ? 'Channels, movies, series…' : `Search ${scopes.find((s) => s.id === scope)?.label.toLowerCase()}…`}
          placeholderTextColor={colors.muted}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          onFocus={() => setZone('input')}
          onSubmitEditing={() => results.length && setZone('results')}
          style={{ flex: 1, color: colors.text, fontSize: k(14), marginLeft: k(8), height: '100%', fontFamily: fonts.regular, outlineStyle: 'none' } as any}
          testID="search-input"
        />
        {loading || searching ? <ActivityIndicator size="small" color={colors.accent} /> : null}
        {canListen ? (
          <Pressable
            focusable={false}
            onPress={toggleVoice}
            accessibilityLabel={listening ? 'Stop voice search' : 'Search by voice'}
            testID="search-mic"
            style={{ marginLeft: k(8), width: k(30), height: k(30), borderRadius: k(15), alignItems: 'center', justifyContent: 'center', backgroundColor: listening ? colors.liveFill : 'transparent' }}
          >
            <Icon name={listening ? 'microphone' : 'microphone-outline'} size={k(18)} color={listening ? colors.onLive : colors.textDim} />
          </Pressable>
        ) : null}
      </Focusable>
      <View style={{ flexDirection: 'row', gap: k(5), marginTop: k(10) }}>
        {[...scopes, { id: 'refresh', label: 'Refresh' }].map((option, index) => (
          <Focusable key={option.id} focused={zone === 'filters' && filterIdx === index}
            onPress={() => chooseFilter(index)} testID={`search-filter-${option.id}`} accessibilityLabel={option.label}
            style={{ paddingHorizontal: k(9), height: k(32), justifyContent: 'center', borderRadius: k(radius.pill), backgroundColor: scope === option.id ? colors.accentFill : colors.surface2 }}>
            {({ focused }) => option.id === 'refresh'
              ? <Icon name="refresh" size={k(16)} color={focused ? colors.focusText : colors.text} />
              : <Text style={{ fontSize: k(12), fontWeight: '700', color: focused ? colors.focusText : scope === option.id ? colors.onAccent : colors.text }}>{option.label}</Text>}
          </Focusable>
        ))}
      </View>
      {listening ? <Text style={{ color: colors.live, fontSize: k(12), marginTop: k(8), fontWeight: '600' }}>Listening… say a channel, movie or show</Text> : null}
      {voiceError ? <Text style={{ color: colors.star, fontSize: k(12), marginTop: k(8) }}>{voiceError}</Text> : null}
      {unavailable ? <SectionStatus label="Some search results unavailable" onRetry={refresh} focused={zone === 'retry'} testID="search-catalog-status" /> : null}
      {slow ? <Text style={{ color: colors.textDim, fontSize: k(12), marginTop: k(8) }}>Still searching… try one type to load less data. Available results appear below.</Text> : null}
      {scope === 'channel' ? <Text style={{ color: colors.textDim, fontSize: k(12), marginTop: k(8) }}>Menu or hold OK on a channel to add it to Live TV → Favorites.</Text> : null}

      {q.trim().length >= 2 && !results.length && !searching && !loading && !unavailable ? (
        <Text style={{ color: colors.muted, fontSize: k(13), marginTop: k(20) }}>No results for “{q.trim()}”.</Text>
      ) : null}
      {q.trim().length < 2 && !listening ? <VoiceHint k={k} canListen={canListen} /> : null}

      <FlatList
        ref={listRef}
        data={results}
        keyExtractor={(r) => r.key}
        style={{ marginTop: k(12) }}
        keyboardShouldPersistTaps="handled"
        getItemLayout={(_d, i) => ({ length: rowH, offset: rowH * i, index: i })}
        renderItem={renderItem}
        extraData={renderItem}
        initialNumToRender={tv ? 10 : 12}
        maxToRenderPerBatch={8}
        windowSize={5}
        removeClippedSubviews={Platform.OS === 'android'}
        onScroll={(e) => { offset.current = e.nativeEvent.contentOffset.y; update({ offset: offset.current }); }}
        scrollEventThrottle={64}
      />
    </View>
  );
}

/** One result. Memoized, so moving the focus redraws two rows instead of the whole list. */
const ResultRow = memo(function ResultRow({ r, index, onOpen, onMenu, focused, rowH, k }: { r: Result; index: number; onOpen: (r: Result, index: number) => void; onMenu: (r: Result, anchor?: MenuAnchor) => void; focused: boolean; rowH: number; k: (n: number) => number }) {
  const pid = useLibrary((s) => s.playlistId);
  const favorite = useSettings((s) => !!(pid && r.channelId && s.favorites[pid]?.includes(r.channelId)));
  return (
    <Focusable
      focused={focused}
      onPress={() => onOpen(r, index)}
      onLongPress={r.channelId ? () => onMenu(r) : undefined}
      onContextMenu={r.channelId ? (anchor) => onMenu(r, anchor) : undefined}
      style={{ height: rowH - k(4), marginBottom: k(4), borderRadius: k(radius.md), flexDirection: 'row', alignItems: 'center', paddingHorizontal: k(10), backgroundColor: colors.surface }}
      focusStyle={{ backgroundColor: colors.focus }}
    >
      {({ focused: f, hovered }) => (
        <>
          {r.type === 'channel' ? (
            <Logo uri={r.image} name={r.title} size={k(26)} />
          ) : (
            <View style={{ width: k(42), alignItems: 'center' }}>
              <Poster uri={r.image} name={r.title} width={k(28)} />
            </View>
          )}
          <View style={{ flex: 1, marginLeft: k(12) }}>
            <HoverTitle text={r.title} active={hovered || f} style={{ color: f ? colors.focusText : colors.text, fontWeight: '700', fontSize: k(13) }} />
            {r.channelId ? <NowLine channelId={r.channelId} fallback={r.subtitle} focused={f} k={k} /> : r.subtitle ? <Subtitle text={r.subtitle} focused={f} k={k} /> : null}
          </View>
          <Icon name={favorite ? 'star' : r.type === 'channel' ? 'television-classic' : r.type === 'movie' ? 'movie-open-outline' : 'television-play'} size={k(16)} color={f ? colors.focusText : favorite ? colors.star : colors.muted} />
        </>
      )}
    </Focusable>
  );
});

function Subtitle({ text, focused, k }: { text: string; focused: boolean; k: (n: number) => number }) {
  return (
    <Text numberOfLines={1} style={{ color: focused ? colors.focusDim : colors.muted, fontSize: k(11.5), marginTop: 2 }}>
      {text}
    </Text>
  );
}

/** A channel result's "Now: …", once the guide has it (the group until then). */
function NowLine({ channelId, fallback, focused, k }: { channelId: string; fallback?: string; focused: boolean; k: (n: number) => number }) {
  const now = useLibrary((st) => programAt(st.epg[channelId], Date.now())?.title);
  const text = now ? `Now: ${now}` : fallback;
  return text ? <Subtitle text={text} focused={focused} k={k} /> : null;
}

/** How to search by voice on this device. */
function VoiceHint({ k, canListen }: { k: (n: number) => number; canListen: boolean }) {
  const tip = (icon: string, text: string) => (
    <View key={text} style={{ flexDirection: 'row', alignItems: 'flex-start', marginTop: k(10) }}>
      <Icon name={icon} size={k(16)} color={colors.accent} style={{ marginTop: k(1), marginRight: k(10) }} />
      <Text style={{ flex: 1, color: colors.textDim, fontSize: k(12.5), lineHeight: k(18) }}>{text}</Text>
    </View>
  );
  let tips: React.ReactNode[];
  if (Platform.OS === 'android' && Platform.isTV) {
    tips = [
      tip('microphone', 'Voice search: while the keyboard is open, press and hold the microphone button on your remote and say a channel, movie or show.'),
      tip('menu', 'Shortcut: hold the ☰ Menu button anywhere in Nova to jump straight here with the keyboard open.'),
    ];
  } else if (Platform.OS === 'web') {
    tips = [
      canListen
        ? tip('microphone', 'Click the microphone to search by voice.')
        : tip('microphone-off', 'Voice search in the browser needs HTTPS (or localhost). On a plain http:// address, type instead.'),
      tip('keyboard-outline', 'Press / anywhere in Nova to jump straight here.'),
    ];
  } else {
    tips = [tip('microphone', 'Tap the microphone on your keyboard to search by voice.')];
  }
  return (
    <View style={{ marginTop: k(14), padding: k(14), borderRadius: k(10), backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
      <Text style={{ color: colors.text, fontSize: k(13), fontWeight: '700' }}>Search channels, movies and series</Text>
      {tips}
    </View>
  );
}
