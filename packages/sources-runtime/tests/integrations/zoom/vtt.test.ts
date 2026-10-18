import { describe, expect, it } from "vitest";
import { encodeZoomMeetingUuid } from "../../../src/integrations/zoom/client.js";
import { parseZoomVtt } from "../../../src/integrations/zoom/vtt.js";

describe("Zoom transcript parsing", () => {
  it("preserves cue clocks, speakers, multiline text, and strips VTT tags", () => {
    expect(parseZoomVtt(`WEBVTT\n\n1\n00:00:01.200 --> 00:00:03.400 align:start position:0%\nJane Doe: Hello\nteam.\n\n00:01:04.000 --> 00:01:05.000\n<v John>Unlabelled cue</v>`)).toEqual([
      { speaker: "Jane Doe", text: "Hello team.", start_time: "00:00:01.200", end_time: "00:00:03.400" },
      { speaker: "speaker_unknown", text: "Unlabelled cue", start_time: "00:01:04.000", end_time: "00:01:05.000" },
    ]);
  });

  it("double-encodes UUIDs only for Zoom's documented slash edge case", () => {
    expect(encodeZoomMeetingUuid("/abc//def==")).toBe("%252Fabc%252F%252Fdef%253D%253D");
    expect(encodeZoomMeetingUuid("abc+def==")).toBe("abc%2Bdef%3D%3D");
  });
});
