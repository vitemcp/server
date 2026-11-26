/**
 * `maxToolInputElements` when a server sets none.
 *
 * Validation keeps every issue it finds, so what checking one call costs grows
 * with how many elements its arguments hold, and a cap on the body does not
 * bound it: half a million invalid elements fit in 1 MiB, and Zod kept half a
 * gigabyte of issues reporting them. Ten thousand keep that near 8 MB.
 */
const DEFAULT_MAX_TOOL_INPUT_ELEMENTS = 10_000;

/**
 * The limit a server was given, or the default, refused where the SDK would
 * refuse it. The SDK checks as it builds a server, and a server is built for
 * every request: checked once up front, a bad value stops the server from
 * being created rather than failing every request it would have answered.
 */
export const resolveMaxToolInputElements = (
  value: number | undefined,
): number => {
  if (value === undefined) {
    return DEFAULT_MAX_TOOL_INPUT_ELEMENTS;
  }

  if (typeof value !== "number" || Number.isNaN(value) || value < 1) {
    throw new RangeError(
      `maxToolInputElements must be a number of at least 1, or Infinity, got ${String(value)}`,
    );
  }

  return value;
};
