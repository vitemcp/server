import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { setTimeout as delay } from "timers/promises";
import { fetch } from "undici";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { z as z4 } from "zod/v4";

import { runWithTestServer, withoutEnvelope } from "./testHarness.js";
import { audioContent, imageContent, UserError, ViteMCP } from "./ViteMCP.js";

test("adds tools", async () => {
  await runWithTestServer({
    run: async ({ client }) => {
      expect(withoutEnvelope(await client.listTools())).toEqual({
        tools: [
          {
            description: "Add two numbers",
            inputSchema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              properties: {
                a: { type: "number" },
                b: { type: "number" },
              },
              required: ["a", "b"],
              type: "object",
            },
            name: "add",
          },
        ],
      });
    },
    server: async () => {
      const server = new ViteMCP({
        name: "Test",
        version: "1.0.0",
      });

      server.addTool({
        description: "Add two numbers",
        execute: async (args) => {
          return String(args.a + args.b);
        },
        name: "add",
        parameters: z.object({
          a: z.number(),
          b: z.number(),
        }),
      });

      return server;
    },
  });
});

test("adds tools with Zod v4 schema", async () => {
  await runWithTestServer({
    run: async ({ client }) => {
      expect(withoutEnvelope(await client.listTools())).toEqual({
        tools: [
          {
            description: "Add two numbers (using Zod v4 schema)",
            inputSchema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              properties: {
                a: { type: "number" },
                b: { type: "number" },
              },
              required: ["a", "b"],
              type: "object",
            },
            name: "add-zod-v4",
          },
        ],
      });
    },
    server: async () => {
      const server = new ViteMCP({
        name: "Test",
        version: "1.0.0",
      });

      const AddParamsZod4 = z4.object({
        a: z4.number(),
        b: z4.number(),
      });

      server.addTool({
        description: "Add two numbers (using Zod v4 schema)",
        execute: async (args) => {
          return String(args.a + args.b);
        },
        name: "add-zod-v4",
        parameters: AddParamsZod4,
      });

      return server;
    },
  });
});

test("health endpoint returns ok", async () => {
  const server = new ViteMCP({
    health: { message: "healthy", path: "/healthz" },
    name: "Test",
    version: "1.0.0",
  });

  await server.start({
    httpStream: { port: 0 },
    transportType: "httpStream",
  });
  const port = server.port!;

  try {
    const response = await fetch(`http://localhost:${port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("healthy");
  } finally {
    await server.stop();
  }
});

test("calls a tool", async () => {
  await runWithTestServer({
    run: async ({ client }) => {
      expect(
        withoutEnvelope(
          await client.callTool({
            arguments: {
              a: 1,
              b: 2,
            },
            name: "add",
          }),
        ),
      ).toEqual({
        content: [{ text: "3", type: "text" }],
      });
    },
    server: async () => {
      const server = new ViteMCP({
        name: "Test",
        version: "1.0.0",
      });

      server.addTool({
        description: "Add two numbers",
        execute: async (args) => {
          return String(args.a + args.b);
        },
        name: "add",
        parameters: z.object({
          a: z.number(),
          b: z.number(),
        }),
      });

      return server;
    },
  });
});

test("returns a list", async () => {
  await runWithTestServer({
    run: async ({ client }) => {
      expect(
        withoutEnvelope(
          await client.callTool({
            arguments: {
              a: 1,
              b: 2,
            },
            name: "add",
          }),
        ),
      ).toEqual({
        content: [
          { text: "a", type: "text" },
          { text: "b", type: "text" },
        ],
      });
    },
    server: async () => {
      const server = new ViteMCP({
        name: "Test",
        version: "1.0.0",
      });

      server.addTool({
        description: "Add two numbers",
        execute: async () => {
          return {
            content: [
              { text: "a", type: "text" },
              { text: "b", type: "text" },
            ],
          };
        },
        name: "add",
        parameters: z.object({
          a: z.number(),
          b: z.number(),
        }),
      });

      return server;
    },
  });
});

test("returns an image", async () => {
  await runWithTestServer({
    run: async ({ client }) => {
      expect(
        withoutEnvelope(
          await client.callTool({
            arguments: {
              a: 1,
              b: 2,
            },
            name: "add",
          }),
        ),
      ).toEqual({
        content: [
          {
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
            mimeType: "image/png",
            type: "image",
          },
        ],
      });
    },
    server: async () => {
      const server = new ViteMCP({
        name: "Test",
        version: "1.0.0",
      });

      server.addTool({
        description: "Add two numbers",
        execute: async () => {
          return imageContent({
            buffer: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
              "base64",
            ),
          });
        },
        name: "add",
        parameters: z.object({
          a: z.number(),
          b: z.number(),
        }),
      });

      return server;
    },
  });
});

test("returns an audio", async () => {
  await runWithTestServer({
    run: async ({ client }) => {
      expect(
        withoutEnvelope(
          await client.callTool({
            arguments: {
              a: 1,
              b: 2,
            },
            name: "add",
          }),
        ),
      ).toEqual({
        content: [
          {
            data: "UklGRhwMAABXQVZFZm10IBAAAAABAAEAgD4AAIA+AAABAAgAZGF0Ya4LAACAgICAgICAgICAgICAgICAgICAgICAgICAf3hxeH+AfXZ1eHx6dnR5fYGFgoOKi42aloubq6GOjI2Op7ythXJ0eYF5aV1AOFFib32HmZSHhpCalIiYi4SRkZaLfnhxaWptb21qaWBea2BRYmZTVmFgWFNXVVVhaGdbYGhZbXh1gXZ1goeIlot1k6yxtKaOkaWhq7KonKCZoaCjoKWuqqmurK6ztrO7tbTAvru/vb68vbW6vLGqsLOfm5yal5KKhoyBeHt2dXBnbmljVlJWUEBBPDw9Mi4zKRwhIBYaGRQcHBURGB0XFxwhGxocJSstMjg6PTc6PUxVV1lWV2JqaXN0coCHhIyPjpOenqWppK6xu72yxMu9us7Pw83Wy9nY29ve6OPr6uvs6ezu6ejk6erm3uPj3dbT1sjBzdDFuMHAt7m1r7W6qaCupJOTkpWPgHqAd3JrbGlnY1peX1hTUk9PTFRKR0RFQkRBRUVEQkdBPjs9Pzo6NT04Njs+PTxAPzo/Ojk6PEA5PUJAQD04PkRCREZLUk1KT1BRUVdXU1VRV1tZV1xgXltcXF9hXl9eY2VmZmlna3J0b3F3eHyBfX+JgIWJiouTlZCTmpybnqSgnqyrqrO3srK2uL2/u7jAwMLFxsfEv8XLzcrIy83JzcrP0s3M0dTP0drY1dPR1dzc19za19XX2dnU1NjU0dXPzdHQy8rMysfGxMLBvLu3ta+sraeioJ2YlI+MioeFfX55cnJsaWVjXVlbVE5RTktHRUVAPDw3NC8uLyknKSIiJiUdHiEeGx4eHRwZHB8cHiAfHh8eHSEhISMoJyMnKisrLCszNy8yOTg9QEJFRUVITVFOTlJVWltaXmNfX2ZqZ21xb3R3eHqAhoeJkZKTlZmhpJ6kqKeur6yxtLW1trW4t6+us7axrbK2tLa6ury7u7u9u7vCwb+/vr7Ev7y9v8G8vby6vru4uLq+tri8ubi5t7W4uLW5uLKxs7G0tLGwt7Wvs7avr7O0tLW4trS4uLO1trW1trm1tLm0r7Kyr66wramsqaKlp52bmpeWl5KQkImEhIB8fXh3eHJrbW5mYGNcWFhUUE1LRENDQUI9ODcxLy8vMCsqLCgoKCgpKScoKCYoKygpKyssLi0sLi0uMDIwMTIuLzQ0Njg4Njc8ODlBQ0A/RUdGSU5RUVFUV1pdXWFjZGdpbG1vcXJ2eXh6fICAgIWIio2OkJGSlJWanJqbnZ2cn6Kkp6enq62srbCysrO1uLy4uL+/vL7CwMHAvb/Cvbq9vLm5uba2t7Sysq+urqyqqaalpqShoJ+enZuamZqXlZWTkpGSkpCNjpCMioqLioiHhoeGhYSGg4GDhoKDg4GBg4GBgoGBgoOChISChISChIWDg4WEgoSEgYODgYGCgYGAgICAgX99f398fX18e3p6e3t7enp7fHx4e3x6e3x7fHx9fX59fn1+fX19fH19fnx9fn19fX18fHx7fHx6fH18fXx8fHx7fH1+fXx+f319fn19fn1+gH9+f4B/fn+AgICAgH+AgICAgIGAgICAgH9+f4B+f35+fn58e3t8e3p5eXh4d3Z1dHRzcXBvb21sbmxqaWhlZmVjYmFfX2BfXV1cXFxaWVlaWVlYV1hYV1hYWVhZWFlaWllbXFpbXV5fX15fYWJhYmNiYWJhYWJjZGVmZ2hqbG1ub3Fxc3V3dnd6e3t8e3x+f3+AgICAgoGBgoKDhISFh4aHiYqKi4uMjYyOj4+QkZKUlZWXmJmbm52enqCioqSlpqeoqaqrrK2ur7CxsrGys7O0tbW2tba3t7i3uLe4t7a3t7i3tre2tba1tLSzsrKysbCvrq2sq6qop6alo6OioJ+dnJqZmJeWlJKSkI+OjoyLioiIh4WEg4GBgH9+fXt6eXh3d3V0c3JxcG9ubWxsamppaWhnZmVlZGRjYmNiYWBhYGBfYF9fXl5fXl1dXVxdXF1dXF1cXF1cXF1dXV5dXV5fXl9eX19gYGFgYWJhYmFiY2NiY2RjZGNkZWRlZGVmZmVmZmVmZ2dmZ2hnaGhnaGloZ2hpaWhpamlqaWpqa2pra2xtbGxtbm1ubm5vcG9wcXBxcnFycnN0c3N0dXV2d3d4eHh5ent6e3x9fn5/f4CAgIGCg4SEhYaGh4iIiYqLi4uMjY2Oj5CQkZGSk5OUlJWWlpeYl5iZmZqbm5ybnJ2cnZ6en56fn6ChoKChoqGio6KjpKOko6SjpKWkpaSkpKSlpKWkpaSlpKSlpKOkpKOko6KioaKhoaCfoJ+enp2dnJybmpmZmJeXlpWUk5STkZGQj4+OjYyLioqJh4eGhYSEgoKBgIB/fn59fHt7enl5eHd3dnZ1dHRzc3JycXBxcG9vbm5tbWxrbGxraWppaWhpaGdnZ2dmZ2ZlZmVmZWRlZGVkY2RjZGNkZGRkZGRkZGRkZGRjZGRkY2RjZGNkZWRlZGVmZWZmZ2ZnZ2doaWhpaWpra2xsbW5tbm9ub29wcXFycnNzdHV1dXZ2d3d4eXl6enp7fHx9fX5+f4CAgIGAgYGCgoOEhISFhoWGhoeIh4iJiImKiYqLiouLjI2MjI2OjY6Pj46PkI+QkZCRkJGQkZGSkZKRkpGSkZGRkZKRkpKRkpGSkZKRkpGSkZKRkpGSkZCRkZCRkI+Qj5CPkI+Pjo+OjY6Njo2MjYyLjIuMi4qLioqJiomJiImIh4iHh4aHhoaFhoWFhIWEg4SDg4KDgoKBgoGAgYCBgICAgICAf4CAf39+f35/fn1+fX59fHx9fH18e3x7fHt6e3p7ent6e3p5enl6enl6eXp5eXl4eXh5eHl4eXh5eHl4eXh5eHh3eHh4d3h4d3h3d3h4d3l4eHd4d3h3eHd4d3h3eHh4eXh5eHl4eHl4eXh5enl6eXp5enl6eXp5ent6ent6e3x7fHx9fH18fX19fn1+fX5/fn9+f4B/gH+Af4CAgICAgIGAgYCBgoGCgYKCgoKDgoOEg4OEg4SFhIWEhYSFhoWGhYaHhoeHhoeGh4iHiIiHiImIiImKiYqJiYqJiouKi4qLiouKi4qLiouKi4qLiouKi4qLi4qLiouKi4qLiomJiomIiYiJiImIh4iIh4iHhoeGhYWGhYaFhIWEg4OEg4KDgoOCgYKBgIGAgICAgH+Af39+f359fn18fX19fHx8e3t6e3p7enl6eXp5enl6enl5eXh5eHh5eHl4eXh5eHl4eHd5eHd3eHl4d3h3eHd4d3h3eHh4d3h4d3h3d3h5eHl4eXh5eHl5eXp5enl6eXp7ent6e3p7e3t7fHt8e3x8fHx9fH1+fX59fn9+f35/gH+AgICAgICAgYGAgYKBgoGCgoKDgoOEg4SEhIWFhIWFhoWGhYaGhoaHhoeGh4aHhoeIh4iHiIeHiIeIh4iHiIeIiIiHiIeIh4iHiIiHiIeIh4iHiIeIh4eIh4eIh4aHh4aHhoeGh4aHhoWGhYaFhoWFhIWEhYSFhIWEhISDhIOEg4OCg4OCg4KDgYKCgYKCgYCBgIGAgYCBgICAgICAgICAf4B/f4B/gH+Af35/fn9+f35/fn1+fn19fn1+fX59fn19fX19fH18fXx9fH18fXx9fH18fXx8fHt8e3x7fHt8e3x7fHt8e3x7fHt8e3x7fHt8e3x7fHt8e3x8e3x7fHt8e3x7fHx8fXx9fH18fX5+fX59fn9+f35+f35/gH+Af4B/gICAgICAgICAgICAgYCBgIGAgIGAgYGBgoGCgYKBgoGCgYKBgoGCgoKDgoOCg4KDgoOCg4KDgoOCg4KDgoOCg4KDgoOCg4KDgoOCg4KDgoOCg4KDgoOCg4KDgoOCg4KDgoOCg4KCgoGCgYKBgoGCgYKBgoGCgYKBgoGCgYKBgoGCgYKBgoGCgYKBgoGCgYKBgoGBgYCBgIGAgYCBgIGAgYCBgIGAgYCBgIGAgYCBgIGAgYCAgICBgIGAgYCBgIGAgYCBgIGAgYCBgExJU1RCAAAASU5GT0lDUkQMAAAAMjAwOC0wOS0yMQAASUVORwMAAAAgAAABSVNGVBYAAABTb255IFNvdW5kIEZvcmdlIDguMAAA",
            mimeType: "audio/wav",
            type: "audio",
          },
        ],
      });
    },
    server: async () => {
      const server = new ViteMCP({
        name: "Test",
        version: "1.0.0",
      });

      server.addTool({
        description: "Add two numbers",
        execute: async () => {
          return audioContent({
            buffer: Buffer.from(
              "UklGRhwMAABXQVZFZm10IBAAAAABAAEAgD4AAIA+AAABAAgAZGF0Ya4LAACAgICAgICAgICAgICAgICAgICAgICAgICAf3hxeH+AfXZ1eHx6dnR5fYGFgoOKi42aloubq6GOjI2Op7ythXJ0eYF5aV1AOFFib32HmZSHhpCalIiYi4SRkZaLfnhxaWptb21qaWBea2BRYmZTVmFgWFNXVVVhaGdbYGhZbXh1gXZ1goeIlot1k6yxtKaOkaWhq7KonKCZoaCjoKWuqqmurK6ztrO7tbTAvru/vb68vbW6vLGqsLOfm5yal5KKhoyBeHt2dXBnbmljVlJWUEBBPDw9Mi4zKRwhIBYaGRQcHBURGB0XFxwhGxocJSstMjg6PTc6PUxVV1lWV2JqaXN0coCHhIyPjpOenqWppK6xu72yxMu9us7Pw83Wy9nY29ve6OPr6uvs6ezu6ejk6erm3uPj3dbT1sjBzdDFuMHAt7m1r7W6qaCupJOTkpWPgHqAd3JrbGlnY1peX1hTUk9PTFRKR0RFQkRBRUVEQkdBPjs9Pzo6NT04Njs+PTxAPzo/Ojk6PEA5PUJAQD04PkRCREZLUk1KT1BRUVdXU1VRV1tZV1xgXltcXF9hXl9eY2VmZmlna3J0b3F3eHyBfX+JgIWJiouTlZCTmpybnqSgnqyrqrO3srK2uL2/u7jAwMLFxsfEv8XLzcrIy83JzcrP0s3M0dTP0drY1dPR1dzc19za19XX2dnU1NjU0dXPzdHQy8rMysfGxMLBvLu3ta+sraeioJ2YlI+MioeFfX55cnJsaWVjXVlbVE5RTktHRUVAPDw3NC8uLyknKSIiJiUdHiEeGx4eHRwZHB8cHiAfHh8eHSEhISMoJyMnKisrLCszNy8yOTg9QEJFRUVITVFOTlJVWltaXmNfX2ZqZ21xb3R3eHqAhoeJkZKTlZmhpJ6kqKeur6yxtLW1trW4t6+us7axrbK2tLa6ury7u7u9u7vCwb+/vr7Ev7y9v8G8vby6vru4uLq+tri8ubi5t7W4uLW5uLKxs7G0tLGwt7Wvs7avr7O0tLW4trS4uLO1trW1trm1tLm0r7Kyr66wramsqaKlp52bmpeWl5KQkImEhIB8fXh3eHJrbW5mYGNcWFhUUE1LRENDQUI9ODcxLy8vMCsqLCgoKCgpKScoKCYoKygpKyssLi0sLi0uMDIwMTIuLzQ0Njg4Njc8ODlBQ0A/RUdGSU5RUVFUV1pdXWFjZGdpbG1vcXJ2eXh6fICAgIWIio2OkJGSlJWanJqbnZ2cn6Kkp6enq62srbCysrO1uLy4uL+/vL7CwMHAvb/Cvbq9vLm5uba2t7Sysq+urqyqqaalpqShoJ+enZuamZqXlZWTkpGSkpCNjpCMioqLioiHhoeGhYSGg4GDhoKDg4GBg4GBgoGBgoOChISChISChIWDg4WEgoSEgYODgYGCgYGAgICAgX99f398fX18e3p6e3t7enp7fHx4e3x6e3x7fHx9fX59fn1+fX19fH19fnx9fn19fX18fHx7fHx6fH18fXx8fHx7fH1+fXx+f319fn19fn1+gH9+f4B/fn+AgICAgH+AgICAgIGAgICAgH9+f4B+f35+fn58e3t8e3p5eXh4d3Z1dHRzcXBvb21sbmxqaWhlZmVjYmFfX2BfXV1cXFxaWVlaWVlYV1hYV1hYWVhZWFlaWllbXFpbXV5fX15fYWJhYmNiYWJhYWJjZGVmZ2hqbG1ub3Fxc3V3dnd6e3t8e3x+f3+AgICAgoGBgoKDhISFh4aHiYqKi4uMjYyOj4+QkZKUlZWXmJmbm52enqCioqSlpqeoqaqrrK2ur7CxsrGys7O0tbW2tba3t7i3uLe4t7a3t7i3tre2tba1tLSzsrKysbCvrq2sq6qop6alo6OioJ+dnJqZmJeWlJKSkI+OjoyLioiIh4WEg4GBgH9+fXt6eXh3d3V0c3JxcG9ubWxsamppaWhnZmVlZGRjYmNiYWBhYGBfYF9fXl5fXl1dXVxdXF1dXF1cXF1cXF1dXV5dXV5fXl9eX19gYGFgYWJhYmFiY2NiY2RjZGNkZWRlZGVmZmVmZmVmZ2dmZ2hnaGhnaGloZ2hpaWhpamlqaWpqa2pra2xtbGxtbm1ubm5vcG9wcXBxcnFycnN0c3N0dXV2d3d4eHh5ent6e3x9fn5/f4CAgIGCg4SEhYaGh4iIiYqLi4uMjY2Oj5CQkZGSk5OUlJWWlpeYl5iZmZqbm5ybnJ2cnZ6en56fn6ChoKChoqGio6KjpKOko6SjpKWkpaSkpKSlpKWkpaSlpKSlpKOkpKOko6KioaKhoaCfoJ+enp2dnJybmpmZmJeXlpWUk5STkZGQj4+OjYyLioqJh4eGhYSEgoKBgIB/fn59fHt7enl5eHd3dnZ1dHRzc3JycXBxcG9vbm5tbWxrbGxraWppaWhpaGdnZ2dmZ2ZlZmVmZWRlZGVkY2RjZGNkZGRkZGRkZGRkZGRjZGRkY2RjZGNkZWRlZGVmZWZmZ2ZnZ2doaWhpaWpra2xsbW5tbm9ub29wcXFycnNzdHV1dXZ2d3d4eXl6enp7fHx9fX5+f4CAgIGAgYGCgoOEhISFhoWGhoeIh4iJiImKiYqLiouLjI2MjI2OjY6Pj46PkI+QkZCRkJGQkZGSkZKRkpGSkZGRkZKRkpKRkpGSkZKRkpGSkZKRkpGSkZCRkZCRkI+Qj5CPkI+Pjo+OjY6Njo2MjYyLjIuMi4qLioqJiomJiImIh4iHh4aHhoaFhoWFhIWEg4SDg4KDgoKBgoGAgYCBgICAgICAf4CAf39+f35/fn1+fX59fHx9fH18e3x7fHt6e3p7ent6e3p5enl6enl6eXp5eXl4eXh5eHl4eXh5eHl4eXh5eHh3eHh4d3h4d3h3d3h4d3l4eHd4d3h3eHd4d3h3eHh4eXh5eHl4eHl4eXh5enl6eXp5enl6eXp5ent6ent6e3x7fHx9fH18fX19fn1+fX5/fn9+f4B/gH+Af4CAgICAgIGAgYCBgoGCgYKCgoKDgoOEg4OEg4SFhIWEhYSFhoWGhYaHhoeHhoeGh4iHiIiHiImIiImKiYqJiYqJiouKi4qLiouKi4qLiouKi4qLiouKi4qLi4qLiouKi4qLiomJiomIiYiJiImIh4iIh4iHhoeGhYWGhYaFhIWEg4OEg4KDgoOCgYKBgIGAgICAgH+Af39+f359fn18fX19fHx8e3t6e3p7enl6eXp5enl6enl5eXh5eHh5eHl4eXh5eHl4eHd5eHd3eHl4d3h3eHd4d3h3eHh4d3h4d3h3d3h5eHl4eXh5eHl5eXp5enl6eXp7ent6e3p7e3t7fHt8e3x8fHx9fH1+fX59fn9+f35/gH+AgICAgICAgYGAgYKBgoGCgoKDgoOEg4SEhIWFhIWFhoWGhYaGhoaHhoeGh4aHhoeIh4iHiIeHiIeIh4iHiIeIiIiHiIeIh4iHiIiHiIeIh4iHiIeIh4eIh4eIh4aHh4aHhoeGh4aHhoWGhYaFhoWFhIWEhYSFhIWEhISDhIOEg4OCg4OCg4KDgYKCgYKCgYCBgIGAgYCBgICAgICAgICAf4B/f4B/gH+Af35/fn9+f35/fn1+fn19fn1+fX59fn19fX19fH18fXx9fH18fXx9fH18fXx8fHt8e3x7fHt8e3x7fHt8e3x7fHt8e3x7fHt8e3x7fHt8e3x8e3x7fHt8e3x7fHx8fXx9fH18fX5+fX59fn9+f35+f35/gH+Af4B/gICAgICAgICAgICAgYCBgIGAgIGAgYGBgoGCgYKBgoGCgYKBgoGCgoKDgoOCg4KDgoOCg4KDgoOCg4KDgoOCg4KDgoOCg4KDgoOCg4KDgoOCg4KDgoOCg4KDgoOCg4KDgoOCg4KCgoGCgYKBgoGCgYKBgoGCgYKBgoGCgYKBgoGCgYKBgoGCgYKBgoGCgYKBgoGBgYCBgIGAgYCBgIGAgYCBgIGAgYCBgIGAgYCBgIGAgYCAgICBgIGAgYCBgIGAgYCBgIGAgYCBgExJU1RCAAAASU5GT0lDUkQMAAAAMjAwOC0wOS0yMQAASUVORwMAAAAgAAABSVNGVBYAAABTb255IFNvdW5kIEZvcmdlIDguMAAA",
              "base64",
            ),
          });
        },
        name: "add",
        parameters: z.object({
          a: z.number(),
          b: z.number(),
        }),
      });

      return server;
    },
  });
});

test("handles UserError errors", async () => {
  await runWithTestServer({
    run: async ({ client }) => {
      expect(
        withoutEnvelope(
          await client.callTool({
            arguments: {
              a: 1,
              b: 2,
            },
            name: "add",
          }),
        ),
      ).toEqual({
        content: [{ text: "Something went wrong", type: "text" }],
        isError: true,
      });
    },
    server: async () => {
      const server = new ViteMCP({
        name: "Test",
        version: "1.0.0",
      });

      server.addTool({
        description: "Add two numbers",
        execute: async () => {
          throw new UserError("Something went wrong");
        },
        name: "add",
        parameters: z.object({
          a: z.number(),
          b: z.number(),
        }),
      });

      return server;
    },
  });
});

test("handles UserError errors with extras", async () => {
  await runWithTestServer({
    run: async ({ client }) => {
      // Should include structuredContent if extras is present
      expect(
        withoutEnvelope(
          await client.callTool({
            arguments: { a: 1, b: 2 },
            name: "add_with_extras",
          }),
        ),
      ).toEqual({
        content: [{ text: "Something went wrong", type: "text" }],
        isError: true,
        structuredContent: { foo: "bar", num: 42 },
      });

      // Should NOT include structuredContent if extras is not present
      expect(
        withoutEnvelope(
          await client.callTool({
            arguments: { a: 1, b: 2 },
            name: "add_without_extras",
          }),
        ),
      ).toEqual({
        content: [{ text: "Something went wrong", type: "text" }],
        isError: true,
      });
    },
    server: async () => {
      const server = new ViteMCP({
        name: "Test",
        version: "1.0.0",
      });

      server.addTool({
        description: "Throws UserError with extras",
        execute: async () => {
          throw new UserError("Something went wrong", { foo: "bar", num: 42 });
        },
        name: "add_with_extras",
        parameters: z.object({ a: z.number(), b: z.number() }),
      });

      server.addTool({
        description: "Throws UserError without extras",
        execute: async () => {
          throw new UserError("Something went wrong");
        },
        name: "add_without_extras",
        parameters: z.object({ a: z.number(), b: z.number() }),
      });

      return server;
    },
  });
});

test("calling an unknown tool throws ProtocolError with InvalidParams code", async () => {
  await runWithTestServer({
    run: async ({ client }) => {
      // `expect.assertions` matters here: without it a `try`/`catch` that never
      // throws would pass having asserted nothing.
      expect.assertions(2);

      try {
        await client.callTool({ arguments: {}, name: "does-not-exist" });
      } catch (error) {
        expect(error).toBeInstanceOf(ProtocolError);
        // Invalid *params*, not an unknown method: `tools/call` exists, the
        // `name` it was given does not. This is the same reasoning behind the
        // revision renumbering resource-not-found from -32002 to -32602.
        expect((error as ProtocolError).code).toBe(
          ProtocolErrorCode.InvalidParams,
        );
      }
    },
    server: async () => {
      const server = new ViteMCP({ name: "Test", version: "1.0.0" });

      // At least one tool must exist, or `tools/call` is not a registered
      // method and the failure is "no such method" rather than "no such tool".
      server.addTool({
        description: "A real tool",
        execute: async () => "ok",
        name: "real",
        parameters: z.object({}),
      });

      return server;
    },
  });
});

test("tracks tool progress", async () => {
  await runWithTestServer({
    run: async ({ client }) => {
      const onProgress = vi.fn();

      await client.callTool(
        {
          arguments: {
            a: 1,
            b: 2,
          },
          name: "add",
        },
        {
          onprogress: onProgress,
        },
      );

      expect(onProgress).toHaveBeenCalledTimes(1);
      expect(onProgress).toHaveBeenCalledWith({
        progress: 0,
        total: 10,
      });
    },
    server: async () => {
      const server = new ViteMCP({
        name: "Test",
        version: "1.0.0",
      });

      server.addTool({
        description: "Add two numbers",
        execute: async (args, { reportProgress }) => {
          reportProgress({
            progress: 0,
            total: 10,
          });

          await delay(100);

          return String(args.a + args.b);
        },
        name: "add",
        parameters: z.object({
          a: z.number(),
          b: z.number(),
        }),
      });

      return server;
    },
  });
});
