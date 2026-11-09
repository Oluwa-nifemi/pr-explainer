const channels = new Map();

export function subscribe(key, res, heartbeatMs = 15000) {
  let set = channels.get(key);
  if (!set) {
    set = new Set();
    channels.set(key, set);
  }
  set.add(res);
  const timer = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, heartbeatMs);
  timer.unref?.();
  const cleanup = () => {
    clearInterval(timer);
    set.delete(res);
    if (set.size === 0 && channels.get(key) === set) channels.delete(key);
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
  return cleanup;
}

export function send(res, event, data) {
  try {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  } catch {}
}

export function publish(key, event, data) {
  const set = channels.get(key);
  if (!set) return;
  const chunk = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of [...set]) {
    try {
      res.write(chunk);
    } catch {
      set.delete(res);
    }
  }
}
