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

function partitionProviderRecords({
  records,
  vehicles,
  providerName,
  isLinked = () => true
}) {
  const activeByNumber = new Map();
  const inactiveNumbers = new Set();
  const activeNumbers = new Set();
  for (const vehicle of Array.isArray(vehicles) ? vehicles : []) {
    const number = normalizeVehicleNumber(vehicle?.vehicleNumber);
    if (!number) continue;
    if (vehicle.status === 'Active') {
      activeNumbers.add(number);
      if (!activeByNumber.has(number)) activeByNumber.set(number, vehicle);
    } else if (!activeNumbers.has(number)) {
      inactiveNumbers.add(number);
    }
  }
  for (const number of activeNumbers) inactiveNumbers.delete(number);

  const uniqueRecords = new Map();
  let duplicateRecordCount = 0;
  let unidentifiedRecordCount = 0;
  for (const record of Array.isArray(records) ? records : []) {
    const number = normalizeVehicleNumber(record?.vehicleNumber);
    if (!number) {
      unidentifiedRecordCount++;
      continue;
    }
    const normalizedRecord = { ...record, vehicleNumber: number };
    const previous = uniqueRecords.get(number);
    if (!previous) {
      uniqueRecords.set(number, normalizedRecord);
      continue;
    }
    duplicateRecordCount++;
    const previousTime = new Date(previous.gpsTime || 0).getTime();
    const currentTime = new Date(normalizedRecord.gpsTime || 0).getTime();
    if (Number.isFinite(currentTime) && currentTime > previousTime) {
      uniqueRecords.set(number, normalizedRecord);
    }
  }

  const eligibleRecords = [];
  const inactiveVehicleNumbers = new Set();
  const unregisteredVehicleNumbers = new Set();
  const providerNotLinkedVehicleNumbers = new Set();
  for (const [number, record] of uniqueRecords) {
    const activeVehicle = activeByNumber.get(number);
    if (activeVehicle && isLinked(activeVehicle, providerName)) {
      eligibleRecords.push(record);
    } else if (activeVehicle) {
      providerNotLinkedVehicleNumbers.add(number);
    } else if (inactiveNumbers.has(number)) {
      inactiveVehicleNumbers.add(number);
    } else {
      unregisteredVehicleNumbers.add(number);
    }
  }

  return {
    eligibleRecords,
    inactiveVehicleNumbers,
    unregisteredVehicleNumbers,
    providerNotLinkedVehicleNumbers,
    duplicateRecordCount,
    unidentifiedRecordCount
  };
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
  const skippedNumbers = new Set();
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
      const persisted = await persistRecord(record, vehicle);
      if (persisted === false) {
        receivedNumbers.delete(number);
        skippedNumbers.add(number);
        return;
      }
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
    skippedNumbers,
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
 *  - a successful response with no active GPS records -> Successful
 *  - inactive/unregistered records are ignored         -> not a sync failure
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
    const saved = persistence.savedNumbers ? persistence.savedNumbers.size : 0;
    const saveErrors = persistence.saveErrors || 0;

    if (saveErrors > 0 && saved === 0) {
      const first = persistence.errors && persistence.errors[0];
      error = `Could not save GPS data for any vehicle${first ? `: ${first.message}` : ''}`;
    } else {
      if (saveErrors > 0) warnings.push(`${saveErrors} vehicle(s) could not be saved`);
    }
  }

  if (!error && geofenceError) {
    warnings.push(`Plant/geofence update failed: ${errorMessage(geofenceError)}`);
  }

  const success = !error;
  const stats = persistence
    ? {
        records: persistence.totalRecords || 0,
        saved: persistence.savedNumbers ? persistence.savedNumbers.size : 0,
        saveErrors: persistence.saveErrors || 0,
        ...(providerResult?.syncSummary || {})
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

module.exports = {
  persistMatchedRecords,
  partitionProviderRecords,
  aggregateSyncOutcome,
  normalizeVehicleNumber
};
