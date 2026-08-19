/**
 * Releases a response whose body we are about to discard.
 *
 * Throwing on a non-2xx without touching the body leaves an unread stream, and
 * the connection stays checked out until GC finalizes it. Cancellation failures
 * are swallowed so the caller still reports the original HTTP status, which is
 * the useful diagnostic.
 *
 * Typed structurally rather than as `Response` because callers use both
 * undici's fetch and the global one.
 */
export const cancelResponseBody = async (response: {
  body?: { cancel: () => Promise<unknown> } | null;
}): Promise<void> => {
  if (!response.body) {
    return;
  }

  try {
    await response.body.cancel();
  } catch {
    // Nothing to report: the HTTP failure is what the caller cares about.
  }
};
