export function createProjectionWatcher({
  initialProjection,
  close,
  readProjection = null,
  pollInterval = 10,
}) {
  const queue = [initialProjection];
  const waiters = [];
  let closed = false;
  let lastWatermark = projectionWatermark(initialProjection);
  let pollTimer = null;

  const watcher = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (queue.length > 0) {
        return Promise.resolve({ done: false, value: queue.shift() });
      }
      if (closed) return Promise.resolve({ done: true, value: undefined });
      const result = new Promise((resolve) => waiters.push(resolve));
      schedulePoll();
      return result;
    },
    return() {
      if (!closed) {
        closed = true;
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = null;
        close();
        for (const resolve of waiters.splice(0)) {
          resolve({ done: true, value: undefined });
        }
      }
      return Promise.resolve({ done: true, value: undefined });
    },
    publish(projection) {
      if (closed) return;
      publishChanged(projection, readProjection !== null);
    },
  };
  return watcher;

  function schedulePoll() {
    if (closed || pollTimer || waiters.length === 0 || !readProjection) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (closed) return;
      publishChanged(readProjection(), true);
      schedulePoll();
    }, pollInterval);
  }

  function publishChanged(projection, suppressDuplicate) {
    const watermark = projectionWatermark(projection);
    if (suppressDuplicate && watermark === lastWatermark) return;
    lastWatermark = watermark;
    const resolve = waiters.shift();
    if (resolve) {
      resolve({ done: false, value: projection });
    } else {
      queue.push(projection);
    }
  }
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
