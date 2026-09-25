export type PlaylistType = 'm3u' | 'xtream' | 'demo';

export interface Playlist {
  id: string;
  name: string;
  type: PlaylistType;
  /** M3U playlist URL (m3u) */
  url?: string;
  /** Raw M3U text for playlists imported from a file */
  inline?: boolean;
  /** Xtream Codes credentials */
  server?: string;
  username?: string;
  password?: string;
  /** Optional XMLTV URL (overrides the one advertised by the playlist) */
  epgUrl?: string;
  userAgent?: string;
  createdAt: number;
}

export interface Catchup {
  type: string;
  days: number;
  source?: string;
}

export interface Channel {
  id: string;
  num: number;
  name: string;
  logo?: string;
  group: string;
  /** Direct stream URL. For Xtream this is built at play time from streamId. */
  url: string;
  tvgId?: string;
  tvgName?: string;
  streamId?: number;
  catchup?: Catchup;
  userAgent?: string;
}

export interface Program {
  start: number;
  end: number;
  title: string;
  desc?: string;
  category?: string;
}

export interface Category {
  id: string;
  name: string;
}

export interface VodItem {
  id: string;
  name: string;
  poster?: string;
  categoryId: string;
  url?: string;
  streamId?: number;
  ext?: string;
  rating?: string;
  year?: string;
  added?: number;
}

export interface SeriesItem {
  id: string;
  seriesId: number;
  name: string;
  poster?: string;
  categoryId: string;
  rating?: string;
  year?: string;
  plot?: string;
  genre?: string;
}

export interface Episode {
  id: string;
  title: string;
  season: number;
  episode: number;
  ext: string;
  plot?: string;
  duration?: string;
  image?: string;
  url: string;
}

export interface SeriesInfo {
  plot?: string;
  cast?: string;
  genre?: string;
  rating?: string;
  backdrop?: string;
  poster?: string;
  year?: string;
  seasons: { season: number; name: string; episodes: Episode[] }[];
}

export interface MovieInfo {
  plot?: string;
  cast?: string;
  director?: string;
  genre?: string;
  rating?: string;
  duration?: string;
  backdrop?: string;
  poster?: string;
  year?: string;
}

export interface Group {
  id: string;
  name: string;
  channelIds: string[];
  virtual?: boolean;
}

export type PlayItem =
  | { kind: 'live'; channelId: string }
  | { kind: 'catchup'; channelId: string; program: Program }
  | {
      kind: 'vod';
      key: string;
      title: string;
      subtitle?: string;
      url: string;
      poster?: string;
      userAgent?: string;
      /** next episode of a series, offered by the "Up next" countdown */
      next?: Omit<Extract<PlayItem, { kind: 'vod' }>, 'next'>;
    };
