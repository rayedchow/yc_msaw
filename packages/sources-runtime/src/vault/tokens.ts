import { db } from "../db/client.js";
import { integrationTokens } from "../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import { encrypt, decrypt } from "./encryption.js";

export async function storeToken(
  userId: string,
  provider: string,
  accessToken: string,
  metadata?: Record<string, unknown>,
  refreshToken?: string,
): Promise<void> {
  const encryptedToken = encrypt(accessToken);
  const encryptedRefresh = refreshToken ? encrypt(refreshToken) : undefined;

  await db
    .insert(integrationTokens)
    .values({
      userId,
      provider,
      accessToken: encryptedToken,
      refreshToken: encryptedRefresh ?? null,
      metadata: metadata ?? null,
    })
    .onConflictDoUpdate({
      target: [integrationTokens.userId, integrationTokens.provider],
      set: {
        accessToken: encryptedToken,
        ...(encryptedRefresh !== undefined ? { refreshToken: encryptedRefresh } : {}),
        metadata: metadata ?? undefined,
        updatedAt: new Date(),
      },
    });
}

export async function deleteToken(userId: string, provider: string): Promise<void> {
  await db
    .delete(integrationTokens)
    .where(and(eq(integrationTokens.userId, userId), eq(integrationTokens.provider, provider)));
}

export async function getTokenFull(
  userId: string,
  provider: string,
): Promise<{ token: string; refreshToken: string | null; metadata: Record<string, unknown> | null } | null> {
  const [row] = await db
    .select({
      accessToken: integrationTokens.accessToken,
      refreshToken: integrationTokens.refreshToken,
      metadata: integrationTokens.metadata,
    })
    .from(integrationTokens)
    .where(and(eq(integrationTokens.userId, userId), eq(integrationTokens.provider, provider)))
    .limit(1);

  if (!row) return null;
  return {
    token: decrypt(row.accessToken),
    refreshToken: row.refreshToken ? decrypt(row.refreshToken) : null,
    metadata: row.metadata as Record<string, unknown> | null,
  };
}

export async function updateTokenMetadata(
  userId: string,
  provider: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db
    .update(integrationTokens)
    .set({ metadata: metadata as any, updatedAt: new Date() })
    .where(and(eq(integrationTokens.userId, userId), eq(integrationTokens.provider, provider)));
}

export async function mergeTokenMetadata(
  userId: string,
  provider: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await db
    .update(integrationTokens)
    .set({
      metadata: sql`COALESCE(${integrationTokens.metadata}, '{}'::jsonb) || ${JSON.stringify(fields)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(integrationTokens.userId, userId), eq(integrationTokens.provider, provider)));
}

export async function getTokenMetadata(
  userId: string,
  provider: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ metadata: integrationTokens.metadata })
    .from(integrationTokens)
    .where(and(eq(integrationTokens.userId, userId), eq(integrationTokens.provider, provider)))
    .limit(1);

  return row ? row.metadata as Record<string, unknown> | null : null;
}

export async function getToken(userId: string, provider: string): Promise<string | null> {
  const [row] = await db
    .select({ accessToken: integrationTokens.accessToken })
    .from(integrationTokens)
    .where(and(eq(integrationTokens.userId, userId), eq(integrationTokens.provider, provider)))
    .limit(1);

  if (!row) return null;
  return decrypt(row.accessToken);
}

export async function getTokenWithMetadata(
  userId: string,
  provider: string,
): Promise<{ token: string; metadata: Record<string, unknown> | null } | null> {
  const [row] = await db
    .select({ accessToken: integrationTokens.accessToken, metadata: integrationTokens.metadata })
    .from(integrationTokens)
    .where(and(eq(integrationTokens.userId, userId), eq(integrationTokens.provider, provider)))
    .limit(1);

  if (!row) return null;
  return {
    token: decrypt(row.accessToken),
    metadata: row.metadata as Record<string, unknown> | null,
  };
}
