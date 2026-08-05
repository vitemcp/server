/**
 * Multi round-trip requests (MRTR).
 *
 * On the 2026-07-28 revision a server cannot pause mid-execution to ask the
 * client a question — there is no session holding the suspended call. Instead
 * the handler *returns* a request for more input and the client re-issues the
 * whole call with the answers attached.
 *
 * Two things this example exists to demonstrate, because both are easy to get
 * wrong:
 *
 *   1. Handlers are RE-ENTRANT. `execute` runs again from the top on the
 *      retry, so nothing irreversible may happen before the input arrives.
 *   2. `requestState` round-trips through the client and comes back
 *      ATTACKER-CONTROLLED. If it influences authorization or resource access
 *      it must be integrity-protected and verified — the SDK does not do this
 *      for you.
 *
 * Run with: npx @vitemcp/server dev src/examples/multi-round-trip.ts
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { ViteMCP } from "../ViteMCP.js";

const server = new ViteMCP({
  name: "Multi round-trip example",
  version: "1.0.0",
});

/** In a real server this comes from configuration, not a literal. */
const STATE_SECRET = process.env.REQUEST_STATE_SECRET ?? "dev-only-secret";

/**
 * Signs server-minted state so tampering is detectable on the way back.
 *
 * Without this, a client could edit `requestState` and re-drive the handler
 * with values the server never issued.
 */
const sealState = (payload: object): string => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", STATE_SECRET)
    .update(body)
    .digest("base64url");
  return `${body}.${mac}`;
};

/** Returns the payload only if the signature verifies. */
const openState = <T>(state: string | undefined): T | undefined => {
  if (!state) {
    return undefined;
  }

  const [body, mac] = state.split(".");

  if (!body || !mac) {
    return undefined;
  }

  const expected = createHmac("sha256", STATE_SECRET)
    .update(body)
    .digest("base64url");

  // Constant-time compare; lengths must match first or timingSafeEqual throws.
  if (
    mac.length !== expected.length ||
    !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
  ) {
    return undefined;
  }

  return JSON.parse(Buffer.from(body, "base64url").toString()) as T;
};

const confirmSchema = z.object({
  confirmed: z.boolean(),
});

server.addTool({
  description: "Deletes a deployment, asking the user to confirm first",
  execute: async ({ environment }, ctx) => {
    // FIRST ROUND: no answers yet, so ask and return.
    if (!ctx.inputResponses) {
      return ctx.inputRequired(
        {
          confirm: ctx.elicit({
            message: `Really delete the ${environment} deployment?`,
            requestedSchema: confirmSchema,
          }),
        },
        // Signed: this comes back through the client before we act on it.
        sealState({ environment }),
      );
    }

    // SECOND ROUND: verify the state we minted is the state we got back.
    const state = openState<{ environment: string }>(ctx.requestState);

    if (!state) {
      throw new Error("Request state missing or failed verification");
    }

    // `ctx.input` returns undefined when the client declined or answered with
    // something that does not match the schema. That is distinct from a "no",
    // so the two cases are handled separately rather than collapsed.
    const answer = ctx.input("confirm", confirmSchema);

    if (answer === undefined) {
      return "Cancelled: no confirmation was provided.";
    }

    if (!answer.confirmed) {
      return `Left the ${state.environment} deployment alone.`;
    }

    // Only now does anything irreversible happen.
    return `Deleted the ${state.environment} deployment.`;
  },
  name: "delete-deployment",
  parameters: z.object({
    environment: z.enum(["production", "staging"]),
  }),
});

await server.start({
  httpStream: { port: 4400 },
  transportType: "httpStream",
});

console.log(`Multi round-trip example running on http://localhost:4400/mcp

Call the "delete-deployment" tool. The first call returns an
\`input_required\` result; your client answers the elicitation and re-issues
the call, and the second round performs the deletion.
`);
