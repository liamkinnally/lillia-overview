function quotaWindow(id, usedPercent, durationMinutes, resetMilliseconds) {
  const date = new Date(resetMilliseconds);
  return {
    id,
    usedPercent:
      Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent <= 100 ? usedPercent : null,
    durationMinutes:
      Number.isSafeInteger(durationMinutes) && durationMinutes > 0 ? durationMinutes : null,
    resetsAt:
      Number.isSafeInteger(resetMilliseconds) &&
      resetMilliseconds > 0 &&
      Number.isFinite(date.getTime())
        ? date.toISOString()
        : null
  };
}

export function codexUsage(limits, model) {
  const windows = [];
  function add(limit, prefix) {
    for (const name of ['primary', 'secondary']) {
      const window = limit?.[name];
      if (!window || typeof window !== 'object') continue;
      const reset = Number.isSafeInteger(window.resetsAt) ? window.resetsAt * 1000 : null;
      windows.push(
        quotaWindow(prefix + name, window.usedPercent, window.windowDurationMins, reset)
      );
    }
  }
  add(limits.rateLimits, '');
  let count = 0;
  for (const limit of Object.values(limits.rateLimitsByLimitId ?? {})) {
    if (
      limit?.normalModelSlug !== model ||
      (limit.limitId && limit.limitId === limits.rateLimits?.limitId)
    )
      continue;
    count++;
    add(limit, count === 1 ? 'model-' : 'model-' + count + '-');
  }
  return { observedAt: new Date().toISOString(), windows };
}

export function claudeUsage(usage) {
  const windows = [];
  if (
    usage?.subscription_type !== 'pro' ||
    usage.rate_limits_available !== true ||
    !usage.rate_limits
  )
    return { observedAt: null, windows };
  for (const id of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_fable']) {
    const window = usage.rate_limits[id];
    if (!window || typeof window !== 'object') continue;
    const time = window.resets_at;
    const reset =
      typeof time === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(time)
        ? Date.parse(time)
        : null;
    windows.push(quotaWindow(id, window.utilization, id === 'five_hour' ? 300 : 10080, reset));
  }
  return { observedAt: new Date().toISOString(), windows };
}
