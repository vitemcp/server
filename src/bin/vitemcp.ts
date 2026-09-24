#!/usr/bin/env node

import { execa } from "execa";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { buildDevCommand, buildDevConfig } from "./devCommand.js";
import {
  buildStructureCheckCommand,
  formatCommandFailure,
  runTypeCheck,
} from "./validateCommand.js";

await yargs(hideBin(process.argv))
  .scriptName("vitemcp")
  .command(
    "dev <file>",
    "Start a development server",
    (yargs) => {
      return yargs
        .positional("file", {
          demandOption: true,
          describe: "The path to the server file",
          type: "string",
        })

        .option("args", {
          describe:
            "JSON arguments passed to the tool (requires --tool), e.g. '{\"a\":1}'",
          type: "string",
        })

        .option("tool", {
          alias: "t",
          describe:
            "Call a tool non-interactively instead of launching the inspector",
          type: "string",
        })

        .option("watch", {
          alias: "w",
          default: false,
          describe: "Watch for file changes and restart server",
          type: "boolean",
        })

        .option("verbose", {
          alias: "v",
          default: false,
          describe: "Enable verbose logging",
          type: "boolean",
        });
    },

    async (argv) => {
      let configDir: string | undefined;

      try {
        if (argv.args !== undefined && !argv.tool) {
          console.error("[ViteMCP Error] --args requires --tool");
          process.exitCode = 1;
          return;
        }

        if (argv.tool && argv.watch) {
          console.warn(
            "[ViteMCP] --watch is ignored when calling a tool with --tool: the server runs for a single call.",
          );
        }

        let configPath: string | undefined;

        if (argv.tool) {
          configDir = await mkdtemp(join(tmpdir(), "vitemcp-dev-"));
          configPath = join(configDir, "mcp-cli.json");
          await writeFile(configPath, buildDevConfig(argv.file), "utf8");
        }

        const [command, ...commandArgs] = buildDevCommand({
          configPath,
          file: argv.file,
          tool: argv.tool,
          toolArgs: argv.args,
          watch: argv.watch,
        });

        if (argv.verbose) {
          console.log(
            `[ViteMCP] Starting server: ${[command, ...commandArgs].join(" ")}`,
          );
          console.log(`[ViteMCP] File: ${argv.file}`);
          console.log(
            `[ViteMCP] Watch mode: ${argv.watch ? "enabled" : "disabled"}`,
          );

          if (argv.tool) {
            console.log(`[ViteMCP] Tool: ${argv.tool}`);
          }
        }

        await execa(command, commandArgs, {
          stderr: "inherit",
          stdin: "inherit",
          stdout: "inherit",
        });
      } catch (error) {
        console.error(
          "[ViteMCP Error] Failed to start development server:",
          error instanceof Error ? error.message : String(error),
        );

        if (argv.verbose && error instanceof Error && error.stack) {
          console.error("[ViteMCP Debug] Stack trace:", error.stack);
        }

        // Not process.exit(): that would skip the `finally` block below and
        // leak the temporary config directory on every failed tool call.
        process.exitCode = 1;
      } finally {
        if (configDir) {
          await rm(configDir, { force: true, recursive: true });
        }
      }
    },
  )

  .command(
    "inspect <file>",
    "Inspect a server file",
    (yargs) => {
      return yargs.positional("file", {
        demandOption: true,
        describe: "The path to the server file",
        type: "string",
      });
    },

    async (argv) => {
      try {
        await execa({
          stderr: "inherit",
          stdout: "inherit",
        })`npx @modelcontextprotocol/inspector npx tsx ${argv.file}`;
      } catch (error) {
        console.error(
          "[ViteMCP Error] Failed to inspect server:",
          error instanceof Error ? error.message : String(error),
        );

        process.exit(1);
      }
    },
  )

  .command(
    "validate <file>",
    "Validate a ViteMCP server file for syntax and basic structure",
    (yargs) => {
      return yargs
        .positional("file", {
          demandOption: true,
          describe: "The path to the server file",
          type: "string",
        })

        .option("strict", {
          alias: "s",
          default: false,
          describe: "Enable strict validation (type checking)",
          type: "boolean",
        });
    },

    async (argv) => {
      try {
        const { existsSync } = await import("fs");
        const { resolve } = await import("path");
        const filePath = resolve(argv.file);

        if (!existsSync(filePath)) {
          console.error(`[ViteMCP Error] File not found: ${filePath}`);
          process.exit(1);
        }

        console.log(`[ViteMCP] Validating server file: ${filePath}`);

        const typeCheck = await runTypeCheck(filePath, argv.strict);

        if (typeCheck.failed) {
          console.error("[ViteMCP] ✗ TypeScript compilation failed");

          const diagnostics = formatCommandFailure(typeCheck);

          if (diagnostics) {
            console.error(diagnostics);
          }

          process.exit(1);
        }

        console.log("[ViteMCP] ✓ TypeScript compilation successful");

        const [structureCommand, ...structureArgs] =
          buildStructureCheckCommand(filePath);
        const structureCheck = await execa(structureCommand, structureArgs, {
          reject: false,
        });

        if (structureCheck.failed) {
          // The child explains the failure on stderr, which execa captures.
          // Without replaying it the user only ever sees the generic hint, even
          // when their server file has an error they could act on.
          const reason = formatCommandFailure(structureCheck);

          if (reason) {
            console.error(reason);
          } else {
            console.error("[ViteMCP] ✗ Server structure validation failed");
            console.error(
              "Make sure the file properly imports and uses ViteMCP",
            );
          }

          process.exit(1);
        }

        console.log(
          "[ViteMCP] ✓ All validations passed! Server file looks good.",
        );
      } catch (error) {
        console.error(
          "[ViteMCP Error] Validation failed:",
          error instanceof Error ? error.message : String(error),
        );

        process.exit(1);
      }
    },
  )

  .help()
  .parseAsync();
