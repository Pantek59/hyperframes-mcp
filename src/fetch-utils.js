/**
 * fetch-utils.js — small shared helpers for the outbound upstream calls
 * (TTS-API, voices registry, ComfyUI).
 *
 * Node's fetch wraps every connection-level failure in an opaque
 * "TypeError: fetch failed"; the real cause (ECONNREFUSED, ENOTFOUND,
 * EHOSTUNREACH, …) hides in `error.cause`. These helpers surface that
 * cause along with the configured origin so misconfiguration (wrong
 * host/port) is diagnosable from the error message alone.
 *
 * Safety: messages carry the configured origin and the OS error code only —
 * never upstream response bodies, credentials, or bearer tokens.
 */

/** Node loses the real cause of network failures; surface the OS error code. */
export function describeFetchError(error) {
  const message = String(error?.message || error || "request failed");
  const code = error?.cause?.code || error?.code;
  return code ? `${message} (${code})` : message;
}

/**
 * Validate a configured base URL and return it as a URL object.
 * Rejected: unset, unparsable, non-HTTP(S), credentials, query/hash,
 * non-root path.
 */
export function validateHttpOrigin(baseUrl, what, envVar) {
  if (!baseUrl) throw new Error(`${what} is not configured: set ${envVar}`);
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error(`${envVar} must be a valid HTTP(S) base URL`);
  }
  if (!new Set(["http:", "https:"]).has(base.protocol) || base.username || base.password ||
      base.search || base.hash || (base.pathname !== "/" && base.pathname !== "")) {
    throw new Error(`${envVar} must be an HTTP(S) origin without credentials or a path`);
  }
  return base;
}

/**
 * Run an upstream request and turn network-level failures into a diagnosable
 * error: `<what> (<origin>) request failed: fetch failed (ECONNREFUSED)`.
 * A plain job-cancellation abort (AbortError) is rethrown unwrapped so the
 * job queue can classify it; timeouts surface with the TimeoutError detail.
 */
export async function upstreamFetch(fetchImpl, url, init, what) {
  if (typeof fetchImpl !== "function") throw new Error("This Node.js runtime does not provide fetch");
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (init?.signal?.aborted && error.name === "AbortError") throw error;
    throw new Error(`${what} (${url.origin}) request failed: ${describeFetchError(error)}`);
  }
}
