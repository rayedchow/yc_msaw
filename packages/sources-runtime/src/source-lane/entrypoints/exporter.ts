import { db } from "../../db/client.js";
import { assertSourceLaneMigrationsApplied } from "../core/boot.js";
import { SourceExporter } from "../export/exporter.js";

/** Drains source_lane_journal into yc_msaw over each tenant's binding. */
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());

await assertSourceLaneMigrationsApplied();
await new SourceExporter({ db }).run(abort.signal);
