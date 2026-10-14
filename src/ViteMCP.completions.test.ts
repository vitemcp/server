import { describe, expect, it } from "vitest";

import { runWithTestServer } from "./testHarness.js";
import { ViteMCP } from "./ViteMCP.js";

describe("ViteMCP Completions", () => {
  it("supports prompt completions", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });
    server.addPrompt({
      arguments: [
        {
          description: "First argument",
          name: "arg1",
        },
      ],
      complete: async (name, value) => {
        if (name === "arg1" && value === "abc") {
          return {
            values: ["abc1", "abc2"],
          };
        }
        return {
          values: [],
        };
      },
      load: async () => ({
        messages: [],
      }),
      name: "test-prompt",
    });

    await runWithTestServer({
      run: async ({ client }) => {
        const result = await client.complete({
          argument: {
            name: "arg1",
            value: "abc",
          },
          ref: {
            name: "test-prompt",
            type: "ref/prompt",
          },
        });

        expect(result.completion.values).toEqual(["abc1", "abc2"]);
      },
      server,
    });
  });

  it("supports resource completions", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });
    server.addResourceTemplate({
      arguments: [{ name: "id", required: true }],
      complete: async (_name, value) => ({
        values: ["1", "2"].filter((v) => v.startsWith(value)),
      }),
      load: async () => ({
        text: "content",
        uri: "test://resource/1",
      }),
      name: "test-resource",
      uriTemplate: "test://resource/{id}",
    });

    await runWithTestServer({
      run: async ({ client }) => {
        const result = await client.complete({
          argument: {
            name: "id",
            value: "1",
          },
          ref: {
            type: "ref/resource",
            uri: "test://resource/{id}",
          },
        });

        expect(result.completion.values).toEqual(["1"]);
      },
      server,
    });
  });

  it("prioritizes argument-level completion over prompt-level completion", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });
    server.addPrompt({
      arguments: [
        {
          complete: async (value) => ({
            values: [`arg-level-${value}`],
          }),
          name: "arg1",
        },
      ],
      complete: async (_name, value) => ({
        values: [`prompt-level-${value}`],
      }),
      load: async () => ({ messages: [] }),
      name: "priority-test",
    });

    await runWithTestServer({
      run: async ({ client }) => {
        const result = await client.complete({
          argument: {
            name: "arg1",
            value: "abc",
          },
          ref: {
            name: "priority-test",
            type: "ref/prompt",
          },
        });

        expect(result.completion.values).toEqual(["arg-level-abc"]);
      },
      server,
    });
  });

  it("answers nothing for a template variable without a completer, whatever it is called", async () => {
    // The SDK looks a variable's completer up by name, and one called
    // `constructor` or `toString` used to find `Object.prototype`'s, which
    // failed the request with an internal error.
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });
    server.addResourceTemplate({
      arguments: [
        { complete: async () => ({ values: ["1"] }), name: "id" },
        { name: "constructor" },
      ],
      load: async () => ({ text: "content" }),
      name: "test-resource",
      uriTemplate: "test://resource/{constructor}/{id}",
    });

    await runWithTestServer({
      run: async ({ client }) => {
        for (const name of [
          "constructor",
          "toString",
          "valueOf",
          "__proto__",
        ]) {
          const result = await client.complete({
            argument: { name, value: "" },
            ref: {
              type: "ref/resource",
              uri: "test://resource/{constructor}/{id}",
            },
          });

          expect(result.completion.values).toEqual([]);
        }
      },
      server,
    });
  });

  it("throws error for unknown prompt", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        await expect(
          client.complete({
            argument: {
              name: "arg",
              value: "val",
            },
            ref: {
              name: "unknown-prompt",
              type: "ref/prompt",
            },
          }),
        ).rejects.toThrow();
      },
    });
  });

  it("throws error for unknown resource", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        await expect(
          client.complete({
            argument: {
              name: "arg",
              value: "val",
            },
            ref: {
              type: "ref/resource",
              uri: "unknown://uri",
            },
          }),
        ).rejects.toThrow();
      },
    });
  });

  describe("enum arguments complete themselves", () => {
    /**
     * A prompt argument on the wire is only name/description/required, so an
     * `enum` has nowhere to appear in `prompts/list`. Completion is the one
     * channel that can carry the permitted values to a client, which is why an
     * enum argument has to answer completions even with no `complete` written
     * for it.
     */
    const countryPrompt = () => {
      const server = new ViteMCP({ name: "Test", version: "1.0.0" });
      server.addPrompt({
        arguments: [
          {
            description: "Name of the country",
            enum: ["Germany", "France", "Italy"],
            name: "country",
            required: true,
          },
        ],
        load: async ({ country }) => `A poem about ${country}`,
        name: "countryPoem",
      });
      return server;
    };

    const completeCountry = (value: string) => ({
      argument: { name: "country", value },
      ref: { name: "countryPoem", type: "ref/prompt" as const },
    });

    it("offers every value for the empty query an editor opens with", async () => {
      await runWithTestServer({
        run: async ({ client }) => {
          // Nothing typed yet is precisely when the list is most useful, so it
          // must not be treated as a filter that matches nothing.
          const result = await client.complete(completeCountry(""));

          expect(result.completion.values).toEqual([
            "Germany",
            "France",
            "Italy",
          ]);
        },
        server: countryPrompt(),
      });
    });

    it("narrows to what was typed, case-insensitively", async () => {
      await runWithTestServer({
        run: async ({ client }) => {
          expect(
            (await client.complete(completeCountry("ran"))).completion.values,
          ).toEqual(["France"]);
          expect(
            (await client.complete(completeCountry("ger"))).completion.values,
          ).toEqual(["Germany"]);
          expect(
            (await client.complete(completeCountry("zzz"))).completion.values,
          ).toEqual([]);
        },
        server: countryPrompt(),
      });
    });

    it("lets an explicit completer override the enum", async () => {
      const server = new ViteMCP({ name: "Test", version: "1.0.0" });
      server.addPrompt({
        arguments: [
          {
            complete: async () => ({ values: ["from-the-author"] }),
            enum: ["Germany", "France"],
            name: "country",
            required: true,
          },
        ],
        load: async () => "poem",
        name: "countryPoem",
      });

      await runWithTestServer({
        run: async ({ client }) => {
          const result = await client.complete(completeCountry(""));

          expect(result.completion.values).toEqual(["from-the-author"]);
        },
        server,
      });
    });

    it("still rejects a value outside the enum", async () => {
      // Completion is a hint; the schema is the check. Adding the first must
      // not have loosened the second.
      await runWithTestServer({
        run: async ({ client }) => {
          await expect(
            client.getPrompt({
              arguments: { country: "Atlantis" },
              name: "countryPoem",
            }),
          ).rejects.toThrow();

          const ok = await client.getPrompt({
            arguments: { country: "France" },
            name: "countryPoem",
          });

          expect(JSON.stringify(ok)).toContain("France");
        },
        server: countryPrompt(),
      });
    });
  });
});
