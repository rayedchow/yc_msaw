export type ZoomTranscriptTurn = {
  speaker: string;
  text: string;
  start_time: string;
  end_time: string;
};

const TIMING = /^(\d{2}:)?(\d{2}):(\d{2}[.,]\d{3})\s+-->\s+(\d{2}:)?(\d{2}):(\d{2}[.,]\d{3})/u;

function clock(parts: RegExpMatchArray, offset: number): string {
  const hours = parts[offset] ? parts[offset]!.slice(0, -1) : "00";
  return `${hours}:${parts[offset + 1]}:${parts[offset + 2]!.replace(",", ".")}`;
}

/** Parse Zoom's WebVTT transcript without discarding unknown cue settings. */
export function parseZoomVtt(input: string): ZoomTranscriptTurn[] {
  const blocks = input.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").split(/\n{2,}/u);
  const turns: ZoomTranscriptTurn[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0 || lines[0] === "WEBVTT" || lines[0]?.startsWith("NOTE")) continue;
    const timingIndex = lines.findIndex((line) => TIMING.test(line));
    if (timingIndex < 0) continue;
    const match = lines[timingIndex]!.match(TIMING);
    if (!match) continue;
    const body = lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/gu, "").trim();
    if (!body) continue;
    const speakerMatch = body.match(/^([^:]{1,120}):\s+([\s\S]+)$/u);
    turns.push({
      speaker: speakerMatch?.[1]?.trim() || "speaker_unknown",
      text: (speakerMatch?.[2] ?? body).trim(),
      start_time: clock(match, 1),
      end_time: clock(match, 4),
    });
  }
  return turns;
}
