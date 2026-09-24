import { randomUUID } from "crypto";
import { execa } from "execa";
import { existsSync } from "fs";
import { rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

/**
 * The script `vitemcp validate` runs to check that a server file loads.
 *
 * The file arrives as `process.argv[1]` rather than being spliced into this
 * source. Spliced into a string literal, a Windows path loses its backslashes
 * to the child's own parser (`C:\Users\dev\server.ts` reaches the import as
 * `C:Usersdevserver.ts`), and a quote or `#` in any path breaks the import —
 * each reported to the user as a problem with their file.
 *
 * It exits as soon as the import settles, once its verdict is flushed. A
 * server file normally starts its transport on load, which would otherwise
 * keep this process, and the command waiting on it, alive forever.
 */
export const STRUCTURE_CHECK_SCRIPT = `
(async () => {
  let failure;

  try {
    await import("@vitemcp/server");
    await import(process.argv[1]);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  if (failure === undefined) {
    process.stdout.write(
      "[ViteMCP] ✓ Server structure validation passed\\n",
      () => process.exit(0),
    );
  } else {
    process.stderr.write(
      "[ViteMCP] ✗ Server structure validation failed: " + failure + "\\n",
      () => process.exit(1),
    );
  }
})();
`;

/**
 * Compiler options for a file with no `tsconfig.json` above it. The compiler's
 * own defaults target ES5, which rejects top-level await and the `#private`
 * members in `@vitemcp/server`'s declarations, so no server file could pass.
 */
const STANDALONE_COMPILER_OPTIONS = {
  allowImportingTsExtensions: true,
  module: "esnext",
  moduleResolution: "bundler",
  skipLibCheck: true,
  target: "es2022",
};

/**
 * What the throwaway config overrides in the project's own. `composite`
 * demands that every file the server imports be listed as a root, and only the
 * server file is; `incremental` writes a `.tsbuildinfo` named after the
 * throwaway config into the project.
 */
const PROJECT_OVERRIDES = { composite: false, incremental: false };

/**
 * Build the argv for the structure check.
 *
 * An argv array rather than a shell string, as in `buildDevCommand`, so nothing
 * has to be quoted. The file is converted to a `file:` URL here, so the child
 * imports it as given and never has to build the URL itself; and the child is
 * the Node binary running this CLI, so no PATH lookup is involved.
 */
export const buildStructureCheckCommand = (
  file: string,
  execPath: string = process.execPath,
): [string, ...string[]] => [
  execPath,
  "-e",
  STRUCTURE_CHECK_SCRIPT,
  pathToFileURL(file).href,
];

/**
 * Build the argv for the type check. An argv array for the same reason as the
 * structure check: through a shell, a path containing a space reaches `tsc` as
 * several root files.
 */
export const buildTypeCheckCommand = (
  config: string,
  strict = false,
): [string, ...string[]] => [
  "npx",
  "tsc",
  "--noEmit",
  "--project",
  config,
  ...(strict ? ["--strict"] : []),
];

/**
 * Build the throwaway config that type-checks one file.
 *
 * `tsc` ignores `tsconfig.json` whenever a file is named on its command line
 * and falls back to defaults no server file passes, so the file is named in a
 * config that extends the project's own instead. `include: []` keeps an
 * inherited `include` from pulling the rest of the project in.
 */
export const buildTypeCheckConfig = (file: string, tsconfig?: string): string =>
  JSON.stringify(
    tsconfig
      ? {
          compilerOptions: PROJECT_OVERRIDES,
          extends: tsconfig,
          files: [file],
          include: [],
        }
      : {
          compilerOptions: STANDALONE_COMPILER_OPTIONS,
          files: [file],
          include: [],
        },
    null,
    2,
  );

/**
 * The `tsconfig.json` that governs a file in `dir`: the nearest one at or above
 * it, which is also the one an editor checks the file against.
 */
export const findTsconfig = (dir: string): string | undefined => {
  for (let current = dir; ; current = dirname(current)) {
    const candidate = join(current, "tsconfig.json");

    if (existsSync(candidate)) {
      return candidate;
    }

    if (dirname(current) === current) {
      return undefined;
    }
  }
};

/**
 * The output of a failed check, for replaying to the user.
 *
 * `tsc` writes its diagnostics to stdout, and only a failure to launch it
 * reaches stderr, so reading stderr alone reported every real type error with
 * no detail. The structure check explains itself on stderr.
 */
export const formatCommandFailure = (result: {
  stderr?: unknown;
  stdout?: unknown;
}): string =>
  [result.stderr, result.stdout]
    .map((output) => (typeof output === "string" ? output.trim() : ""))
    .filter(Boolean)
    .join("\n");

/**
 * Type-check `file` under the compiler options of the project it belongs to.
 *
 * The throwaway config is written beside the project's own rather than to the
 * OS temp directory, because the compiler resolves type packages — the `types`
 * option and every visible `@types` package — from the config's directory. It
 * is removed before this returns, so a caller may exit straight away.
 */
export const runTypeCheck = async (file: string, strict = false) => {
  const tsconfig = findTsconfig(dirname(file));
  const config = join(
    dirname(tsconfig ?? file),
    `tsconfig.vitemcp-validate-${randomUUID()}.json`,
  );

  await writeFile(config, buildTypeCheckConfig(file, tsconfig), {
    flag: "wx",
  });

  try {
    const [command, ...args] = buildTypeCheckCommand(config, strict);

    return await execa(command, args, { reject: false });
  } finally {
    await rm(config, { force: true });
  }
};
