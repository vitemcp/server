import { execa } from "execa";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildStructureCheckCommand,
  buildTypeCheckCommand,
  buildTypeCheckConfig,
  findTsconfig,
  formatCommandFailure,
  missingTsxHint,
  resolveTsxLoader,
  runTypeCheck,
  STRUCTURE_CHECK_SCRIPT,
} from "./validateCommand.js";

/** A directory name carrying each character that splicing the path broke on. */
const AWKWARD_NAME = "it's #1 with spaces";

const created: string[] = [];

afterAll(async () => {
  await Promise.all(
    created.map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

const makeDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "vitemcp-validate-"));
  created.push(dir);
  return dir;
};

/** Writes `files` under `dir`, creating any directories they need. */
const writeFiles = async (dir: string, files: Record<string, string>) => {
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), contents, "utf8");
  }
};

describe("buildTypeCheckCommand", () => {
  it("checks through a config rather than naming the file", () => {
    expect(buildTypeCheckCommand("/p/tsconfig.x.json")).toEqual([
      "npx",
      "tsc",
      "--noEmit",
      "--project",
      "/p/tsconfig.x.json",
    ]);
  });

  it("adds --strict", () => {
    expect(buildTypeCheckCommand("/p/tsconfig.x.json", true).at(-1)).toBe(
      "--strict",
    );
  });
});

describe("buildTypeCheckConfig", () => {
  it("extends the project's config and lists only the file", () => {
    expect(
      JSON.parse(buildTypeCheckConfig("/p/src/server.ts", "/p/tsconfig.json")),
    ).toEqual({
      compilerOptions: {
        composite: false,
        declarationMap: false,
        emitDeclarationOnly: false,
        incremental: false,
        isolatedDeclarations: false,
      },
      extends: "/p/tsconfig.json",
      files: ["/p/src/server.ts"],
      include: [],
    });
  });

  it("targets a modern runtime when no project config governs the file", () => {
    const config = JSON.parse(buildTypeCheckConfig("/p/server.ts"));

    expect(config.extends).toBeUndefined();
    expect(config.compilerOptions).toMatchObject({
      module: "esnext",
      target: "es2022",
    });
  });
});

describe("findTsconfig", () => {
  it("finds the nearest config at or above the directory", async () => {
    const root = await makeDir();
    await writeFiles(root, {
      "a/b/server.ts": "",
      "a/tsconfig.json": "{}",
      "tsconfig.json": "{}",
    });

    expect(findTsconfig(join(root, "a", "b"))).toBe(
      join(root, "a", "tsconfig.json"),
    );
    expect(findTsconfig(join(root, "a"))).toBe(
      join(root, "a", "tsconfig.json"),
    );
  });
});

// These run the real compiler, which `npx` resolves from this repository.
describe("runTypeCheck", { timeout: 60_000 }, () => {
  /**
   * A project whose server file passes only under the project's own config:
   * `tsc <file>` would fall back to ES5 and reject its top-level await, and
   * checking the whole project would report `unrelated.ts`.
   */
  const makeProject = async (
    server: string,
    compilerOptions: Record<string, unknown> = {},
  ): Promise<string> => {
    const project = join(await makeDir(), AWKWARD_NAME);
    await writeFiles(project, {
      "greeting.ts": 'export const greeting = "hi";\n',
      "package.json": JSON.stringify({ type: "module" }),
      "server.ts": server,
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          // Without their overrides, `composite` would demand that
          // `greeting.ts` be listed as a root alongside the server file, and
          // `incremental` would leave a `.tsbuildinfo` in the project.
          composite: true,
          incremental: true,
          module: "nodenext",
          strict: true,
          target: "es2022",
          ...compilerOptions,
        },
        // Inherited unless overridden, and would pull in `unrelated.ts`.
        include: ["*.ts"],
      }),
      "unrelated.ts": 'export const broken: number = "not a number";\n',
    });
    return project;
  };

  it("checks the file under the project's own compiler options", async () => {
    const project = await makeProject(
      'import { greeting } from "./greeting.js";\n' +
        "export const message: string = await Promise.resolve(greeting);\n",
    );
    const before = await readdir(project);

    const result = await runTypeCheck(join(project, "server.ts"));

    // The output only explains a failure. A passing check need not be silent:
    // under `pnpm test`, npx warns on stderr about the npm_config_* variables
    // pnpm sets.
    expect(result.failed, formatCommandFailure(result)).toBe(false);
    // Neither the throwaway config nor a `.tsbuildinfo` is left behind.
    expect(await readdir(project)).toEqual(before);
  });

  it("reports the diagnostics tsc writes to stdout", async () => {
    const project = await makeProject(
      'export const count: number = "not a number";\n',
    );

    const result = await runTypeCheck(join(project, "server.ts"));

    expect(result.failed).toBe(true);
    expect(formatCommandFailure(result)).toContain("error TS2322");
    expect(formatCommandFailure(result)).not.toContain("unrelated.ts");
  });

  // Each requires `declaration`, which this project has only by way of
  // `composite` — and the check switches `composite` off.
  it.each(["declarationMap", "emitDeclarationOnly", "isolatedDeclarations"])(
    "checks a composite project that sets %s without declaration",
    async (option) => {
      const passing = await makeProject("export const port = 8080;\n", {
        [option]: true,
      });
      const passed = await runTypeCheck(join(passing, "server.ts"));

      expect(passed.failed, formatCommandFailure(passed)).toBe(false);

      const failing = await makeProject(
        'export const port: number = "8080";\n',
        { [option]: true },
      );
      const failed = await runTypeCheck(join(failing, "server.ts"));

      expect(formatCommandFailure(failed)).toContain("error TS2322");
      expect(formatCommandFailure(failed)).not.toContain("TS5069");
    },
  );

  it.skipIf(findTsconfig(tmpdir()) !== undefined)(
    "checks a file no tsconfig.json governs against a modern runtime",
    async () => {
      const dir = join(await makeDir(), AWKWARD_NAME);
      await writeFiles(dir, {
        "server.ts": "export const ready = await Promise.resolve(true);\n",
      });

      const result = await runTypeCheck(join(dir, "server.ts"));

      expect(result.failed, formatCommandFailure(result)).toBe(false);
      expect(await readdir(dir)).toEqual(["server.ts"]);
    },
  );
});

describe("buildStructureCheckCommand", () => {
  it("keeps the file out of the script source", () => {
    const args = buildStructureCheckCommand("C:\\Users\\dev\\server.ts");

    expect(args[2]).toBe(STRUCTURE_CHECK_SCRIPT);

    // A Windows path spliced into this source lands inside a JavaScript string
    // literal, so the child's parser eats the backslashes and the import fails
    // with ERR_INVALID_URL. Keeping the script free of the file is the fix.
    expect(STRUCTURE_CHECK_SCRIPT).not.toContain("file://");
    expect(STRUCTURE_CHECK_SCRIPT).not.toContain("server.ts");
  });

  it("passes the file as a file: URL", () => {
    const file = `/tmp/${AWKWARD_NAME}/server.ts`;
    const url = buildStructureCheckCommand(file).at(-1);

    expect(url).toBe(pathToFileURL(file).href);
    expect(url).toContain("%20");
    expect(url).toContain("%23");
  });

  it("imports the file through the tsx loader it is given", () => {
    const loader = "file:///project/node_modules/tsx/dist/loader.mjs";
    const [, ...args] = buildStructureCheckCommand("/project/server.ts", {
      tsxLoader: loader,
    });

    expect(args).toEqual([
      "--disable-warning=DEP0205",
      "--import",
      loader,
      "-e",
      STRUCTURE_CHECK_SCRIPT,
      pathToFileURL("/project/server.ts").href,
    ]);
  });
});

describe("resolveTsxLoader", () => {
  it("finds the tsx of the project the file belongs to", async () => {
    const project = join(await makeDir(), AWKWARD_NAME);
    const loader = "node_modules/tsx/dist/loader.mjs";
    await writeFiles(project, {
      [loader]: "",
      "node_modules/tsx/package.json": JSON.stringify({
        exports: "./dist/loader.mjs",
        name: "tsx",
      }),
    });

    expect(resolveTsxLoader(join(project, "src/server.ts"))).toBe(
      pathToFileURL(await realpath(join(project, loader))).href,
    );
  });

  it("is undefined when the project has no tsx", async () => {
    expect(
      resolveTsxLoader(join(await makeDir(), "server.ts")),
    ).toBeUndefined();
  });
});

describe("missingTsxHint", () => {
  const loader = "file:///project/node_modules/tsx/dist/loader.mjs";

  it("suggests tsx for a TypeScript file loaded without it", () => {
    expect(missingTsxHint("/project/server.ts", undefined)).toContain(
      "npm install --save-dev tsx",
    );
    expect(missingTsxHint("/project/server.mts", undefined)).toBeDefined();
  });

  it("says nothing once the file was loaded through tsx", () => {
    expect(missingTsxHint("/project/server.ts", loader)).toBeUndefined();
  });

  it("says nothing for a JavaScript file, which plain Node loads as tsx would", () => {
    expect(missingTsxHint("/project/server.mjs", undefined)).toBeUndefined();
  });
});

describe("the structure check script", { timeout: 30_000 }, () => {
  /**
   * A project holding just enough of an `@vitemcp/server` package for the
   * script's own `import("@vitemcp/server")` to resolve, since a bare specifier
   * in a `node -e` script resolves from the working directory. Standing one in
   * matters: the release job runs the tests before it builds, so the real entry
   * point (`dist/ViteMCP.js`) does not exist yet.
   */
  const makeProject = async (): Promise<string> => {
    const project = await makeDir();
    await writeFiles(project, {
      "node_modules/@vitemcp/server/index.js":
        "export const ViteMCP = class {};\n",
      "node_modules/@vitemcp/server/package.json": JSON.stringify({
        exports: "./index.js",
        name: "@vitemcp/server",
        type: "module",
        version: "0.0.0",
      }),
    });
    return project;
  };

  const check = async (
    project: string,
    file: string,
    server: string,
    tsxLoader?: string,
  ) => {
    await writeFiles(project, { [file]: server });
    const [command, ...args] = buildStructureCheckCommand(join(project, file), {
      tsxLoader,
    });

    return execa(command, args, {
      cwd: project,
      reject: false,
      timeout: 10_000,
    });
  };

  it("imports a server file whose path needs escaping", async () => {
    const result = await check(
      await makeProject(),
      `${AWKWARD_NAME}/server.mjs`,
      "export default {};\n",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Server structure validation passed");
  });

  it("exits once a server file that keeps running has loaded", async () => {
    // A server file starts its transport on load; without an explicit exit
    // the check never finishes.
    const result = await check(
      await makeProject(),
      "server.mjs",
      "setInterval(() => {}, 60_000);\n",
    );

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("reports why a server file could not be imported", async () => {
    const result = await check(
      await makeProject(),
      "broken.mjs",
      "throw new Error('boom');\n",
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Server structure validation failed: boom");
  });

  describe("through the project's tsx", () => {
    // This repository's own tsx, standing in for the one a project installs.
    const tsxLoader = resolveTsxLoader(fileURLToPath(import.meta.url));

    it("is installed here", () => {
      expect(tsxLoader).toMatch(/^file:.*\/tsx\//);
    });

    it("follows a `.js` import to the `.ts` file beside it", async () => {
      // Plain Node looks for a `tools.js` on disk and fails the check, though
      // `vitemcp dev` runs the file fine.
      const project = await makeProject();
      await writeFiles(project, {
        [`${AWKWARD_NAME}/tools.ts`]:
          "export const add = (a: number, b: number): number => a + b;\n",
      });

      const result = await check(
        project,
        `${AWKWARD_NAME}/server.ts`,
        'import { add } from "./tools.js";\n\nexport const sum: number = add(1, 2);\n',
        tsxLoader,
      );

      expect(result.exitCode, formatCommandFailure(result)).toBe(0);
      expect(result.stdout).toContain("Server structure validation passed");
    });

    it("runs syntax that plain Node cannot strip", async () => {
      const result = await check(
        await makeProject(),
        "server.ts",
        [
          "enum Transport { Stdio, Http }",
          "class Server { constructor(private readonly transport: Transport) {} }",
          "export const server = new Server(Transport.Stdio);",
          "",
        ].join("\n"),
        tsxLoader,
      );

      expect(result.exitCode, formatCommandFailure(result)).toBe(0);
    });

    it("still reports why a server file could not be imported", async () => {
      const result = await check(
        await makeProject(),
        "broken.ts",
        "throw new Error('boom');\n",
        tsxLoader,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Server structure validation failed: boom",
      );
      // tsx's own deprecation warning, which would read as the file's.
      expect(result.stderr).not.toContain("DEP0205");
    });
  });
});

describe("formatCommandFailure", () => {
  it("replays the diagnostics tsc wrote to stdout", () => {
    expect(
      formatCommandFailure({
        stderr: "",
        stdout: "server.ts(1,1): error TS2304: Cannot find name 'x'.\n",
      }),
    ).toBe("server.ts(1,1): error TS2304: Cannot find name 'x'.");
  });

  it("puts stderr first, where a failure to launch reports", () => {
    expect(
      formatCommandFailure({ stderr: "npx: command not found", stdout: "x" }),
    ).toBe("npx: command not found\nx");
  });

  it("is empty when the command printed nothing", () => {
    expect(formatCommandFailure({})).toBe("");
  });
});
