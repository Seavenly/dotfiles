export function createProjectionWatcher({
  initialProjection,
  close,
  readProjection = null,
  pollInterval = 100,
  unrefPollTimer = false,
}) {
  const queue = [];
  const waiters = [];
  let closed = false;
  let failure = null;
  let queuedBytes = 0;
  let lastWatermark = projectionWatermark(initialProjection);
  let pollTimer = null;
  let pollDelay = pollInterval;

  const watcher = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (queue.length > 0) {
        const item = queue.shift();
        queuedBytes -= item.bytes;
        return Promise.resolve({ done: false, value: item.projection });
      }
      if (failure) return Promise.reject(failure);
      if (closed) return Promise.resolve({ done: true, value: undefined });
      const result = new Promise((resolve, reject) => waiters.push({ resolve, reject }));
      schedulePoll();
      return result;
    },
    return() {
      stop(null, true);
      return Promise.resolve({ done: true, value: undefined });
    },
    publish(projection) {
      if (closed) return;
      try { publishChanged(projection, readProjection !== null); }
      catch { stop(watchError("watch_read_failed")); }
    },
  };
  enqueue(initialProjection);
  return watcher;

  function schedulePoll() {
    if (closed || pollTimer || waiters.length === 0 || !readProjection) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (closed) return;
      try {
        const changed = publishChanged(readProjection(), true);
        pollDelay = changed ? pollInterval : Math.max(pollInterval, 1000);
      } catch { stop(watchError("watch_read_failed")); }
      schedulePoll();
    }, pollDelay);
    if (unrefPollTimer) pollTimer.unref?.();
  }

  function publishChanged(projection, suppressDuplicate) {
    const watermark = projectionWatermark(projection);
    if (suppressDuplicate && watermark === lastWatermark) return false;
    lastWatermark = watermark;
    pollDelay = pollInterval;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    const waiter = waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: projection });
    else enqueue(projection);
    schedulePoll();
    return true;
  }

  function enqueue(projection) {
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(projection)); }
    catch { stop(watchError("watch_read_failed")); return; }
    if (queue.length >= 64 || queuedBytes + bytes > 8 * 1024 * 1024) {
      stop(watchError("watch_backpressure_exceeded"));
      return;
    }
    queue.push({ projection, bytes });
    queuedBytes += bytes;
  }

  function stop(error, discard = false) {
    const wasClosed = closed;
    closed = true;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (discard) { queue.length = 0; queuedBytes = 0; failure = null; }
    else failure ??= error;
    if (!wasClosed) {
      // An observation failure cannot escape a publisher's authority mutation.
      // Defer so even an oversized initial snapshot closes after registration.
      queueMicrotask(() => { try { close(); } catch {} });
    }
    for (const waiter of waiters.splice(0)) {
      if (failure) waiter.reject(failure);
      else waiter.resolve({ done: true, value: undefined });
    }
  }
}

function watchError(code) {
  return Object.assign(new Error("Watch detached. Query fresh state before reattaching; work was not cancelled."), { code });
}

export function createOneShotWatcher(result) {
  let emitted = false;
  return Object.freeze({
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (emitted) return Promise.resolve({ done: true, value: undefined });
      emitted = true;
      return Promise.resolve({ done: false, value: result });
    },
    return() {
      emitted = true;
      return Promise.resolve({ done: true, value: undefined });
    },
  });
}

function projectionWatermark(projection) {
  if (projection?.host_reconciliation?.active === true) {
    return projection.host_reconciliation.watermark;
  }
  return projection.watermark ?? projection.authority_watermark ?? null;
}
