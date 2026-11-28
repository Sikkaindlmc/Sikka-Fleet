'use strict';

const DEFAULT_CONCURRENCY = 5;
const MAX_ERROR_SAMPLES = 10;

/**
 * "UP14 GT-0100" / "up14gt0100" -> "UP14GT0100"
 * Used only for matching; the original record.vehicleNumber is kept
 * in the returned sets so the rest of the app behaves exactly as before.
 */
function normalizeVehicleNumber(value) {
  return String(value === null || value === undefined ? '' : value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function errorMessage(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

function buildNormalizedLookup(vehiclesByNumber) {
  const lookup = new Map();
  if (!vehiclesByNumber || typeof vehiclesByNumber.entries !== 'function') return lookup;
  for (const [key, vehicle] of vehiclesByNumber.entries()) {
    const normalized = normalizeVehicleNumber(key);
    if (normalized && !lookup.has(normalized)) lookup.set(normalized, vehicle);
  }
  return lookup;
}

/**
 * Saves every GPS record that belongs to a registered vehicle linked to
 * the given provider (WheelsEye).
 *
 * Same inputs/outputs as before, plus:
 *  - vehicle numbers are matched even if spacing/dashes/case differ
 *  - one bad record never stops the others
 *  - the real save errors are kept (and logged) instead of being swallowed
 *  - records are saved a few at a time (faster, avoids serverless timeouts)
 */
async function persistMatchedRecords({
  records,
  vehiclesByNumber,
  providerName,
  isLinked,
  persistRecord,
  concurrency = DEFAULT_CONCURRENCY,
  logger = console
}) {
  const list = Array.isArray(records) ? records : [];
  const receivedNumbers = new Set();
  const savedNumbers = new Set();
  const mismatchedNumbers = new Set();
  const errors = [];
  let vehicleNumberMismatches = 0;
  let saveErrors = 0;

  const normalizedLookup = buildNormalizedLookup(vehiclesByNumber);

  const findVehicle = (number) => {
    if (!number) return null;
    const direct =
      vehiclesByNumber && typeof vehiclesByNumber.get === 'function'
        ? vehiclesByNumber.get(number)
        : null;
    return direct || normalizedLookup.get(normalizeVehicleNumber(number)) || null;
  };

  async function processRecord(record) {
    const number = record && record.vehicleNumber;
    try {
      const vehicle = findVehicle(number);
      if (!vehicle || !isLinked(vehicle, providerName)) {
        vehicleNumberMismatches++;
        if (number) mismatchedNumbers.add(number);
        return;
      }
      receivedNumbers.add(number);
      await persistRecord(record, vehicle);
      savedNumbers.add(number);
    } catch (error) {
      saveErrors++;
      if (errors.length < MAX_ERROR_SAMPLES) {
        errors.push({ vehicleNumber: number || null, message: errorMessage(error) });
      }
      if (logger && typeof logger.error === 'function') {
        logger.error(`[gps-sync] save failed for ${number || 'unknown vehicle'}: ${errorMessage(error)}`);
      }
    }
  }

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < list.length) {
      const record = list[nextIndex++];
      await processRecord(record);
    }
  }

  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1));
  await Promise.all(Array.from({ length: workerCount }, worker));

  return {
    receivedNumbers,
    savedNumbers,
    vehicleNumberMismatches,
    saveErrors,
    mismatchedNumbers,
    errors,
    totalRecords: list.length
  };
}

/**
 * Decides whether a sync run is "Successful" or "Failed".
 * Still returns { status, success } as before, plus message/error/warnings/stats.
 *
 * Call it as before:
 *   aggregateSyncOutcome(providerResult, { geofenceError })
 * or, to get the stricter and clearer checks, also pass what
 * persistMatchedRecords returned:
 *   aggregateSyncOutcome(providerResult, { geofenceError, persistence })
 *
 * Rules:
 *  - WheelsEye request failed                         -> Failed
 *  - WheelsEye OK but 0 records                       -> Failed
 *  - records came but none matched a registered vehicle -> Failed
 *  - vehicles matched but none could be saved         -> Failed
 *  - some vehicles saved, some failed                 -> Successful (with warnings)
 *  - GPS saved but plant/geofence calculation failed  -> Successful (with warning),
 *    because the GPS data itself is stored and the next sync recalculates plants.
 */
function aggregateSyncOutcome(providerResult, { geofenceError = null, persistence = null } = {}) {
  const warnings = [];
  let error = null;

  if (!providerResult || !providerResult.ok) {
    const saveFailure = persistence && persistence.errors && persistence.errors[0];
    error = saveFailure
      ? `Could not save GPS data${saveFailure.vehicleNumber ? ` for ${saveFailure.vehicleNumber}` : ''}: ${errorMessage(saveFailure.message)}`
      : errorMessage(
          (providerResult &&
            (providerResult.error || providerResult.message || providerResult.reason)) ||
            'WheelsEye GPS request failed'
        );
  } else if (persistence) {
    const total = persistence.totalRecords || 0;
    const received = persistence.receivedNumbers ? persistence.receivedNumbers.size : 0;
    const saved = persistence.savedNumbers ? persistence.savedNumbers.size : 0;
    const saveErrors = persistence.saveErrors || 0;
    const mismatches = persistence.vehicleNumberMismatches || 0;

    if (total === 0) {
      error = 'WheelsEye returned no vehicle records';
    } else if (received === 0) {
      error = `None of the ${total} WheelsEye records matched a registered vehicle linked to WheelsEye`;
    } else if (saved === 0) {
      const first = persistence.errors && persistence.errors[0];
      error = `Could not save GPS data for any vehicle${first ? `: ${first.message}` : ''}`;
    } else {
      if (saveErrors > 0) warnings.push(`${saveErrors} vehicle(s) could not be saved`);
      if (mismatches > 0) warnings.push(`${mismatches} record(s) did not match a registered vehicle`);
    }
  }

  if (!error && geofenceError) {
    warnings.push(`Plant/geofence update failed: ${errorMessage(geofenceError)}`);
  }

  const success = !error;
  const stats = persistence
    ? {
        records: persistence.totalRecords || 0,
        matched: persistence.receivedNumbers ? persistence.receivedNumbers.size : 0,
        saved: persistence.savedNumbers ? persistence.savedNumbers.size : 0,
        mismatches: persistence.vehicleNumberMismatches || 0,
        saveErrors: persistence.saveErrors || 0
      }
    : null;

  return {
    status: success ? 'Successful' : 'Failed',
    success,
    partial: success && warnings.length > 0,
    message: success ? (warnings.length ? warnings.join('; ') : 'GPS sync completed') : error,
    error,
    warnings,
    stats
  };
}

module.exports = { persistMatchedRecords, aggregateSyncOutcome, normalizeVehicleNumber };
