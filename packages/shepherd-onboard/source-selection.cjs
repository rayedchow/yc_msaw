function sourceSelectionFromSession(response, fallback) {
  const raw = response?.sources;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fallback ? { ...fallback } : null;
  }
  return {
    google: raw.google === true,
    notion: raw.notion === true,
    slack: raw.slack === true,
    github: raw.github === true,
    granola: raw.granola === true,
    messages: raw.messages === true,
    discord: raw.discord === true,
    instagram: raw.instagram === true,
    whatsapp: raw.whatsapp === true,
    codingSessions: raw.codingSessions === true,
    officeAudio: raw.officeAudio === true,
  };
}

module.exports = { sourceSelectionFromSession };
