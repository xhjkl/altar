import type { H3Event } from "h3";
import { toWebRequest } from "h3";
import { POST as postDb } from "./lib/db";

export async function onRequest(event: H3Event) {
  const url = new URL(event.path, "http://localhost");
  if (event.method !== "POST" || url.pathname !== "/") return;

  await event.respondWith(postDb({ request: toWebRequest(event) }));
}

export default { onRequest };
