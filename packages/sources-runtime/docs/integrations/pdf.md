# Raw PDFs

Scope for S1 is bytes-only capture. Aqueduct detects PDF origins, stores the
opaque bytes content-addressed in S3, and records capture-time metadata in
`binary_documents`. It does not render pages, run poppler, call a VLM, or emit
graph documents in this lane.

## Origins

- `drive-pdf`: Google Drive change-feed items with `mimeType =
  application/pdf`. The Drive branch is separate from the Google Docs
  workspace-MIME pipeline so PDFs never enter Docs rendering.
- `upload`: `POST /v1/pdfs` raw `application/pdf` uploads authenticated by the
  tenant API key.

Later Confluence/Jira attachment origins should add new providers into the
same table rather than creating provider-specific byte stores.

## Storage

Bytes are stored in the lane S3 bucket at:

```text
binary/<tenantId>/<sha256>
```

The key is tenant-prefixed even when two tenants upload identical bytes.
Isolation and prefix deletion beat cross-tenant dedupe savings.

Rows in `binary_documents` carry the origin id, version reference, sha256,
size, S3 key, source update time, author email when available, ACL snapshot
metadata, and parse status. `pending` means bytes were captured and are ready
for the future graph-phase parser.

## Deferred

PDF parsing is a graph-phase concern. Page rendering, page-image storage,
multimodal transcription, table extraction, staged markdown, and
`graph.ingest_document` are intentionally out of scope here.
