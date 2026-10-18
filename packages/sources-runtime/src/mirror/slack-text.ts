export type SlackUserDirectory = ReadonlyMap<string, string>;

export function mentionIdsIn(text: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  const mentionRegex = /<@([UW][A-Z0-9]+)(?:\|[^<>]*)?>/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(text))) {
    const id = match[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function normalizeSlackText(text: string, directory: SlackUserDirectory): string {
  const normalized = text.replace(/<([^<>]*)>/g, (whole, token: string, offset: number, fullText: string) => {
    if (fullText[offset - 1] === "<" || fullText[offset + whole.length] === ">") return whole;
    return normalizeSlackToken(whole, token, directory);
  });
  return normalized
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function renderSlackReactions(
  reactions: Array<{ name: string; users: string[]; count: number }> | null | undefined,
  directory: SlackUserDirectory,
): string | null {
  if (!Array.isArray(reactions)) return null;

  const rendered = reactions
    .flatMap((reaction) => {
      if (!reaction || typeof reaction !== "object") return [];
      const name = typeof reaction.name === "string" ? reaction.name.trim() : "";
      const count = typeof reaction.count === "number" && Number.isFinite(reaction.count)
        ? Math.trunc(reaction.count)
        : 0;
      const users = Array.isArray(reaction.users)
        ? reaction.users.filter((user): user is string => typeof user === "string" && user.trim().length > 0)
        : [];
      if (!name || count <= 0 || users.length === 0) return [];
      return [{ name, count, users }];
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .map((reaction) => {
      const visibleUsers = reaction.users.slice(0, 5).map((userId) => directory.get(userId) ?? userId);
      const omitted = reaction.users.length - visibleUsers.length;
      const users = omitted > 0 ? [...visibleUsers, `+${omitted} more`] : visibleUsers;
      const countSuffix = reaction.count > 1 ? `×${reaction.count}` : "";
      return `:${reaction.name}:${countSuffix} (${users.join(", ")})`;
    });

  return rendered.length ? `[reactions: ${rendered.join(", ")}]` : null;
}

function normalizeSlackToken(whole: string, token: string, directory: SlackUserDirectory): string {
  const user = token.match(/^@([UW][A-Z0-9]+)(?:\|([^<>]+))?$/);
  if (user) {
    const [, userId, label] = user;
    if (label) return `@${label}`;
    const resolved = userId ? directory.get(userId) : undefined;
    return resolved ? `@${resolved}` : whole;
  }

  const channel = token.match(/^#([A-Z0-9]+)(?:\|([^<>]+))?$/);
  if (channel) {
    const label = channel[2];
    return label ? `#${label}` : whole;
  }

  if (token === "!here" || token === "!channel" || token === "!everyone") {
    return `@${token.slice(1)}`;
  }
  const subteam = token.match(/^!subteam\^[A-Z0-9]+(?:\|([^<>]+))$/);
  if (subteam?.[1]) return subteam[1];
  if (token.startsWith("!")) return whole;

  const link = token.match(/^([^|]+)(?:\|([^<>]+))?$/);
  if (link?.[1] && /^(https?:\/\/|mailto:)/i.test(link[1])) {
    return link[2] ? `${link[2]} (${link[1]})` : link[1];
  }

  return whole;
}
