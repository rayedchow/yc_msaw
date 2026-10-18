import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { integrationTokens } from "../../db/schema.js";
import { safeCompareKey } from "../../middleware/auth.js";
import { decrypt } from "../../vault/encryption.js";

export interface ImessageAuthContext {
  userId: string;
  kind: "admin" | "agent";
}

export function createImessageAgentToken(): string {
  return `gimsg_${randomBytes(32).toString("base64url")}`;
}

let cachedAgentTokens: Map<string, string> | null = null;
let cacheBuiltAt = 0;
const CACHE_TTL_MS = 60_000;

async function getAgentTokenMap(): Promise<Map<string, string>> {
  if (cachedAgentTokens && Date.now() - cacheBuiltAt < CACHE_TTL_MS) {
    return cachedAgentTokens;
  }
  const rows = await db
    .select({
      userId: integrationTokens.userId,
      accessToken: integrationTokens.accessToken,
    })
    .from(integrationTokens)
    .where(eq(integrationTokens.provider, "imessage"));

  const map = new Map<string, string>();
  for (const row of rows) {
    const token = decrypt(row.accessToken);
    if (token.startsWith("gimsg_")) {
      const tokenHash = createHash("sha256").update(token).digest("hex");
      map.set(tokenHash, row.userId);
    }
  }
  cachedAgentTokens = map;
  cacheBuiltAt = Date.now();
  return map;
}

export function invalidateTokenCache(): void {
  cachedAgentTokens = null;
  cacheBuiltAt = 0;
}

export async function resolveImessageAuth(
  providedKey: string | null | undefined,
  requestedUserId?: string,
): Promise<ImessageAuthContext | null> {
  if (!providedKey) return null;

  if (safeCompareKey(providedKey)) {
    return { userId: requestedUserId || "default", kind: "admin" };
  }

  if (providedKey.startsWith("gimsg_")) {
    const tokenMap = await getAgentTokenMap();
    const providedHash = createHash("sha256").update(providedKey).digest("hex");
    const userId = tokenMap.get(providedHash);
    if (userId) {
      return { userId, kind: "agent" };
    }
  }

  return null;
}
