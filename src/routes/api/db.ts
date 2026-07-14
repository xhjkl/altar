import type { APIEvent } from "@solidjs/start/server";
import type { DbRequest, DbResponse } from "~/lib/db-contract";
import { handleDbRequest } from "~/server/postgres";

/** JSON boundary for the local PostgreSQL gateway. */
export async function POST(event: APIEvent) {
  try {
    const request = (await event.request.json()) as DbRequest;
    const result = await handleDbRequest(request);
    return json({ ok: true, result });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown database error",
      },
      500,
    );
  }
}

function json<T>(body: DbResponse<T>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}
