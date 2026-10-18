import { db } from "../../db/client.js";
import { documentSummaries } from "../../db/schema.js";

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

export async function markGoogleDocSummaryDirty(input: {
  userId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  changedAt: string;
}): Promise<void> {
  if (input.mimeType !== GOOGLE_DOC_MIME) return;

  const changedAt = parseDate(input.changedAt) ?? new Date();

  await db
    .insert(documentSummaries)
    .values({
      userId: input.userId,
      docId: input.fileId,
      title: input.fileName || input.fileId,
      dirtyAt: changedAt,
      lastUpdated: changedAt,
    })
    .onConflictDoUpdate({
      target: [documentSummaries.userId, documentSummaries.docId],
      set: {
        title: input.fileName || input.fileId,
        dirtyAt: changedAt,
        lastUpdated: changedAt,
      },
    });
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
