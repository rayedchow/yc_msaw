/**
 * How the agent's workspace mounts read on a page. The agent writes them as
 * shell variables (`$WORK/status`, `$INPUTS/a.pdf`); the build page, the
 * trace and the Files tree show them as plain folder names (`work/status`,
 * `inputs/a.pdf`). Display only: the agent's own text, and what it runs, is
 * never rewritten, and the raw text stays available (a tooltip, the call's
 * input) for debugging.
 */

/** Each mount variable and the folder name a page shows for it. */
export const WORKSPACE_ROOT_NAMES: Readonly<Record<string, string>> = {
  $WORK: "work",
  $INPUTS: "inputs",
  $SESSION_INPUTS: "session-inputs",
  $KNOWLEDGE: "knowledge",
};

// `$NAME` or `${NAME}`, never a longer variable (`$WORKSPACE`) or `\$WORK`.
const ROOT_VARIABLE = /(?<!\\)\$(?:\{(SESSION_INPUTS|INPUTS|WORK|KNOWLEDGE)\}|(SESSION_INPUTS|INPUTS|WORK|KNOWLEDGE)(?![A-Za-z0-9_]))/gu;

/**
 * Command text, a path or any line with its mount variables named as
 * folders: `ls $WORK/status; ls -R "$INPUTS"` reads `ls work/status; ls -R
 * "inputs"`. Text without one is returned unchanged.
 */
export function displayWorkspaceText(text: string): string {
  if (!text.includes("$")) return text;
  return text.replace(ROOT_VARIABLE, (_match, braced: string | undefined, bare: string | undefined) =>
    WORKSPACE_ROOT_NAMES[`$${braced ?? bare}`] ?? _match);
}

/** A Files tree folder's name: a mount variable reads as its folder name, anything else as is. */
export function workspaceFolderName(title: string): string {
  return WORKSPACE_ROOT_NAMES[title] ?? title;
}
