import { describe, expect, it } from "vitest";

import { __test } from "../../bin/shepherd-onboard.js";

describe("Messages agent identity serialization", () => {
  it("derives a direct-message participant from the Apple chat id when the SDK message omits participant", () => {
    const msg = {
      id: "EE9740B3-3AC7-4BC4-893F-76ABBB0A0DE6",
      rowId: 130448,
      text: "Or we could stay in fort and cook or something ",
      chatId: "any;-;+12603411979",
      chatKind: "dm",
      participant: null,
      isFromMe: false,
    };

    expect(__test.messageChatKind(msg)).toBe("dm");
    expect(__test.messageParticipant(msg)).toBe("+12603411979");
    expect(__test.messageState(msg)).toMatchObject({
      chatId: "any;-;+12603411979",
      chatKind: "dm",
      participant: "+12603411979",
      isFromMe: false,
    });
  });

  it("treats identity stabilization as a resend-worthy state change", () => {
    const legacyState = {
      text: "Or we could stay in fort and cook or something ",
      editedAt: null,
      retractedAt: null,
      hasAttachments: false,
      attachments: [],
    };

    const stabilizedState = __test.messageState({
      id: "EE9740B3-3AC7-4BC4-893F-76ABBB0A0DE6",
      rowId: 130448,
      text: "Or we could stay in fort and cook or something ",
      chatId: "any;-;+12603411979",
      chatKind: "dm",
      participant: "+12603411979",
      isFromMe: false,
    });

    expect(__test.sameMessageState(legacyState, stabilizedState)).toBe(false);
  });

  it("does not infer a participant for group chats", () => {
    const msg = {
      id: "group-message",
      rowId: 1,
      text: "hello",
      chatId: "chat123",
      chatKind: "group",
      participant: null,
      isFromMe: false,
    };

    expect(__test.messageParticipant(msg)).toBeNull();
    expect(__test.messageState(msg)).toMatchObject({
      chatKind: "group",
      participant: null,
    });
  });
});

describe("CLI onboarding auth routing", () => {
  it("formats production app routing errors without returning a reroute URL", () => {
    expect(__test.routingErrorMessage({
      routing: {
        reason: "external_customer_deploy",
        targetApp: "production_customer",
        targetLabel: "Production Customer",
        requiresDifferentApp: true,
      },
    })).toContain("Production Customer");
    expect(__test.routingErrorMessage({
      routing: {
        reason: "internal_shepherd_customer_facing",
        targetApp: "production_internal",
        targetLabel: "Production Internal",
        requiresDifferentApp: true,
      },
    })).toContain("Production Internal");
    expect(__test.routingErrorMessage({})).toBeNull();
  });
});
