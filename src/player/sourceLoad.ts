/** Native asset loading stays off the UI thread; only the latest request may play or report an error. */
export function createSourceLoader<T>(replace: (source: T) => Promise<void>) {
  let generation = 0;
  return {
    cancel: () => { generation++; },
    load: (source: T, ready: () => void, failed: () => void) => {
      const request = ++generation;
      // The native loader cancels superseded assets. Guard its asynchronous JS
      // completion too, including rejection after the surface has unmounted.
      return Promise.resolve().then(() => {
        if (generation === request) return replace(source);
      }).then(() => {
        if (generation === request) ready();
      }).catch(() => {
        if (generation === request) failed();
      });
    },
  };
}
