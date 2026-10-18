import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(testDir, "..", "..");
const cliPath = resolve(packageDir, "bin", "shepherd-onboard.js");

async function importCliWithTempHome() {
  const home = await mkdtemp(join(tmpdir(), "shepherd-chat-discovery-"));
  vi.stubEnv("HOME", home);
  const mod = await import(`${cliPath}?test=${Date.now()}-${Math.random()}`);
  return { home, testApi: mod.__test };
}

const contactLookup = {
  resolveName(handle: string) {
    return handle === "+15551234567" ? "Ishan Ramrakhiani" : null;
  },
  isSelfHandle() {
    return false;
  },
};

describe("Messages chat discovery", () => {
  it("labels direct-message chats from the chat id without reading messages", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      const sdk = { getMessages: vi.fn(async () => []) };

      const chat = await testApi.enrichMessageChat(sdk, {
        chatId: "iMessage;-;+15551234567",
        kind: "dm",
        service: "iMessage",
      }, contactLookup);

      expect(sdk.getMessages).not.toHaveBeenCalled();
      expect(chat).toMatchObject({
        chatId: "iMessage;-;+15551234567",
        label: "Ishan Ramrakhiani",
        kind: "dm",
        participants: [{ handle: "+15551234567", name: "Ishan Ramrakhiani" }],
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("enriches remaining chat candidates concurrently", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      let active = 0;
      let maxActive = 0;
      const sdk = {
        async getMessages({ chatId }: { chatId: string }) {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active--;
          return [{ participant: `${chatId}@example.com` }];
        },
      };
      const candidates = Array.from({ length: 6 }, (_, index) => ({
        chatId: `group-${index}`,
        kind: "group",
        service: "iMessage",
      }));

      const chats = await testApi.enrichMessageChatCandidates(sdk, candidates, contactLookup, {
        limit: candidates.length,
      });

      expect(chats).toHaveLength(6);
      expect(maxActive).toBeGreaterThan(1);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });
});
