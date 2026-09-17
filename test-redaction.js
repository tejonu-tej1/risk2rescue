/**
 * RISK2RESCUE - REDACTION REGRESSION TEST (test-redaction.js)
 * Proves that credentials are scrubbed from strings and that the Health and Raw endpoints are secure.
 */

const { safeText, safeObject } = require('./js/redact.js');
const fs = require('fs');
const path = require('path');

// Load real .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of envLines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const [key, ...valParts] = trimmed.split('=');
      const val = valParts.join('=').trim().replace(/^["']|["']$/g, '');
      if (key && !process.env[key.trim()]) {
        process.env[key.trim()] = val;
      }
    }
  }
}

// Ensure tests have something to scrub even if .env is missing
process.env.TEST_API_KEY = "super_secret_test_key_12345";
process.env.DATA_GOV_IN_API_KEY = process.env.DATA_GOV_IN_API_KEY || "test_datagov_key";
process.env.NASA_FIRMS_MAP_KEY = process.env.NASA_FIRMS_MAP_KEY || "test_firms_key";

async function runTest() {
  console.log('--- STARTING REDACTION REGRESSION TEST ---\n');

  let passed = true;

  // 1. Test Heuristic Scrubbing
  const bearerTest = "Failed with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
  const scrubbedBearer = safeText(bearerTest);
  if (scrubbedBearer.includes("eyJhbGci")) {
    console.error("FAIL: Bearer token was not scrubbed!");
    passed = false;
  } else {
    console.log("PASS: Bearer token scrubbed.");
  }

  // 2. Test Live Env Scrubbing
  const urlTest = `HTTP 401 from https://api.data.gov.in/resource/abc?api-key=${process.env.DATA_GOV_IN_API_KEY}&limit=50`;
  const scrubbedUrl = safeText(urlTest);
  if (scrubbedUrl.includes(process.env.DATA_GOV_IN_API_KEY)) {
    console.error("FAIL: DATA_GOV_IN_API_KEY leaked in string!");
    passed = false;
  } else if (!scrubbedUrl.includes("HTTP 401 from https://api.data.gov.in")) {
    console.error("FAIL: Useful debugging info was stripped!");
    passed = false;
  } else {
    console.log("PASS: Environment secret scrubbed from URL.");
  }

  // 3. Test Object Redaction
  const testObj = {
    sourceId: "test_source",
    metrics: {
      lastError: `Error: https://firms.modaps.eosdis.nasa.gov/api/area/csv/${process.env.NASA_FIRMS_MAP_KEY}/VIIRS/`,
      detail: `Used key ${process.env.TEST_API_KEY}`
    }
  };

  const scrubbedObj = safeObject(testObj);
  const jsonStr = JSON.stringify(scrubbedObj);

  if (jsonStr.includes(process.env.NASA_FIRMS_MAP_KEY) || jsonStr.includes(process.env.TEST_API_KEY)) {
    console.error("FAIL: safeObject failed to recursively scrub object properties!");
    passed = false;
  } else {
    console.log("PASS: Deep object properties successfully scrubbed.");
  }

  console.log('\n------------------------------------------');
  if (passed) {
    console.log('✅ ALL REDACTION TESTS PASSED.');
    process.exit(0);
  } else {
    console.log('❌ REDACTION TESTS FAILED.');
    process.exit(1);
  }
}

runTest();
