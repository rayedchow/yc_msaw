const CHILD_CAPABLE_BLOCK_TYPES = new Set([
  "bulleted_list_item",
  "callout",
  "child_database",
  "child_page",
  "column",
  "column_list",
  "meeting_notes",
  "numbered_list_item",
  "paragraph",
  "quote",
  "synced_block",
  "table",
  "tab",
  "template",
  "to_do",
  "toggle",
  "transcription",
]);

const TOGGLEABLE_HEADING_TYPES = new Set(["heading_1", "heading_2", "heading_3", "heading_4"]);

export function notionBlockSupportsChildren(type: string, isToggleable: boolean | null | undefined): boolean {
  if (CHILD_CAPABLE_BLOCK_TYPES.has(type)) return true;
  return TOGGLEABLE_HEADING_TYPES.has(type) && isToggleable === true;
}
