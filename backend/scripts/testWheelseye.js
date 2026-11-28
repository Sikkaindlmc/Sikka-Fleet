'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { fetchLive } = require('../services/wheelseyeService');

function findRecords(value, depth = 0) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object' || depth > 5) return null;
  for (const key of ['list', 'vehicles', 'items', 'results', 'records', 'data', 'response']) {
    const records = findRecords(value[key], depth + 1);
    if (records) return records;
  }
  return null;
}

(async () => {
  console.log('Calling WheelsEye...');
  try {
    const response = await fetchLive();
    const records = findRecords(response.data) || [];
    console.log(`HTTP status: ${response.status}`);
    console.log(`Vehicle record count: ${records.length}`);
    console.log('First record:', records[0] ? JSON.stringify(records[0], null, 2) : 'none');
  } catch (error) {
    console.error(`WheelsEye test failed: ${error.message}`);
    process.exitCode = 1;
  }
})();
