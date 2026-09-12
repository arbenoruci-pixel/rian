// A deadline must include the response body, not only arrival of the headers.
export async function withDeadline(work, timeoutMs = 15000, code = 'REQUEST_TIMEOUT', { signal } = {}) {
  const controller = new AbortController();
  let timer, abort;
  try {
    if (signal?.aborted) throw Object.assign(new Error('REQUEST_CANCELLED'), { code: 'REQUEST_CANCELLED', name: 'AbortError' });
    const cancellation = new Promise((_, reject) => {
      abort = () => {
        controller.abort();
        reject(Object.assign(new Error('REQUEST_CANCELLED'), { code: 'REQUEST_CANCELLED', name: 'AbortError' }));
      };
      signal?.addEventListener('abort', abort, { once: true });
    });
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      cancellation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error(code), { code, name: 'AbortError' }));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

export async function fetchJsonWithDeadline(url, init = {}, timeoutMs = 15000) {
  return withDeadline(async (signal) => {
    const response = await fetch(url, { ...init, signal });
    const body = await response.json();
    return { response, body };
  }, timeoutMs, 'REQUEST_TIMEOUT', { signal: init.signal });
}
