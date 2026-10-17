import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Has `schema` validate by own keys only — see `withOwnKeysOnly` — by
 * replacing its `~standard` in place. The schema keeps its `shape`, which the
 * SDK reads to complete an argument, and its JSON Schema, which `prompts/list`
 * is built from.
 *
 * For the argument schemas `ViteMCP` and `EdgeViteMCP` build for their
 * prompts. A tool's schemas belong to whoever wrote the tool, so
 * `toSdkSchema` wraps them instead.
 *
 * An argument map the request left out validates as an empty one, as the SDK
 * already arranges for a tool's. `prompts/get` may omit `arguments`, and the
 * SDK validates the map as it was sent, so a prompt whose arguments are all
 * optional refused the request as "expected object, received undefined".
 */
export const ownKeysOnly = <S extends StandardSchemaV1>(schema: S): S => {
  const standard = withOwnKeysOnly(schema["~standard"]);

  return Object.defineProperty(schema, "~standard", {
    value: {
      ...standard,
      validate: (value: unknown) => standard.validate(value ?? {}),
    },
  });
};

/**
 * `standard`, with a `validate` that sees only the keys an object has of its
 * own.
 *
 * Zod and Valibot look each key up with `in` and read it with `[]`, and both
 * walk the prototype chain, so a key that was left out reads as present when
 * `Object.prototype` has a member by that name. An optional argument called
 * `toString`, `constructor` or `valueOf`, at any depth, failed every request
 * that left it out, as "expected string, received function", and a required
 * one was reported as the wrong type instead of as missing. Validating a copy
 * whose objects have no prototype leaves the library nothing to inherit.
 *
 * A library that hands its input back, as ArkType and `jsonSchemaAdapter` do,
 * hands back the copy, so the copied objects get their prototype back before
 * the value goes on: `execute` still receives ordinary objects.
 */
export const withOwnKeysOnly = <P extends StandardSchemaV1.Props>(
  standard: P,
): P => ({
  ...standard,
  validate: async (value: unknown) => {
    const copies = new Map<object, object>();
    const result = await standard.validate(withoutPrototypes(value, copies));

    if (!result.issues && copies.size > 0) {
      restorePrototypes(result.value, new Set(copies.values()), new Set());
    }

    return result;
  },
});

/**
 * `value`, with each plain object in it, at any depth, copied onto one without
 * a prototype, and each array copied to reach them. `copies` maps every
 * original to its copy, so one that occurs twice, or inside itself, is copied
 * once.
 */
const withoutPrototypes = (
  value: unknown,
  copies: Map<object, object>,
): unknown => {
  if (!isPlain(value)) {
    return value;
  }

  const existing = copies.get(value);

  if (existing) {
    return existing;
  }

  const copy: Record<string, unknown> = Array.isArray(value)
    ? []
    : Object.create(null);

  copies.set(value, copy);

  for (const [key, item] of Object.entries(value)) {
    copy[key] = withoutPrototypes(item, copies);
  }

  return copy;
};

/**
 * Gives each object copy in `copies` that `value` holds, at any depth,
 * `Object.prototype` back.
 */
const restorePrototypes = (
  value: unknown,
  copies: Set<object>,
  seen: Set<object>,
): void => {
  if (!isPlain(value) || seen.has(value)) {
    return;
  }

  seen.add(value);

  if (copies.has(value) && !Array.isArray(value)) {
    Object.setPrototypeOf(value, Object.prototype);
  }

  for (const item of Object.values(value)) {
    restorePrototypes(item, copies, seen);
  }
};

/**
 * An array, or an object made by a literal or without a prototype: what JSON
 * parses to, and the only kinds of object that are copied.
 */
const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return (
    Array.isArray(value) || prototype === Object.prototype || prototype === null
  );
};
