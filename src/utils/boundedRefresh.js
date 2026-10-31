export const CAMERA_REQUEST_TIMEOUT_MS = 30000;

export function createBoundedRefresh(request, { onResult, onError, onLoading = () => {} }) {
  let active = null;
  let stopped = false;

  const finish = (attempt) => {
    clearTimeout(attempt.timer);
    if (stopped || active !== attempt) return false;
    active = null;
    onLoading(false);
    return true;
  };

  return {
    refresh() {
      if (stopped || active) return;
      const attempt = { controller: new AbortController(), timer: null };
      active = attempt;
      onLoading(true);
      attempt.timer = setTimeout(() => {
        if (!finish(attempt)) return;
        attempt.controller.abort();
        onError(new Error('Request timed out after 30 seconds. Refresh will retry.'));
      }, CAMERA_REQUEST_TIMEOUT_MS);
      (async () => request(attempt.controller.signal))().then(result => {
        if (finish(attempt)) onResult(result);
      }, error => {
        if (finish(attempt)) onError(error);
      });
    },
    stop() {
      stopped = true;
      if (!active) return;
      clearTimeout(active.timer);
      active.controller.abort();
      active = null;
    },
  };
}
