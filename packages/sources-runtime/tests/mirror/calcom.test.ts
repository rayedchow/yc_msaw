import { describe, expect, it } from "vitest";
import { CALCOM_BOOKING_URL_PATTERN, calcomBookingUid } from "../../src/mirror/calcom.js";

describe("cal.com booking UID extraction", () => {
  it("extracts the UID from video and booking URLs", () => {
    expect(calcomBookingUid("https://cal.com/video/wLDVU78KVvby7vf6C6ivh9")).toBe("wLDVU78KVvby7vf6C6ivh9");
    expect(calcomBookingUid("Join: https://app.cal.com/booking/AbCd1234xyz?changes=true"))
      .toBe("AbCd1234xyz");
  });

  it("rejects short or invalid UIDs and non-booking paths", () => {
    expect(calcomBookingUid("https://cal.com/video/eightch8")).toBe("eightch8"); // 8 chars: minimum accepted
    expect(calcomBookingUid("https://cal.com/video/abc1234")).toBeNull(); // 7 chars: too short
    expect(calcomBookingUid("https://cal.com/join/wLDVU78KVvby7vf6C6ivh9")).toBeNull();
    expect(calcomBookingUid("https://cal.com/ishan/15min")).toBeNull();
    expect(calcomBookingUid("plain text without urls")).toBeNull();
    expect(calcomBookingUid(null, undefined)).toBeNull();
  });

  it("returns the FIRST match across texts scanned in order", () => {
    expect(calcomBookingUid(
      null,
      "location https://cal.com/video/firstUid1",
      "description https://cal.com/video/secondUid2",
    )).toBe("firstUid1");
  });

  it("stops the UID at URL delimiters", () => {
    expect(calcomBookingUid("https://cal.com/video/wLDVU78KVvby7vf6C6ivh9\">link</a>"))
      .toBe("wLDVU78KVvby7vf6C6ivh9");
  });

  it("matches inside JSON-stringified conference data", () => {
    const conference = JSON.stringify({
      entryPoints: [{ entryPointType: "video", uri: "https://cal.com/video/wLDVU78KVvby7vf6C6ivh9" }],
    });
    expect(calcomBookingUid(conference)).toBe("wLDVU78KVvby7vf6C6ivh9");
  });

  it("exposes the documented pattern verbatim", () => {
    expect(CALCOM_BOOKING_URL_PATTERN.source).toBe("cal\\.com\\/(?:video|booking)\\/([A-Za-z0-9_-]{8,})");
  });
});
