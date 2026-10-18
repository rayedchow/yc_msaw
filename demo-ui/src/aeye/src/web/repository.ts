/* Type-only extract of AEye src/web/repository.ts: the file tree node the workspace tree renders. */
export interface HandbookTreeNode {
  kind: "directory" | "file";
  title: string;
  path: string;
  children: HandbookTreeNode[];
  /** Present only for files in the durable draft workspace explorer. */
  workspaceRole?: "publishable_markdown" | "working_artifact";
  byteLength?: number;
  /** A ZIP the workspace tree expands like a folder (its members load on demand). */
  archive?: true;
}
