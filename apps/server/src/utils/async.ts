/** Small async helpers. */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Race a promise against a timeout. If the timeout fires first, resolves with
 * `fallback` (the underlying promise is left to settle but ignored).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<{ value: T; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ value: T; timedOut: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({ value: fallback, timedOut: true }), ms);
  });
  const wrapped = promise.then((value) => ({ value, timedOut: false }));
  const result = await Promise.race([wrapped, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}
