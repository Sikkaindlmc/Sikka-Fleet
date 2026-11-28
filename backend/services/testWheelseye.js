'use strict';

// Run from the project folder:  node backend/scripts/testWheelseye.js
// It calls WheelsEye directly (no dashboard, no database) and prints the real result.

const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (error) {
  console.log('dotenv not found - using system environment variables only');
}

const { fetchLive } = require('../services/wheelseyeService');

function findRecords(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && data.data && Array.isArray(data.data.data)) return data.data.data;
  if (data && Array.isArray(data.vehicles)) return data.vehicles;
  return [];
}

(async () => {
  console.log('WHEELSEYE_API_URL set :', Boolean(process.env.WHEELSEYE_API_URL));
  console.log('WHEELSEYE_API_TOKEN set:', Boolean(process.env.WHEELSEYE_API_TOKEN));
  console.log('Calling WheelsEye...');
  const started = Date.now();
  try {
    const response = await fetchLive();
    const records = findRecords(response.data);
    console.log(`OK - HTTP ${response.status} in ${Date.now() - started} ms`);
    console.log('Top-level keys :', Object.keys(response.data || {}));
    console.log('Vehicle records:', records.length);
    if (records[0]) console.log('First record   :', JSON.stringify(records[0], null, 2));
    else console.log('Raw response   :', JSON.stringify(response.data).slice(0, 500));
  } catch (error) {
    console.log(`FAILED after ${Date.now() - started} ms`);
    console.log('Reason:', error.message);
  }
})();
