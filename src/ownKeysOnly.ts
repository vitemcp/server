import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Has `schema` validate an object by its own keys only.
 *
 * Zod looks each key up with `in` and reads it with `[]`, and both walk the
 * prototype chain, so an argument the client left out reads as present when
 * `Object.prototype` has a member by that name. An optional prompt argument
 * called `toString`, `constructor` or `valueOf` failed every request that left
 * it out, as "expected string, received function", and a required one was
 * reported as the wrong type instead of as missing. A copy of the input without
 * a prototype leaves Zod nothing to inherit.
 *
 * Only `~standard.validate` changes. The schema keeps its `shape`, which the
 * SDK reads to complete an argument, and its JSON Schema, which `prompts/list`
 * is built from.
 *
 * Shared by `ViteMCP` and `EdgeViteMCP`, which both build their prompts'
 * argument schemas with Zod.
 */
export const ownKeysOnly = <S extends StandardSchemaV1>(schema: S): S => {
  const standard = schema["~standard"];

  return Object.defineProperty(schema, "~standard", {
    value: {
      ...standard,
      validate: (value: unknown) =>
        standard.validate(
          typeof value === "object" && value !== null && !Array.isArray(value)
            ? Object.assign(Object.create(null), value)
            : value,
        ),
    },
  });
};
