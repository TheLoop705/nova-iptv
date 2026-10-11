import { useCallback, useEffect, useRef, useState } from 'react';
import { readBrowsePosition, saveBrowsePosition } from '../services/browseMemory';

/** Keep a small snapshot on unmount, without subscribing renders to scroll events. */
export function useBrowseSession<T>(playlistId: string | undefined, section: string) {
  const [initial] = useState(() => readBrowsePosition<T>(playlistId, section));
  const latest = useRef(initial);
  useEffect(() => () => {
    if (latest.current !== undefined) saveBrowsePosition(playlistId, section, latest.current);
  }, [playlistId, section]);
  const remember = useCallback((value: T) => { latest.current = value; }, []);
  const update = useCallback((value: Partial<T>) => { latest.current = { ...latest.current, ...value } as T; }, []);
  return { saved: initial, remember, update };
}
