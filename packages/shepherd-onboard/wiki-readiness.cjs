const DEFAULT_READY_THRESHOLD_PERCENT = 95;

function wikiReadinessPayloadFromStatus(status) {
  const wiki = recordValue(status?.production?.wiki) ?? recordValue(status?.wiki);
  if (!wiki) {
    return {
      status: "wiki_status_unavailable",
      wiki: null,
      instruction_for_assistant: "Shepherd wiki readiness is not available from local status yet. Run shepherd onboard or shepherd continue, then retry shepherd_wiki_status.",
    };
  }

  const state = stringValue(wiki.state) ?? "unknown";
  const signal = wikiSignal(wiki, state);
  if (state === "ready") {
    return {
      status: "wiki_ready",
      wiki: signal,
      instruction_for_assistant: "The Shepherd wiki is ready enough for memory/wiki answers. Use exact Shepherd tools and cite evidence naturally when specific source details matter.",
    };
  }

  return {
    status: "wiki_not_ready",
    wiki: {
      trigger: "wiki_not_ready",
      ...signal,
    },
    instruction_for_assistant: "Do not answer the user's underlying memory/wiki question yet. Briefly explain that Shepherd is still learning, mention progress and ETA when present, and invite them to retry when the initial build is ready.",
  };
}

function renderWikiReadinessSummary(payload) {
  if (!payload || typeof payload !== "object") return "Wiki readiness: unavailable";
  const wiki = recordValue(payload.wiki);
  if (payload.status === "wiki_ready") {
    const progress = wiki?.progress_percent == null ? "" : ` (${wiki.progress_percent}% built)`;
    return `Wiki readiness: ready${progress}`;
  }
  if (payload.status === "wiki_not_ready") {
    const progress = wiki?.progress_percent == null ? "progress unknown" : `${wiki.progress_percent}% built`;
    const eta = wiki?.eta ? `, ETA ${wiki.eta}` : "";
    return `Wiki readiness: not ready (${progress}${eta})`;
  }
  return `Wiki readiness: ${payload.status ?? "unavailable"}`;
}

function wikiSignal(wiki, state) {
  const pipeline = recordValue(wiki.pipeline);
  const pipelineWiki = recordValue(pipeline?.wiki);
  const pipelinePulled = recordValue(pipeline?.pulled);
  const pipelineProcessed = recordValue(pipeline?.processed);
  const events = recordValue(wiki.events);
  const files = recordValue(wiki.files);
  const eta = recordValue(wiki.eta);
  const progressPercent = numberOrNull(pipelineWiki?.progressPercent ?? events?.wikiProgressPercent);
  const thresholdPercent = numberOrNull(pipelineWiki?.readyThresholdPercent) ?? DEFAULT_READY_THRESHOLD_PERCENT;

  return {
    status: state,
    progress_percent: progressPercent,
    ready_threshold_percent: thresholdPercent,
    eta: etaLabel(eta),
    eta_detail: eta,
    coverage_through: stringValue(pipelineWiki?.latestAt ?? events?.latestWikiProcessedAt),
    file_count: numberOrZero(files?.count),
    pulled_event_count: numberOrZero(pipelinePulled?.count ?? events?.pulled),
    source_processed_event_count: numberOrZero(pipelineProcessed?.count ?? events?.processed),
    source_processing_pending_event_count: numberOrZero(pipelineProcessed?.pendingCount ?? events?.processingPending),
    wiki_ingested_event_count: numberOrZero(pipelineWiki?.count ?? events?.wikiProcessed),
    wiki_pending_event_count: numberOrZero(pipelineWiki?.blockingPendingCount ?? events?.wikiBlockingPending),
    live_tail_event_count: numberOrZero(pipelineWiki?.liveTailCount ?? events?.liveTail),
    state_message: stringValue(wiki.message),
  };
}

function etaLabel(eta) {
  if (!eta) return null;
  const readyAt = stringValue(eta.estimatedReadyAt);
  if (readyAt) return `estimated ready at ${readyAt}`;
  const seconds = numberOrNull(eta.etaSeconds ?? eta.seconds);
  if (seconds == null) return null;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function numberOrZero(value) {
  return numberOrNull(value) ?? 0;
}

module.exports = {
  renderWikiReadinessSummary,
  wikiReadinessPayloadFromStatus,
};
