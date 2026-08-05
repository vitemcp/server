/**
 * Example demonstrating per-request auth context in ViteMCP.
 *
 * On the 2026-07-28 revision there is no protocol session: every request is
 * self-contained. The `authenticate` hook runs per request and its result is
 * handed to each handler as `context.auth`.
 *
 * To run this example:
 * npx @vitemcp/server dev src/examples/auth-context.ts
 */

import { z } from "zod";

import { ViteMCP } from "../ViteMCP.js";

interface UserSession {
  [key: string]: unknown;
  authenticatedAt: string;
  permissions: string[];
  role: "admin" | "guest" | "user";
  userId: string;
  username: string;
}

const sessionForRole = (
  userId: string,
  username: string,
  role: "admin" | "guest" | "user",
): UserSession => ({
  authenticatedAt: new Date().toISOString(),
  permissions:
    role === "admin"
      ? ["read", "write", "delete", "admin"]
      : role === "user"
        ? ["read", "write"]
        : ["read"],
  role,
  userId,
  username,
});

const server = new ViteMCP<UserSession>({
  authenticate: async (request) => {
    const authHeader = request.headers.get("authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return sessionForRole("anonymous", "Anonymous", "guest");
    }

    const token = authHeader.slice("Bearer ".length);

    // Mock token -> user mapping. A real server would verify the token.
    if (token === "admin-token") {
      return sessionForRole("admin-1", "Admin", "admin");
    }

    return sessionForRole(`user-${token.slice(0, 6)}`, "User", "user");
  },
  name: "Auth Context Example",
  version: "1.0.0",
});

server.addTool({
  description: "Report who the caller is authenticated as",
  execute: async (_args, { auth }) => {
    if (!auth) {
      return "No auth context available.";
    }

    return [
      `User ID: ${auth.userId}`,
      `Username: ${auth.username}`,
      `Role: ${auth.role}`,
      `Permissions: ${auth.permissions.join(", ")}`,
      `Authenticated at: ${auth.authenticatedAt}`,
    ].join("\n");
  },
  name: "whoami",
});

server.addTool({
  // `canAccess` filters the tool out of `tools/list` for callers that lack the
  // permission, so unauthorized users never see it advertised.
  canAccess: (auth) => auth?.permissions.includes("admin") ?? false,
  description: "An action only admins may call",
  execute: async (_args, { auth }) => `Admin action run by ${auth?.username}.`,
  name: "admin-action",
});

server.addTool({
  description: "Greet the authenticated user",
  execute: async (args, { auth }) => {
    if (!auth) {
      return "Hello! I don't know who you are.";
    }

    const greetings = {
      casual: `Hey ${auth.username}! Nice to see you again.`,
      formal: `Good day, ${auth.username}. You hold ${auth.role} privileges.`,
      friendly: `Hello ${auth.username}! You're logged in as a ${auth.role}.`,
    };

    return greetings[args.style ?? "friendly"];
  },
  name: "greet",
  parameters: z.object({
    style: z.enum(["casual", "formal", "friendly"]).optional(),
  }),
});

server.addResource({
  description: "The current caller's identity, as JSON",
  load: async ({ auth }) => ({
    text: JSON.stringify(
      auth
        ? {
            authenticated: true,
            user: {
              authenticatedAt: auth.authenticatedAt,
              id: auth.userId,
              permissions: auth.permissions,
              role: auth.role,
              username: auth.username,
            },
          }
        : { authenticated: false },
      null,
      2,
    ),
  }),
  mimeType: "application/json",
  name: "Current User",
  uri: "auth://current-user",
});

server.start({
  httpStream: { port: 4300 },
  transportType: "httpStream",
});

console.log(`Auth context example running on http://localhost:4300/mcp

Try it with different tokens:
  Authorization: Bearer admin-token   -> admin role
  Authorization: Bearer any-other     -> user role
  (no header)                         -> guest role
`);
