import { getGoogleAccessToken } from "../src/lib/google-auth.js";
import { gFetch } from "../src/polling/gdocs-api.js";

async function test() {
  const token = await getGoogleAccessToken("default");
  console.log("Token OK, length:", token.length);

  // Test 1: Activity API comment query
  const actRes = await fetch("https://driveactivity.googleapis.com/v2/activity:query", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      ancestorName: "items/root",
      filter: "detail.action_detail_case:COMMENT",
      pageSize: 5,
    }),
  });
  const actData = (await actRes.json()) as { activities?: any[] };
  console.log("\n=== Activity API COMMENT query ===");
  console.log("Status:", actRes.status, "| Activities:", (actData.activities ?? []).length);
  if (actData.activities?.[0]) {
    const a = actData.activities[0];
    console.log("Comment type:", JSON.stringify(a.primaryActionDetail?.comment));
    const fileComment = a.targets?.find((t: any) => t.fileComment);
    const driveItem = a.targets?.find((t: any) => t.driveItem);
    console.log("legacyCommentId:", fileComment?.fileComment?.legacyCommentId ?? "not found");
    console.log("File:", driveItem?.driveItem?.title ?? "unknown");
  }

  // Test 2: Activity API all actions
  const editRes = await fetch("https://driveactivity.googleapis.com/v2/activity:query", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ancestorName: "items/root", pageSize: 5 }),
  });
  const editData = (await editRes.json()) as { activities?: any[] };
  console.log("\n=== Activity API all actions ===");
  console.log("Status:", editRes.status, "| Activities:", (editData.activities ?? []).length);
  for (const a of (editData.activities ?? []).slice(0, 3)) {
    const actionKey = Object.keys(a.primaryActionDetail)[0];
    const actor = a.actors?.[0]?.user?.knownUser;
    const target = a.targets?.find((t: any) => t.driveItem)?.driveItem;
    console.log(`  ${actionKey} by ${actor?.personName ?? "unknown"} on "${target?.title ?? "?"}" ${actor?.isCurrentUser ? "(you)" : ""}`);
  }

  // Test 3: /revisions/load on most recent doc
  const filesRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.document%27&pageSize=1&orderBy=modifiedTime+desc&fields=files(id,name)",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const filesData = (await filesRes.json()) as { files?: Array<{ id: string; name: string }> };

  if (!filesData.files?.[0]) {
    console.log("\nNo Google Docs found.");
    return;
  }

  const docId = filesData.files[0].id;
  const docName = filesData.files[0].name;
  console.log(`\n=== /revisions/load test on "${docName}" (${docId}) ===`);

  // Get last revision ID
  const revRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${docId}/revisions?fields=revisions(id)&pageSize=1`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const revData = (await revRes.json()) as { revisions?: Array<{ id: string }> };
  const lastRevId = revData.revisions?.[revData.revisions.length - 1]?.id ?? "1";
  console.log("Last revision ID:", lastRevId);

  // Call /revisions/load
  const loadUrl = `https://docs.google.com/document/d/${docId}/revisions/load?id=${docId}&start=1&end=${lastRevId}`;
  const loadRes = await gFetch(loadUrl, token);
  console.log("/revisions/load status:", loadRes.status);

  if (loadRes.ok) {
    const rawText = await loadRes.text();
    console.log("Response size:", rawText.length, "bytes");
    console.log("Prefix (first 10 chars):", JSON.stringify(rawText.slice(0, 10)));

    const jsonStr = rawText.slice(5);
    try {
      const data = JSON.parse(jsonStr);
      const changelog = data.changelog ?? [];
      console.log("Changelog entries:", changelog.length);

      if (changelog.length > 0) {
        const first = changelog[0];
        console.log("First entry: ty=" + first[0]?.ty, "time=" + new Date(first[1]).toISOString(), "user=" + first[2]);
      }
      if (changelog.length > 1) {
        const last = changelog[changelog.length - 1];
        console.log("Last entry:  ty=" + last[0]?.ty, "time=" + new Date(last[1]).toISOString(), "user=" + last[2]);
      }

      // Count unique users and operation types
      const users = new Set(changelog.map((e: any) => e[2]));
      const types = new Map<string, number>();
      for (const entry of changelog) {
        const ty = entry[0]?.ty ?? "unknown";
        types.set(ty, (types.get(ty) ?? 0) + 1);
      }
      console.log("Unique authors:", users.size);
      console.log("Operation types:", Object.fromEntries(types));

      // Check for suggestions
      const suggestions = changelog.filter((e: any) => e[0]?.ty === "iss" || e[0]?.ty === "dss");
      console.log("Suggestion operations:", suggestions.length);

      console.log("\n✅ /revisions/load works with domain delegation!");
    } catch (e) {
      console.log("JSON parse failed:", (e as Error).message);
      console.log("Raw sample:", rawText.slice(0, 200));
    }
  } else {
    const errText = await loadRes.text();
    console.log("FAILED:", errText.slice(0, 200));
  }

  // Test 4: People API for actor resolution
  const peopleRes = await fetch(
    "https://people.googleapis.com/v1/people/me?personFields=emailAddresses,names",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  console.log("\n=== People API test ===");
  console.log("Status:", peopleRes.status);
  if (peopleRes.ok) {
    const p = (await peopleRes.json()) as { names?: Array<{ displayName: string }>; emailAddresses?: Array<{ value: string }> };
    console.log("Name:", p.names?.[0]?.displayName);
    console.log("Email:", p.emailAddresses?.[0]?.value);
  }
}

test().catch(console.error);
