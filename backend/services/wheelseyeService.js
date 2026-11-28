'use strict';

const axios = require('axios');

const DEFAULT_URL = 'https://api.wheelseye.com/currentLoc';
const DEFAULT_TIMEOUT_MS = 20000;
const RETRY_DELAY_MS = 1000;

/**
 * .env / Vercel values are often pasted with spaces or quotes
 * ("https://..." or ' https://... '). Clean them so new URL() does not fail.
 */
function cleanEnv(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/^['"]+|['"]+$/g, '').trim();
}

function parseUrl(value, label) {
  try {
    return new URL(value);
  } catch (error) {
    throw new Error(`${label} is not a valid URL. Check it in backend/.env or Vercel Environment Variables`);
  }
}

/** Never let the access token appear in logs or error messages. */
function redact(text, token) {
  let output = String(text === null || text === undefined ? '' : text);
  if (token) output = output.split(token).join('***');
  return output.replace(/(accessToken=)[^&\s"']+/gi, '$1***');
}

function responseSnippet(data, token) {
  if (data === null || data === undefined || data === '') return '';
  let text;
  if (typeof data === 'string') text = data;
  else {
    try {
      text = JSON.stringify(data);
    } catch (error) {
      text = String(data);
    }
  }
  text = redact(text, token).replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function isTimeout(error) {
  return error && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT');
}

function isRetryable(error) {
  if (isTimeout(error)) return false; // already waited the full timeout; do not double the wait
  if (!error.response) return true; // network error (DNS, reset, offline)
  const status = error.response.status;
  return status === 429 || status >= 500;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Turns an axios error into a short, readable, token-free message. */
function describeError(error, token) {
  if (isTimeout(error)) return 'WheelsEye request timed out';
  if (error.response) {
    const status = error.response.status;
    const hint =
      status === 401 || status === 403
        ? ' (access token is invalid, expired or not allowed - check WHEELSEYE_API_TOKEN)'
        : status === 404
          ? ' (check WHEELSEYE_API_URL)'
          : status === 429
            ? ' (too many requests)'
            : '';
    const body = responseSnippet(error.response.data, token);
    return `WheelsEye returned HTTP ${status}${hint}${body ? `: ${body}` : ''}`;
  }
  return `WheelsEye request failed: ${redact(error.code || error.message, token)}`;
}

/**
 * Calls the WheelsEye live-location API.
 * Returns the axios response (same as before): response.data holds the vehicles.
 * Throws an Error with a readable message when anything goes wrong.
 */
async function fetchLive({ baseUrl, timeoutMs } = {}) {
  const environmentUrl = cleanEnv(process.env.WHEELSEYE_API_URL) || DEFAULT_URL;
  const configuredUrl = cleanEnv(baseUrl) || environmentUrl;

  const url = parseUrl(configuredUrl, 'WheelsEye API URL');
  const environmentParsed = parseUrl(environmentUrl, 'WHEELSEYE_API_URL');

  const accessToken =
    cleanEnv(process.env.WHEELSEYE_API_TOKEN) ||
    environmentParsed.searchParams.get('accessToken') ||
    url.searchParams.get('accessToken');

  if (!accessToken) {
    throw new Error('WheelsEye access token is missing. Set WHEELSEYE_API_TOKEN in backend/.env and in Vercel Environment Variables');
  }

  url.searchParams.delete('accessToken');
  url.searchParams.set('accessToken', accessToken);

  const timeout = Number(timeoutMs || process.env.WHEELSEYE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const maxAttempts = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await axios.get(url.toString(), {
        timeout,
        headers: { Accept: 'application/json' }
      });

      const data = response.data;
      if (data === null || data === undefined || data === '') {
        throw new Error('WheelsEye returned an empty response');
      }
      if (typeof data === 'string' && /^\s*</.test(data)) {
        throw new Error('WheelsEye returned a web page instead of GPS data (check WHEELSEYE_API_URL)');
      }
      if (data.success === false || (data.data && data.data.success === false)) {
        const reason = data.message || data.error || (data.data && (data.data.message || data.data.error));
        throw new Error(
          `WheelsEye returned an unsuccessful response${reason ? `: ${redact(reason, accessToken)}` : ''}`
        );
      }
      return response;
    } catch (error) {
      // Our own readable errors (no .isAxiosError) are final - do not retry them.
      if (!error.isAxiosError) {
        lastError = error;
        break;
      }
      lastError = new Error(describeError(error, accessToken));
      lastError.status = error.response ? error.response.status : null;
      lastError.code = error.code || null;
      if (attempt < maxAttempts && isRetryable(error)) {
        console.error(`[gps-sync] WheelsEye attempt ${attempt} failed: ${lastError.message}. Retrying...`);
        await wait(RETRY_DELAY_MS);
        continue;
      }
      break;
    }
  }

  console.error(`[gps-sync] WheelsEye fetch failed: ${lastError.message}`);
  throw lastError;
}

module.exports = { fetchLive };
