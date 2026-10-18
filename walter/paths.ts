/**
 * Where walter's own files live. Locally that is this checkout; inside the walter MCP on Manufact the code is bundled,
 * so the uploaded sources are found through WALTER_DIR / WALTER_REPO (set by the server at boot).
 */
import path from "node:path";

/** The walter/ source folder (templates, domain packs, integration notes). */
export const WALTER_DIR = process.env.WALTER_DIR ?? path.dirname(new URL(import.meta.url).pathname);
/** The project root that holds node_modules (for the mcp-use CLI). */
export const REPO_DIR = process.env.WALTER_REPO ?? path.resolve(WALTER_DIR, "..");
