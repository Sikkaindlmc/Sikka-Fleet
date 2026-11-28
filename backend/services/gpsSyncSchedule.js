'use strict';

const crypto = require('crypto');

const GPS_SYNC_INTERVAL_MS = 30 * 60 * 1000;          // auto sync every 30 min
const GPS_SYNC_RETRY_MS = 5 * 60 * 1000;              // retry 5 min after a failure
const GPS_SYNC_HEARTBEAT_MS = 30 * 1000;              // built-in scheduler heartbeat
const GPS_SYNC_EXTERNAL_HEARTBEAT_MAX_AGE_MS =
  GPS_SYNC_INTERVAL_MS * 2 + 5 * 60 * 1000;           // cron-job.org: allow 65 min
const GPS_SYNC_CLOCK_SKEW_MS = 60 * 1000;             // tolerate small clock differences
const GPS_SYNC_STALE_LOCK_MS = 10 * 60 * 1000;        // "in progress" for >10 min = stuck

/** Safe time parsing: null/''/invalid -> NaN (new Date(null) would wrongly be 1970). */
function toTime(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return new Date(value).getTime();
}

function nowTime(now) {
  const time = toTime(now);
  return Number.isFinite(time) ? time : Date.now();
}

function isGpsSchedulerHealthy(now, config) {
  if (!config || config.enabled === false || config.schedulerStatus !== 'running') return false;
  const heartbeatAt = toTime(config.schedulerHeartbeatAt);
  const currentTime = nowTime(now);
  if (!Number.isFinite(heartbeatAt)) return false;
  const maxAge =
    config.schedulerMode === 'external'
      ? GPS_SYNC_EXTERNAL_HEARTBEAT_MAX_AGE_MS
      : GPS_SYNC_HEARTBEAT_MS * 3;
  const age = currentTime - heartbeatAt;
  // age < 0 means heartbeat is "in the future" (clock difference between servers)
  return age >= -GPS_SYNC_CLOCK_SKEW_MS && age <= maxAge;
}

function isGpsSchedulerSecretValid(candidate, configured) {
  if (typeof candidate !== 'string' || typeof configured !== 'string') return false;
  const cleanCandidate = candidate.trim().replace(/^Bearer\s+/i, '');
  const cleanConfigured = configured.trim();
  if (!cleanConfigured) return false;
  const candidateBuffer = Buffer.from(cleanCandidate);
  const configuredBuffer = Buffer.from(cleanConfigured);
  return (
    candidateBuffer.length === configuredBuffer.length &&
    crypto.timingSafeEqual(candidateBuffer, configuredBuffer)
  );
}

/** Next 30-minute slot (:00 / :30, same in IST and UTC) after the given time. */
function getNextScheduledSyncAt(after = new Date()) {
  const timestamp = nowTime(after);
  return new Date((Math.floor(timestamp / GPS_SYNC_INTERVAL_MS) + 1) * GPS_SYNC_INTERVAL_MS);
}

function getNextAutoSyncAt(now = new Date(), latestSync = null, configuredNextAt = null) {
  const currentTime = nowTime(now);
  const configuredTime = toTime(configuredNextAt);
  if (Number.isFinite(configuredTime)) {
    // Overdue -> due right now
    return new Date(Math.max(configuredTime, currentTime));
  }
  const finishedAt = toTime(latestSync && latestSync.finishedAt);
  if (Number.isFinite(finishedAt)) {
    const nextAfterLastSync = getNextScheduledSyncAt(finishedAt);
    return new Date(Math.max(nextAfterLastSync.getTime(), currentTime));
  }
  return getNextScheduledSyncAt(currentTime);
}

/** Earlier of: normal schedule, or the retry time after a failed sync. */
function getNextGpsExecutionAt(now, config, lastAutoSync) {
  const currentTime = nowTime(now);
  const scheduledAt =
    config && config.nextExecutionAt
      ? getNextAutoSyncAt(currentTime, null, config.nextExecutionAt)
      : getNextAutoSyncAt(currentTime, lastAutoSync);
  const retryTime = toTime(config && config.nextRetryAt);
  if (!Number.isFinite(retryTime)) return scheduledAt;
  const retryAt = new Date(Math.max(retryTime, currentTime));
  return retryAt < scheduledAt ? retryAt : scheduledAt;
}

/** True when a sync should start now (used by the /api/sync/cron endpoint). */
function isGpsSyncDue(now, config, lastAutoSync) {
  return getNextGpsExecutionAt(now, config, lastAutoSync).getTime() <= nowTime(now);
}

/**
 * True when a sync has been "in progress" for too long (e.g. the Vercel
 * function was stopped mid-sync). Use this to release the lock so the
 * dashboard does not stay on "Sync In Progress" forever.
 */
function isGpsSyncStale(startedAt, now = new Date(), maxAgeMs = GPS_SYNC_STALE_LOCK_MS) {
  const started = toTime(startedAt);
  if (!Number.isFinite(started)) return true; // no valid start time -> treat as stuck
  return nowTime(now) - started > maxAgeMs;
}

/** When to retry after a failed sync. */
function getGpsRetryAt(now = new Date()) {
  return new Date(nowTime(now) + GPS_SYNC_RETRY_MS);
}

module.exports = {
  GPS_SYNC_INTERVAL_MS,
  GPS_SYNC_RETRY_MS,
  GPS_SYNC_HEARTBEAT_MS,
  GPS_SYNC_EXTERNAL_HEARTBEAT_MAX_AGE_MS,
  GPS_SYNC_STALE_LOCK_MS,
  isGpsSchedulerHealthy,
  isGpsSchedulerSecretValid,
  getNextScheduledSyncAt,
  getNextAutoSyncAt,
  getNextGpsExecutionAt,
  isGpsSyncDue,
  isGpsSyncStale,
  getGpsRetryAt
};
