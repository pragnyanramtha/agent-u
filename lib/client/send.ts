import { api, ApiError } from "./api";

/* Posting over a bad connection. Each send carries a client id; the server answers a repeat of
 * the same id with the first answer, so retrying after a lost response never sends twice. */

export const newClientId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** the tunnel or app is restarting, or the request never got an answer */
const transient = (err: unknown) => !(err instanceof ApiError) || [502, 503, 504, 520, 521, 522, 523, 524, 530].includes(err.status);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

const backOnline = (signal?: AbortSignal) =>
  navigator.onLine
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const done = () => (window.removeEventListener("online", done), resolve());
        window.addEventListener("online", done);
        signal?.addEventListener("abort", done, { once: true });
      });

/** POST `body` with `clientId`, retrying network failures for up to `forMs`. Other errors throw at once. */
export async function postReliably<T>(url: string, body: Record<string, unknown>, clientId: string, opts: { forMs?: number; signal?: AbortSignal; onRetry?: (n: number) => void } = {}): Promise<T> {
  const until = Date.now() + (opts.forMs ?? 90_000);
  for (let n = 0; ; n++) {
    await backOnline(opts.signal);
    try {
      return await api<T>(url, { ...body, clientId });
    } catch (err) {
      if (!transient(err) || Date.now() > until || opts.signal?.aborted) throw err;
      opts.onRetry?.(n + 1);
      await sleep(Math.min(8000, 700 * 2 ** n), opts.signal);
    }
  }
}
