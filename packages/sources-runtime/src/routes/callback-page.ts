/**
 * Shared HTML shell for provider OAuth callback pages: a small, dependency-
 * free status page that optionally closes itself after a successful connect.
 */
export function oauthCallbackPage(input: {
  title: string;
  body: string;
  footer?: string;
  error?: boolean;
  autoClose?: boolean;
}): string {
  const mark = input.error ? "!" : "OK";
  const shouldClose = input.autoClose === true && input.error !== true;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  ${shouldClose ? `<script>
    window.addEventListener("load", () => {
      setTimeout(() => window.close(), 100);
    });
  </script>` : ""}
  <style>
    :root { color-scheme: light dark; --bg: #FCFCFC; --fg: #111111; --muted: #6D726D; --green: #136033; --green-text: #FFFFFF; --danger: #9B1C1C; --danger-bg: #F8E7E7; --radius: 8px; }
    @media (prefers-color-scheme: dark) { :root { --bg: #000000; --fg: #F8F8F8; --muted: #A2A8A2; --green: #FFFFFF; --green-text: #000000; --danger: #FFD2D2; --danger-bg: #3A1111; } }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(420px, calc(100vw - 32px)); }
    h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.1; font-weight: 650; }
    p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.45; }
    .mark { width: 34px; height: 34px; border-radius: var(--radius); display: grid; place-items: center; margin-bottom: 14px; background: ${input.error ? "var(--danger-bg)" : "var(--green)"}; color: ${input.error ? "var(--danger)" : "var(--green-text)"}; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    ${input.error ? `<div class="mark">${mark}</div>` : ""}
    <h1>${escapeHtml(input.title)}</h1>
    <p>${escapeHtml(input.body)}</p>
    ${input.footer ? `<p style="margin-top: 12px">${escapeHtml(input.footer)}</p>` : ""}
    ${shouldClose ? "<p style=\"margin-top: 12px\">If this tab stays open, you can close it.</p>" : ""}
  </main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
