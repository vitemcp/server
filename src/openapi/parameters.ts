import type { OpenApiParameter } from "./types.js";

/**
 * Serializes parameters the way the OpenAPI `style`/`explode` pair says to.
 *
 * Worth doing properly rather than stringifying: a `tags` array sent as
 * `?tags=a&tags=b` to an operation declaring `style: form, explode: false`
 * reaches a server that reads a single comma-joined value, and silently sees
 * only `a`. The default of `form` + `explode: true` is the common case, but it
 * is a default, not the rule.
 */
export const appendQueryParameter = (
  query: URLSearchParams,
  parameter: OpenApiParameter,
  value: unknown,
): void => {
  const style = parameter.style ?? "form";
  const explode = parameter.explode ?? style === "form";
  const name = parameter.name;

  if (value === null || value === undefined) {
    return;
  }

  if (style === "deepObject") {
    if (isRecord(value)) {
      for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) {
          query.append(`${name}[${key}]`, stringify(entry));
        }
      }
    }

    return;
  }

  if (explode) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        query.append(name, stringify(entry));
      }

      return;
    }

    if (isRecord(value)) {
      for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) {
          query.append(key, stringify(entry));
        }
      }

      return;
    }

    query.append(name, stringify(value));
    return;
  }

  const separator = DELIMITERS[style] ?? ",";

  // An empty array or object is left out, as it is when exploded. RFC 6570,
  // which OpenAPI's styles are modelled on, treats it as undefined; sent as
  // `tags=`, it would reach the API as a filter for the empty string.
  if (Array.isArray(value)) {
    if (value.length > 0) {
      query.append(name, value.map(stringify).join(separator));
    }

    return;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value).flatMap(([key, entry]) =>
      entry === undefined ? [] : [key, stringify(entry)],
    );

    if (entries.length > 0) {
      query.append(name, entries.join(separator));
    }

    return;
  }

  query.append(name, stringify(value));
};

/**
 * Renders the collected query parameters.
 *
 * `URLSearchParams` writes a space as `+`, which is the form-encoding rule
 * rather than the URL one; OpenAPI's `spaceDelimited` style means a literal
 * space. A `+` that was itself part of a value is already `%2B` by this point,
 * so every remaining one came from a space and can be rewritten safely.
 */
export const toQueryString = (query: URLSearchParams): string =>
  query.toString().replaceAll("+", "%20");

/**
 * Serializes a path parameter, percent-encoding the values but not the
 * delimiters that separate them — the delimiters are part of the path's
 * structure, and encoding them would hide it from the server.
 */
export const serializePathParameter = (
  parameter: OpenApiParameter,
  value: unknown,
): string => {
  const style = parameter.style ?? "simple";
  const explode = parameter.explode ?? false;
  const body = serializeSimple(value, explode, parameter.name, style);

  if (style === "label") {
    return `.${body}`;
  }

  if (style === "matrix") {
    // An exploded matrix parameter already repeats `;name=` per entry.
    return explode && (Array.isArray(value) || isRecord(value))
      ? body
      : `;${parameter.name}=${body}`;
  }

  return body;
};

/**
 * Serializes a header or cookie parameter. Both default to a comma-joined
 * `simple` form; neither is percent-encoded, since header values are not a URL.
 */
export const serializeSimpleParameter = (
  parameter: OpenApiParameter,
  value: unknown,
): string => {
  const explode = parameter.explode ?? false;

  if (Array.isArray(value)) {
    return value.map(stringify).join(",");
  }

  if (isRecord(value)) {
    return Object.entries(value)
      .flatMap(([key, entry]) =>
        entry === undefined
          ? []
          : [
              explode
                ? `${key}=${stringify(entry)}`
                : `${key},${stringify(entry)}`,
            ],
      )
      .join(",");
  }

  return stringify(value);
};

const DELIMITERS: Record<string, string> = {
  form: ",",
  pipeDelimited: "|",
  simple: ",",
  spaceDelimited: " ",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const serializeSimple = (
  value: unknown,
  explode: boolean,
  name: string,
  style: string,
): string => {
  const encode = (entry: unknown): string =>
    encodeURIComponent(stringify(entry));

  if (Array.isArray(value)) {
    if (style === "matrix" && explode) {
      return value.map((entry) => `;${name}=${encode(entry)}`).join("");
    }

    if (style === "label" && explode) {
      return value.map(encode).join(".");
    }

    return value.map(encode).join(",");
  }

  if (isRecord(value)) {
    const entries = Object.entries(value).filter(
      ([, entry]) => entry !== undefined,
    );

    // Keys are encoded as well as values: they are the caller's too, and left
    // as written, a key holding `/` added a path segment.
    if (style === "matrix" && explode) {
      return entries
        .map(([key, entry]) => `;${encodeURIComponent(key)}=${encode(entry)}`)
        .join("");
    }

    if (explode) {
      return entries
        .map(([key, entry]) => `${encodeURIComponent(key)}=${encode(entry)}`)
        .join(style === "label" ? "." : ",");
    }

    return entries
      .flatMap(([key, entry]) => [encodeURIComponent(key), encode(entry)])
      .join(",");
  }

  return encode(value);
};

/**
 * `JSON.stringify` for anything that is not already a primitive, so a nested
 * object reaching a scalar slot arrives as something a server can parse rather
 * than as `[object Object]`.
 */
const stringify = (value: unknown): string =>
  typeof value === "object" && value !== null
    ? JSON.stringify(value)
    : String(value);
