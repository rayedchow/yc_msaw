import { describe, expect, it } from "vitest";
import { mentionIdsIn, normalizeSlackText, renderSlackReactions } from "../../src/mirror/slack-text.js";

describe("Slack text normalization", () => {
  const directory = new Map([
    ["U1", "Dana Ruiz"],
    ["U2", "Blair"],
    ["U3", "Alex"],
  ]);

  it("resolves user mentions through the directory and honors mention labels", () => {
    expect(normalizeSlackText("<@U1> owns this; <@U2|blair> reviews", directory))
      .toBe("@Dana Ruiz owns this; @blair reviews");
    expect(normalizeSlackText("<@U9> is unresolved", directory)).toBe("<@U9> is unresolved");
  });

  it("normalizes channel, broadcast, subteam, and link markup forms", () => {
    expect(normalizeSlackText("<#C123|general> <#C999>", directory)).toBe("#general <#C999>");
    expect(normalizeSlackText("<!here> <!channel> <!everyone> <!subteam^S123|@eng> <!date^bad>", directory))
      .toBe("@here @channel @everyone @eng <!date^bad>");
    expect(normalizeSlackText("<https://example.com|Example> <https://example.com> <mailto:a@example.com|Email> <ftp://x>", directory))
      .toBe("Example (https://example.com) https://example.com Email (mailto:a@example.com) <ftp://x>");
  });

  it("unescapes entities after token replacement with ampersand last", () => {
    expect(normalizeSlackText("&lt;ok&gt; &amp; &amp;lt;", directory)).toBe("<ok> & &lt;");
    expect(normalizeSlackText("<https://x.test?a=1&amp;b=2|A &amp; B>", directory))
      .toBe("A & B (https://x.test?a=1&b=2)");
  });

  it("passes malformed and unknown tokens through unchanged", () => {
    expect(normalizeSlackText("bad <@> <#C1|> <!subteam^S1> <<@U1>>", directory))
      .toBe("bad <@> <#C1|> <!subteam^S1> <<@U1>>");
  });

  it("extracts unique mention ids in first-seen order", () => {
    expect(mentionIdsIn("<@U2> <@U1|dana> <@U2> <#C1|chan>")).toEqual(["U2", "U1"]);
  });
});

describe("Slack reaction rendering", () => {
  const directory = new Map([
    ["U1", "Dana Ruiz"],
    ["U2", "Alex"],
    ["U3", "Blair"],
    ["U4", "Zach"],
    ["U5", "Mina"],
  ]);

  it("renders sorted inline reactions with counts and resolved users", () => {
    expect(renderSlackReactions([
      { name: "white_check_mark", count: 1, users: ["U4"] },
      { name: "thumbsup", count: 3, users: ["U1", "U2", "U3"] },
      { name: "eyes", count: 3, users: ["U9"] },
    ], directory)).toBe("[reactions: :eyes:×3 (U9), :thumbsup:×3 (Dana Ruiz, Alex, Blair), :white_check_mark: (Zach)]");
  });

  it("caps rendered users, reports omitted users, and skips empty reactions", () => {
    expect(renderSlackReactions([
      { name: "rocket", count: 7, users: ["U1", "U2", "U3", "U4", "U5", "U6", "U7"] },
      { name: "zero", count: 0, users: ["U1"] },
      { name: "empty", count: 2, users: [] },
    ], directory)).toBe("[reactions: :rocket:×7 (Dana Ruiz, Alex, Blair, Zach, Mina, +2 more)]");
  });

  it("returns null for missing or malformed reaction arrays", () => {
    expect(renderSlackReactions(null, directory)).toBeNull();
    expect(renderSlackReactions([{ name: "", count: 1, users: ["U1"] }], directory)).toBeNull();
  });
});
