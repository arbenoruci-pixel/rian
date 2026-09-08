// A deadline must include the response body, not only arrival of the headers.
export async function withDeadline(work, timeoutMs = 15000, code = 'REQUEST_TIMEOUT') {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error(code), { code, name: 'AbortError' }));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJsonWithDeadline(url, init = {}, timeoutMs = 15000) {
  return withDeadline(async (signal) => {
    const response = await fetch(url, { ...init, signal });
    const body = await response.json();
    return { response, body };
  }, timeoutMs);
}
