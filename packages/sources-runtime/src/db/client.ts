import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { env } from "../env.js";

const isLocal = env.DATABASE_URL.includes("localhost") || env.DATABASE_URL.includes("127.0.0.1");

export const pgClient = postgres(env.DATABASE_URL, {
  ssl: isLocal ? false : "require",
});

export const db = drizzle(pgClient, { schema });
