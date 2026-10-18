/**
 * Tab-change extraction from the OT changelog.
 *
 * The changelog carries tab operations (create / rename / move / delete) with a
 * `userId` and `timestamp` per op, and `buildTabState` (inside the client)
 * reconstructs the current tab tree into `DocChangelog.tabs`. This module turns
 * both into persistable rows: an attributed event log + the current tab state.
 *
 * Pure - no I/O. The caller supplies an already-fetched `DocChangelog`; the sync
 * fetches the changelog once and derives suggestions AND tab changes from it.
 */
import type { DocChangelog, ChangelogOperation } from "../../../polling/_archived-gdocs/gdocs-revisions-load.js";

export type TabEventType = "created" | "renamed" | "moved" | "deleted";

export interface TabChangeEvent {
  tabId: string;
  eventType: TabEventType;
  changelogIndex: number;
  actorUserId: string;
  actorName: string | null;
  oldName: string | null;
  newName: string | null;
  fromPosition: number[] | null;
  toPosition: number[] | null;
  occurredAt: Date;
}

export interface TabStateRow {
  tabId: string;
  name: string | null;
  position: number[] | null;
  parentTabId: string | null;
  createdAt: Date | null;
  deletedAt: Date | null;
}

export interface TabChanges {
  events: TabChangeEvent[];
  state: TabStateRow[];
}

const OP_TO_EVENT: Partial<Record<ChangelogOperation["type"], TabEventType>> = {
  tab_created: "created",
  tab_renamed: "renamed",
  tab_moved: "moved",
  tab_deleted: "deleted",
};

export function extractTabChanges(changelog: DocChangelog): TabChanges {
  const nameOf = (userId: string): string | null => changelog.userMap.get(userId)?.name ?? null;

  const events: TabChangeEvent[] = [];
  for (const op of changelog.operations) {
    const eventType = OP_TO_EVENT[op.type];
    if (!eventType) continue; // skip tab_config and non-tab ops
    const tabId = op.tabEvent?.targetTabId ?? op.tabId;
    if (!tabId) continue;
    events.push({
      tabId,
      eventType,
      changelogIndex: op.changelogIndex,
      actorUserId: op.userId,
      actorName: nameOf(op.userId),
      oldName: null,
      newName: eventType === "renamed" ? op.tabEvent?.tabName ?? null : null,
      fromPosition: op.tabEvent?.fromPosition ?? null,
      toPosition: op.tabEvent?.position ?? null,
      occurredAt: op.timestamp,
    });
  }

  const state: TabStateRow[] = changelog.tabs.map((t) => ({
    tabId: t.tabId,
    name: t.name || null,
    position: t.position ?? null,
    parentTabId: t.parentTabId ?? null,
    createdAt: t.createdAt ?? null,
    deletedAt: t.deletedAt ?? null,
  }));

  return { events, state };
}

/**
 * Cheap signature of a tab tree (id + name + parent + order), used to decide
 * whether the tab structure drifted since the last sync WITHOUT a changelog
 * fetch - so a doc with no pending suggestions still triggers the (expensive,
 * undocumented) changelog read only when its tabs actually changed.
 */
export function tabTreeSignature(tabs: Array<{ tabId: string; tabName?: string | null; parentTabId?: string | null; order?: number }>): string {
  return tabs
    .map((t, i) => `${t.tabId}|${t.tabName ?? ""}|${t.parentTabId ?? ""}|${t.order ?? i}`)
    .join("\n");
}
