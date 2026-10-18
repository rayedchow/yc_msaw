import { intakeBinaryDocument } from "../binary/intake.js";
import { slackThrottle } from "./rate-limit.js";

// Slack message file attachments: metadata always lands (redacted) in the raw
// activity_events payload; this module additionally captures the BYTES into
// the existing S3 + binary_documents lane. Downloads use the stored user
// token against url_private_download (credentialed URLs never persist - the
// redaction pass scrubs them from raw payloads; only file ids do).
export const SLACK_FILE_MAX_BYTES = 25 * 1024 * 1024;

export interface SlackFileCaptureResult {
  stored: number;
  skips: Record<string, number>;
}

export async function captureSlackMessageFiles(input: {
  userId: string;
  token: string;
  channelId: string;
  files: unknown;
}): Promise<SlackFileCaptureResult> {
  const skips: Record<string, number> = {};
  let stored = 0;
  if (!Array.isArray(input.files)) return { stored, skips };

  for (const raw of input.files) {
    const file = isRecord(raw) ? raw : {};
    const fileId = stringField(file.id);
    if (!fileId) {
      bump(skips, "file_missing_id");
      continue;
    }
    const size = numberField(file.size);
    if (size != null && size > SLACK_FILE_MAX_BYTES) {
      bump(skips, "file_bytes_over_25mb");
      continue;
    }
    const downloadUrl = stringField(file.url_private_download) ?? stringField(file.url_private);
    if (!downloadUrl) {
      // External/tombstoned/access-denied files expose no private download URL.
      bump(skips, "file_no_download_url");
      continue;
    }

    const createdSeconds = numberField(file.timestamp) ?? numberField(file.created);
    const result = await intakeBinaryDocument({
      tenantId: input.userId,
      provider: "slack",
      externalId: fileId,
      mimeType: stringField(file.mimetype) ?? "application/octet-stream",
      acceptAnyMimeType: true,
      versionRef: `${fileId}:${createdSeconds ?? 0}`,
      sourceUpdatedAt: createdSeconds != null ? new Date(createdSeconds * 1000) : null,
      sourceAcl: { channelId: input.channelId },
      fetchBytes: async () => {
        await slackThrottle(input.token, "files.download");
        const res = await fetch(downloadUrl, {
          headers: { Authorization: `Bearer ${input.token}` },
        });
        if (!res.ok) throw new Error(`Slack file download failed: HTTP ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.byteLength > SLACK_FILE_MAX_BYTES) {
          throw new Error(`Slack file exceeds ${SLACK_FILE_MAX_BYTES} bytes`);
        }
        return bytes;
      },
    });

    if (result.status === "stored" || result.status === "skipped") {
      stored++;
    } else {
      bump(skips, `file_${result.status}`);
    }
  }

  return { stored, skips };
}

function bump(record: Record<string, number>, reason: string): void {
  record[reason] = (record[reason] ?? 0) + 1;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
