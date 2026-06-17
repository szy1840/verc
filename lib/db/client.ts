import { neon } from "@neondatabase/serverless";

// Neon HTTP driver — one round-trip per query, ideal for serverless functions
// (design §7). The HTTP path ignores `channel_binding`, so the connection
// string works as-is. Access always goes through the Store (store.ts).

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set (see .env.local)");
}

export const sql = neon(url);
