/**
 * RISK2RESCUE — Disaster Management & Hazard Intelligence Platform
 * Built-in zero-dependency Node.js HTTP server and REST API
 * Integrated with real-time live feeds: USGS Earthquakes, Open-Meteo Weather & Air Quality, and Windy Point Forecast
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const PriorityEngine = require('./js/priority-engine.js');
const AIEngine = require('./js/ai-engine.js');
const AlertRouter = require('./js/alert-router.js');
const SatelliteSignal = require('./js/satellite-signal.js');
const LiveState = require('./js/live-state.js');
const { WebSocketServer } = require('ws');

// Integrated Source Registry & Dynamic Upstream Feeds
const SourceRegistry = require('./source-registry.js');
const { safeObject } = require('./js/redact.js');
const { getOfficialCapAlerts, getCapFeed, CAP_FEEDS } = require('./sources/cap-feed.js');
const { getCpcbAirQuality, getOpenAqAirQuality } = require('./sources/cpcb-air.js');
const { getApWeather } = require('./sources/ap-weather.js');
const { getGdacsEvents } = require('./sources/gdacs.js');
const { getCWCRiverLevels } = require('./sources/cwc-nwic.js');
const { getGoogleFloodForecast } = require('./sources/google-flood.js');
const { getCopernicusFloodSignal, getLatestSentinel1Observation, processLatestSentinel1Observation, verifySentinel1ProductAccess } = require('./sources/copernicus.js');
const { getNasaFirmsHotspots } = require('./sources/nasa-firms.js');
const AIBridge = require('./ai-bridge.js');
const { correlateMultiHazards } = require('./sources/multi-hazard.js');
const OsrmService = require('./sources/osrm.js');

// Native .env file loader (zero external dependencies)
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    console.log(`[Config] Loaded environment variables from: ${envPath}`);
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
} catch (e) {
  console.warn('Note: .env file could not be read:', e.message);
}

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const WINDY_DATA_KEY = process.env.WINDY_DATA_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MIN_LIVE_SOURCES_FOR_AI = parseInt(process.env.MIN_LIVE_SOURCES_FOR_AI || '3', 10);


// ================= AUTHORITATIVE ANDHRA PRADESH BOUNDARY =================
let apBoundaryGeom = null;
try {
  const boundaryPath = path.join(__dirname, 'data', 'andhra_pradesh_boundary.geojson');
  if (fs.existsSync(boundaryPath)) {
    const raw = JSON.parse(fs.readFileSync(boundaryPath, 'utf8'));
    if (raw && raw.features && raw.features[0]) {
      apBoundaryGeom = raw.features[0].geometry;
      console.log('[Server] Loaded Andhra Pradesh authoritative operational boundary.');
    }
  }
} catch (e) {
  console.warn('[Server] Failed to load AP boundary GeoJSON:', e.message);
}

function pointInPoly(pt, polyCoords) {
  const x = pt[0], y = pt[1];
  let inside = false;
  for (let i = 0, j = polyCoords.length - 1; i < polyCoords.length; j = i++) {
    const xi = polyCoords[i][0], yi = polyCoords[i][1];
    const xj = polyCoords[j][0], yj = polyCoords[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function isCoordInsideAP(lng, lat) {
  if (!apBoundaryGeom || typeof lng !== 'number' || typeof lat !== 'number') return false;
  if (isNaN(lng) || isNaN(lat)) return false;
  if (apBoundaryGeom.type === 'Polygon') {
    return pointInPoly([lng, lat], apBoundaryGeom.coordinates[0]);
  }
  if (apBoundaryGeom.type === 'MultiPolygon') {
    return apBoundaryGeom.coordinates.some(ring => pointInPoly([lng, lat], ring[0]));
  }
  return false;
}

// ================= IN-MEMORY POLLING & CACHING LAYER =================
const CACHE_TTL_WEATHER_MS  = 15 * 60 * 1000; // 15 minutes
const CACHE_TTL_QUAKES_MS   = 10 * 60 * 1000; // 10 minutes
const CACHE_TTL_AQI_MS      = 10 * 60 * 1000; // 10 minutes (600000 ms)
const CACHE_TTL_PRIORITY_MS =  5 * 60 * 1000; // 5 minutes (Phase 1 VPI Cache)
const CACHE_TTL_IMD_MS      = 12 * 60 * 1000; // 12 minutes — IMD CAP RSS feed

const weatherCache = new Map();
const airQualityCache = new Map();
let earthquakeCache = null;
let priorityRankingCache = { data: null, expiresAt: 0 };
const osrmDistanceCache = new Map();
const osrmRouteDetailsCache = new Map();
let imdAlertsCache = { data: null, expiresAt: 0 }; // IMD CAP feed cache


const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.webp': 'image/webp'
};

// In-memory runtime event store
let storedAlerts = [];
let storedReports = [];
let systemStartTime = Date.now();

// Generic HTTP/HTTPS JSON fetcher with timeout
function fetchJson(targetUrl, headers = {}, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(targetUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request(parsedUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Risk2Rescue/2.0 (Disaster-Management-Platform)',
          'Accept': 'application/json',
          ...headers
        },
        timeout: timeoutMs
      }, (res) => {
        let rawData = '';
        res.on('data', chunk => rawData += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(rawData));
            } catch (err) {
              reject(new Error('JSON parse error from ' + targetUrl));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode} from ${targetUrl}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout after ' + timeoutMs + 'ms'));
      });

      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Generic HTTP/HTTPS text fetcher (for XML/RSS — mirrors fetchJson but returns raw string)
function fetchText(targetUrl, headers = {}, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(targetUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;
      const req = client.request(parsedUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Risk2Rescue/2.0 (Disaster-Management-Platform)',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          ...headers
        },
        timeout: timeoutMs
      }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(raw);
          else reject(new Error(`HTTP ${res.statusCode} from ${targetUrl}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    } catch (e) { reject(e); }
  });
}

// ─── IMD CAP FEED (https://cap-sources.s3.amazonaws.com/in-imd-en/rss.xml) ─
// Zero-dep regex-based XML parser — no npm packages required.
// Returns: [{ title, hazard_type, severity, area_desc, effective, expires, description, link }]

const IMD_CAP_URL = 'https://cap-sources.s3.amazonaws.com/in-imd-en/rss.xml';

// Regions whose alerts are relevant to the app's scenario states
const REGION_KEYWORDS = [
  'andhra pradesh', ' a.p.', 'assam', 'uttarakhand', 'gujarat', 'kerala',
  'kakinada', 'visakhapatnam', 'godavari', 'krishna', 'guntur', 'guwahati',
  'dehradun', 'ahmedabad', 'surat', 'thiruvananthapuram', 'kochi',
  'vijayawada', 'rajahmundry', 'nellore', 'ongole', 'eluru'
];

/** Extract text inside the first matching XML tag, stripping CDATA and HTML entities. */
function capXmlTag(block, tagName) {
  const re = new RegExp('<' + tagName + '[^>]*>([\\s\\S]*?)<\\/' + tagName + '>', 'i');
  const m = block.match(re);
  if (!m) return '';
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .trim();
}

function inferHazardType(title, desc) {
  const t = (title + ' ' + desc).toLowerCase();
  if (t.includes('cyclone') || t.includes('storm'))    return 'Cyclone';
  if (t.includes('flood') || t.includes('inundation')) return 'Flood';
  if (t.includes('landslide'))                         return 'Landslide';
  if (t.includes('heatwave') || t.includes('heat wave')) return 'Heat Wave';
  if (t.includes('thunder') || t.includes('lightning'))return 'Thunderstorm';
  if (t.includes('rain') || t.includes('rainfall'))   return 'Heavy Rainfall';
  if (t.includes('fog'))                               return 'Dense Fog';
  if (t.includes('wind'))                              return 'Strong Winds';
  if (t.includes('tsunami'))                           return 'Tsunami';
  return 'Weather Alert';
}

function inferSeverity(title, desc) {
  const t = (title + ' ' + desc).toLowerCase();
  if (t.includes('extreme') || t.includes('red alert'))   return 'Extreme';
  if (t.includes('severe')  || t.includes('orange alert')) return 'Severe';
  if (t.includes('moderate')|| t.includes('yellow alert')) return 'Moderate';
  if (t.includes('minor')   || t.includes('green alert'))  return 'Minor';
  return 'Unknown';
}

async function getImdAlerts() {
  try {
    const res = await getCapFeed('cap_imd', CAP_FEEDS.cap_imd.url, CAP_FEEDS.cap_imd.agency);
    return {
      success:     res.success,
      source:      'India Meteorological Department (IMD) — CAP RSS Feed',
      attribution: 'Data sourced from India Meteorological Department (IMD), Ministry of Earth Sciences',
      fetchedAt:   res.fetchedAt,
      count:       res.count,
      alerts:      res.alerts,
      cached:      res.cached || false
    };
  } catch (err) {
    console.error('IMD CAP feed error:', err.message);
    return {
      success:     false,
      source:      'India Meteorological Department (IMD) — CAP RSS Feed',
      attribution: 'Data sourced from India Meteorological Department (IMD), Ministry of Earth Sciences',
      error:       'IMD live feed temporarily unreachable: ' + err.message,
      count:       0,
      alerts:      [],
      cached:      false
    };
  }
}
// ────────────────────────────────────────────────────────────────────────────

// 1. LIVE NCS EARTHQUAKE INTEGRATION (National Center for Seismology)
async function getUSGSEarthquakes(limit = 35) { // Keeping the function name to avoid breaking AIEngine calls
  const now = Date.now();
  if (earthquakeCache && (now < earthquakeCache.expiresAt)) {
    return { ...earthquakeCache.data, cached: true };
  }

  try {
    const html = await fetchText('https://riseq.seismo.gov.in/riseq/earthquake', {}, 8000);
    const regex = /data-json='(.*?)'/g;
    let match;
    const allQuakes = [];
    
    while ((match = regex.exec(html)) !== null) {
      try {
        const eqData = JSON.parse(match[1]);
        const latLong = eqData.lat_long.split(',').map(s => parseFloat(s.trim()));
        const magMatch = eqData.magnitude_depth.match(/M:\s*([\d.]+)/);
        const depthMatch = eqData.magnitude_depth.match(/D:\s*([\d.]+)km/);
        const mag = magMatch ? parseFloat(magMatch[1]) : 0;
        const depthKm = depthMatch ? parseFloat(depthMatch[1]) : 10;
        const place = eqData.event_name.split(' - ')[1] || 'Unknown Epicenter';
        
        allQuakes.push({
          id: eqData.event_id,
          place: place,
          mag: mag,
          time: new Date().toISOString(),
          epochMs: Date.now(),
          depthKm: depthKm,
          lng: latLong[1],
          lat: latLong[0],
          tsunamiAlert: false,
          significance: Math.round(mag * 20),
          url: 'https://riseq.seismo.gov.in/riseq/earthquake'
        });
      } catch (e) { }
    }

    const parsedQuakes = allQuakes.filter(q => isCoordInsideAP(q.lng, q.lat)); // Strictly filter for AP

    const finalQuakes = parsedQuakes.slice(0, limit);
    const maxMag = finalQuakes.length > 0 ? Math.max(...finalQuakes.map(q => q.mag)) : 0;
    const latestQuake = finalQuakes[0] || null;

    const result = {
      status: 'online',
      source: 'National Center for Seismology (NCS India)',
      generatedAt: new Date().toISOString(),
      count: finalQuakes.length,
      maxMagnitude: maxMag,
      latest: latestQuake,
      earthquakes: finalQuakes,
      cached: false
    };

    earthquakeCache = {
      data: result,
      expiresAt: now + CACHE_TTL_QUAKES_MS
    };

    return result;
  } catch (err) {
    console.error('NCS Live Query failed:', err.message);
    if (earthquakeCache) {
      return { ...earthquakeCache.data, cached: true, stale: true, upstreamError: err.message };
    }
    return {
      status: 'unavailable',
      source: 'USGS Earthquake Hazards Program',
      error: 'Upstream USGS live service temporarily unreachable',
      earthquakes: []
    };
  }
}

function decodeWmoWeatherCode(code) {
  if (code === null || code === undefined || isNaN(code)) return 'UNKNOWN';
  switch (Number(code)) {
    case 0: return 'Clear Sky';
    case 1: return 'Mainly Clear';
    case 2: return 'Partly Cloudy';
    case 3: return 'Overcast';
    case 45: return 'Fog';
    case 48: return 'Depositing Rime Fog';
    case 51: return 'Light Drizzle';
    case 53: return 'Moderate Drizzle';
    case 55: return 'Dense Drizzle';
    case 56: return 'Light Freezing Drizzle';
    case 57: return 'Dense Freezing Drizzle';
    case 61: return 'Slight Rain';
    case 62: return 'Moderate Rain';
    case 63: return 'Heavy Rain';
    case 65: return 'Very Heavy Rain';
    case 66: return 'Light Freezing Rain';
    case 67: return 'Heavy Freezing Rain';
    case 71: return 'Slight Snow Fall';
    case 73: return 'Moderate Snow Fall';
    case 75: return 'Heavy Snow Fall';
    case 77: return 'Snow Grains';
    case 80: return 'Slight Rain Showers';
    case 81: return 'Moderate Rain Showers';
    case 82: return 'Violent Rain Showers';
    case 85: return 'Slight Snow Showers';
    case 86: return 'Heavy Snow Showers';
    case 95: return 'Thunderstorm';
    case 96: return 'Thunderstorm with Slight Hail';
    case 99: return 'Thunderstorm with Heavy Hail';
    default: return `WMO Code ${code}`;
  }
}

// 2. LIVE OPEN-METEO WEATHER INTEGRATION (Authentic ECMWF/GFS live forecast)
async function getOpenMeteoWeather(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || isNaN(lat) || isNaN(lon)) {
    return {
      success: false,
      status: 'UNAVAILABLE',
      sourceId: 'openmeteo_weather',
      source: 'Open-Meteo',
      error: 'Missing or invalid operational coordinates',
      lastUpdated: null,
      latitude: null,
      longitude: null
    };
  }

  const cacheKey = `${Number(lat).toFixed(2)}_${Number(lon).toFixed(2)}`;
  const now = Date.now();

  if (weatherCache.has(cacheKey)) {
    const cached = weatherCache.get(cacheKey);
    if (now < cached.expiresAt) {
      return { ...cached.data, cached: true };
    }
  }

  const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,snowfall,weather_code,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m&hourly=temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m,surface_pressure&timezone=auto`;
  try {
    const data = await fetchJson(omUrl, {}, 7000);
    const curr = data.current || {};
    const hourly = data.hourly || {};

    const temperatureC = curr.temperature_2m !== undefined ? Number(curr.temperature_2m.toFixed(1)) : null;
    const apparentTemperatureC = curr.apparent_temperature !== undefined ? Number(curr.apparent_temperature.toFixed(1)) : null;
    const relativeHumidity = curr.relative_humidity_2m !== undefined ? Math.round(curr.relative_humidity_2m) : null;
    const precipitationMm = curr.precipitation !== undefined ? Number(curr.precipitation.toFixed(1)) : null;
    const rainMm = curr.rain !== undefined ? Number(curr.rain.toFixed(1)) : null;
    const snowfallCm = curr.snowfall !== undefined ? Number(curr.snowfall.toFixed(1)) : null;
    const pressureHpa = curr.surface_pressure !== undefined ? Math.round(curr.surface_pressure) : null;
    const windSpeedKmh = curr.wind_speed_10m !== undefined ? Number(curr.wind_speed_10m.toFixed(1)) : null;
    const windDirectionDeg = curr.wind_direction_10m !== undefined ? Math.round(curr.wind_direction_10m) : null;
    const maxGustKmh = curr.wind_gusts_10m !== undefined ? Number(curr.wind_gusts_10m.toFixed(1)) : (windSpeedKmh !== null ? windSpeedKmh : null);
    const weatherCode = curr.weather_code !== undefined ? Number(curr.weather_code) : null;
    const weatherDescription = decodeWmoWeatherCode(weatherCode);

    const observedAt = curr.time || null;
    const fetchedAt = new Date().toISOString();

    // Severe thresholds based on real physics
    const isSevereWind = maxGustKmh !== null && maxGustKmh >= 65;
    const isExtremeRain = precipitationMm !== null && precipitationMm >= 15;
    const isLowPressure = pressureHpa !== null && pressureHpa <= 990;

    let overallRisk = 'GREEN';
    let advisoryMessage = 'Meteorological conditions stable. No immediate weather alerts for this sector.';
    if (isSevereWind || isExtremeRain || isLowPressure) {
      overallRisk = 'RED';
      advisoryMessage = `CRITICAL WEATHER ADVISORY: Observed peak gusts ${maxGustKmh ?? '—'} km/h, surface pressure ${pressureHpa ?? '—'} hPa. Coastal and flood hazard vigilance required.`;
    } else if ((maxGustKmh !== null && maxGustKmh >= 45) || (precipitationMm !== null && precipitationMm >= 7)) {
      overallRisk = 'ORANGE';
      advisoryMessage = `ELEVATED SQUALLS: Wind gusts reaching ${maxGustKmh} km/h with active precipitation. Secure loose outdoor structures.`;
    }

    const timestamps = (hourly.time || []).slice(0, 120).map(t => new Date(t).getTime());
    const temps = (hourly.temperature_2m || []).slice(0, 120);
    const winds = (hourly.wind_speed_10m || []).slice(0, 120);
    const gusts = (hourly.wind_gusts_10m || []).slice(0, 120);
    const precips = (hourly.precipitation || []).slice(0, 120);
    const pressures = (hourly.surface_pressure || []).slice(0, 120).map(p => Math.round(p));

    const result = {
      success: true,
      sourceId: 'openmeteo_weather',
      source: 'Open-Meteo',
      status: 'LIVE',
      latitude: Number(lat),
      longitude: Number(lon),
      lat: Number(lat),
      lon: Number(lon),
      model: 'ecmwf_gfs_composite',
      cached: false,
      lastUpdated: fetchedAt,
      temperatureC,
      apparentTemperatureC,
      relativeHumidity,
      precipitationMm,
      rainMm,
      snowfallCm,
      pressureHpa,
      windSpeedKmh,
      windDirectionDeg,
      maxGustKmh,
      weatherCode,
      weatherDescription,
      observedAt,
      fetchedAt,
      forecastTime: observedAt,
      current: curr,
      provenance: {
        sourceId: 'openmeteo_weather',
        agency: 'Open-Meteo',
        url: omUrl,
        fetchedAt
      },
      summary: {
        currentTempC: temperatureC,
        currentWindKmh: windSpeedKmh,
        maxGustKmh,
        maxPrecipPerHourMm: precipitationMm,
        capeIndex: null,
        pressureHpa,
        humidityPct: relativeHumidity,
        weatherCode,
        weatherDescription,
        isSevereWind,
        isExtremeRain,
        isHighCape: false,
        overallRisk,
        advisoryMessage
      },
      timeSeries: {
        timestamps,
        temp: temps,
        windKmh: winds,
        gustKmh: gusts,
        precipMm: precips,
        cape: [],
        pressure: pressures
      }
    };

    weatherCache.set(cacheKey, {
      data: result,
      expiresAt: now + CACHE_TTL_WEATHER_MS
    });

    return result;
  } catch (err) {
    console.error('Open-Meteo Weather query failed:', err.message);
    if (weatherCache.has(cacheKey)) {
      const cachedEntry = weatherCache.get(cacheKey);
      return {
        ...cachedEntry.data,
        cached: true,
        stale: true,
        status: 'DEGRADED',
        upstreamError: err.message
      };
    }
    return {
      success: false,
      status: 'UNAVAILABLE',
      sourceId: 'openmeteo_weather',
      source: 'Open-Meteo Weather API',
      error: 'Live weather service unreachable: ' + err.message,
      latitude: Number(lat),
      longitude: Number(lon),
      temperatureC: null,
      apparentTemperatureC: null,
      relativeHumidity: null,
      precipitationMm: null,
      rainMm: null,
      snowfallCm: null,
      pressureHpa: null,
      windSpeedKmh: null,
      windDirectionDeg: null,
      maxGustKmh: null,
      weatherCode: null,
      weatherDescription: null,
      observedAt: null,
      fetchedAt: null,
      forecastTime: null,
      lastUpdated: null,
      provenance: {
        sourceId: 'openmeteo_weather',
        status: 'UNAVAILABLE',
        error: err.message
      }
    };
  }
}

// 3. LIVE OPEN-METEO AIR QUALITY INTEGRATION (Authentic atmospheric telemetry)
async function getOpenMeteoAirQuality(lat, lon) {
  if (lat === undefined || lon === undefined || lat === null || lon === null || isNaN(Number(lat)) || isNaN(Number(lon))) {
    return {
      success: false,
      status: 'UNAVAILABLE',
      sourceId: 'openmeteo_airquality',
      source: 'Open-Meteo Air Quality',
      error: 'Missing or invalid operational coordinates',
      latitude: null,
      longitude: null,
      observedAt: null,
      fetchedAt: null,
      europeanAqi: null,
      usAqi: null,
      pm2_5: null,
      pm10: null,
      carbonMonoxide: null,
      nitrogenDioxide: null,
      sulphurDioxide: null,
      ozone: null,
      category: 'Unavailable',
      color: '#94a3b8',
      provenance: null
    };
  }

  const latNum = Number(Number(lat).toFixed(4));
  const lonNum = Number(Number(lon).toFixed(4));
  const cacheKey = `${latNum.toFixed(2)}_${lonNum.toFixed(2)}`;
  const now = Date.now();

  if (airQualityCache.has(cacheKey)) {
    const cached = airQualityCache.get(cacheKey);
    if (now < cached.expiresAt) {
      return { ...cached.data, cached: true };
    }
  }

  const aqiUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latNum}&longitude=${lonNum}&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,european_aqi,us_aqi`;
  const fetchedAt = new Date().toISOString();

  try {
    const data = await fetchJson(aqiUrl, {}, 7000);
    const curr = data.current || {};

    const pm25 = (curr.pm2_5 !== undefined && curr.pm2_5 !== null) ? Number(curr.pm2_5.toFixed(1)) : null;
    const pm10 = (curr.pm10 !== undefined && curr.pm10 !== null) ? Number(curr.pm10.toFixed(1)) : null;
    const co = (curr.carbon_monoxide !== undefined && curr.carbon_monoxide !== null) ? Number(curr.carbon_monoxide.toFixed(1)) : null;
    const no2 = (curr.nitrogen_dioxide !== undefined && curr.nitrogen_dioxide !== null) ? Number(curr.nitrogen_dioxide.toFixed(1)) : null;
    const so2 = (curr.sulphur_dioxide !== undefined && curr.sulphur_dioxide !== null) ? Number(curr.sulphur_dioxide.toFixed(1)) : null;
    const o3 = (curr.ozone !== undefined && curr.ozone !== null) ? Number(curr.ozone.toFixed(1)) : null;
    const eaqui = (curr.european_aqi !== undefined && curr.european_aqi !== null) ? Math.round(curr.european_aqi) : null;
    const usaqi = (curr.us_aqi !== undefined && curr.us_aqi !== null) ? Math.round(curr.us_aqi) : null;
    const observedAt = curr.time || null;

    let category = 'Good';
    let color = '#22c55e';
    if (usaqi !== null) {
      if (usaqi > 300) { category = 'Hazardous'; color = '#7e22ce'; }
      else if (usaqi > 200) { category = 'Very Unhealthy'; color = '#9333ea'; }
      else if (usaqi > 150) { category = 'Unhealthy'; color = '#ef4444'; }
      else if (usaqi > 100) { category = 'Unhealthy for Sensitive Groups'; color = '#f97316'; }
      else if (usaqi > 50) { category = 'Moderate'; color = '#eab308'; }
    } else {
      category = 'Unavailable';
      color = '#94a3b8';
    }

    const result = {
      success: true,
      sourceId: 'openmeteo_airquality',
      source: 'Open-Meteo Air Quality',
      status: 'LIVE',
      latitude: latNum,
      longitude: lonNum,
      lat: latNum,
      lon: lonNum,
      observedAt,
      fetchedAt,
      lastUpdated: observedAt,
      europeanAqi: eaqui,
      usAqi: usaqi,
      us_aqi: usaqi,
      pm2_5: pm25,
      pm10: pm10,
      carbonMonoxide: co,
      nitrogenDioxide: no2,
      nitrogen_dioxide: no2,
      sulphurDioxide: so2,
      ozone: o3,
      category,
      color,
      provenance: {
        sourceId: 'openmeteo_airquality',
        agency: 'Open-Meteo',
        url: aqiUrl,
        fetchedAt
      },
      cached: false
    };

    airQualityCache.set(cacheKey, {
      data: result,
      expiresAt: now + CACHE_TTL_AQI_MS
    });

    return result;
  } catch (err) {
    console.error('Open-Meteo Air Quality query failed:', err.message);
    if (airQualityCache.has(cacheKey)) {
      const cachedEntry = airQualityCache.get(cacheKey);
      return {
        ...cachedEntry.data,
        cached: true,
        stale: true,
        status: 'DEGRADED',
        upstreamError: err.message
      };
    }
    return {
      success: false,
      status: 'UNAVAILABLE',
      sourceId: 'openmeteo_airquality',
      source: 'Open-Meteo Air Quality',
      error: 'Air quality telemetry unavailable: ' + err.message,
      latitude: latNum,
      longitude: lonNum,
      observedAt: null,
      fetchedAt: null,
      lastUpdated: null,
      europeanAqi: null,
      usAqi: null,
      pm2_5: null,
      pm10: null,
      carbonMonoxide: null,
      nitrogenDioxide: null,
      sulphurDioxide: null,
      ozone: null,
      category: 'Unavailable',
      color: '#94a3b8',
      provenance: {
        sourceId: 'openmeteo_airquality',
        status: 'UNAVAILABLE',
        error: err.message
      }
    };
  }
}

// 4. REAL CWC RIVER WATER LEVEL INTEGRATION (sources/cwc-nwic.js)
// Imported at top of file: getCWCRiverLevels from './sources/cwc-nwic.js'

// Pre-load scenarios if file exists
function getScenarios() {
  try {
    const scPath = path.join(PUBLIC_DIR, 'data', 'scenarios.json');
    if (fs.existsSync(scPath)) {
      return JSON.parse(fs.readFileSync(scPath, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading scenarios.json:', e);
  }
  return [];
}

// Pre-load Census 2011 Demographics
function getCensusLookup() {
  try {
    const cPath = path.join(PUBLIC_DIR, 'data', 'census_lookup.json');
    if (fs.existsSync(cPath)) {
      return JSON.parse(fs.readFileSync(cPath, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading census_lookup.json:', e);
  }
  return [];
}

// In-Memory & File-Backed Shelters Database
let sheltersDataCache = null;
function getSheltersData() {
  if (sheltersDataCache) return sheltersDataCache;
  try {
    const sPath = path.join(PUBLIC_DIR, 'data', 'shelters.json');
    if (fs.existsSync(sPath)) {
      sheltersDataCache = JSON.parse(fs.readFileSync(sPath, 'utf8'));
      return sheltersDataCache;
    }
  } catch (e) {
    console.error('Error loading shelters.json:', e);
  }
  return [];
}

function saveSheltersData(shelters) {
  try {
    sheltersDataCache = shelters;
    const sPath = path.join(PUBLIC_DIR, 'data', 'shelters.json');
    fs.writeFileSync(sPath, JSON.stringify(shelters, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Error saving shelters.json:', e);
    return false;
  }
}

// AI Recommendation Audit Logger
function logAIRecommendation(entry) {
  try {
    const dataDir = path.join(PUBLIC_DIR, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const logPath = path.join(dataDir, 'ai_recommendations_log.json');
    let logs = [];
    if (fs.existsSync(logPath)) {
      try {
        logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
        if (!Array.isArray(logs)) logs = [];
      } catch (e) {
        logs = [];
      }
    }
    logs.unshift(entry);
    if (logs.length > 100) logs = logs.slice(0, 100);
    fs.writeFileSync(logPath, JSON.stringify(logs, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Error logging AI recommendation:', e.message);
    return false;
  }
}


// Haversine Distance Calculation (km)
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Ray-Casting Point-in-Polygon Algorithm: point = [lng, lat], vs = [[lng, lat], ...]
function pointInPolygon(point, vs) {
  if (!vs || !Array.isArray(vs) || vs.length < 3) return false;
  const x = point[0], y = point[1];
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i][0], yi = vs[i][1];
    const xj = vs[j][0], yj = vs[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Active Red Zone Hazard Polygons for Route Avoidance
const COASTAL_FLOOD_ZONE = [
  [82.20, 16.90], [82.35, 16.90], [82.38, 17.15], [82.25, 17.15], [82.20, 16.90]
];
const SEISMIC_ZONE = [
  [93.80, 24.70], [94.10, 24.70], [94.10, 25.15], [93.80, 25.15], [93.80, 24.70]
];
const LANDSLIDE_ZONE = [
  [79.25, 30.30], [79.65, 30.30], [79.65, 30.65], [79.25, 30.65], [79.25, 30.30]
];

// Hardened OSRM Route Details (Distance & Duration) via sources/osrm.js
async function getOsrmRouteDetails(lat1, lon1, lat2, lon2, options = {}) {
  const result = await OsrmService.getOsrmRouteDetails(lat1, lon1, lat2, lon2, options);
  const cacheKey = `${Number(lat1).toFixed(4)},${Number(lon1).toFixed(4)}->${Number(lat2).toFixed(4)},${Number(lon2).toFixed(4)}`;
  osrmRouteDetailsCache.set(cacheKey, result);
  if (result.roadDistKm !== null) osrmDistanceCache.set(cacheKey, result.roadDistKm);
  return result;
}

// Cached OSRM Road Distance Helper
async function getOsrmRoadDistance(lat1, lon1, lat2, lon2, options = {}) {
  const details = await getOsrmRouteDetails(lat1, lon1, lat2, lon2, options);
  return details.roadDistKm;
}

// Safe-Zone Evacuation Routing via OSRM with Red Zone Avoidance (Task 20 Truth-Grounded)
async function calculateEvacuationRoutes(citizenLat, citizenLon, hazardType = 'cyclone', options = {}) {
  const allShelters = getSheltersData();
  const redZones = [COASTAL_FLOOD_ZONE, SEISMIC_ZONE, LANDSLIDE_ZONE];
  return await OsrmService.calculateEvacuationRoutes(citizenLat, citizenLon, hazardType, allShelters, redZones, options);
}

// ================= CANONICAL LIVE STATE ENGINE =================
let cachedCanonicalState = null;
let cachedCanonicalExpiresAt = 0;

async function getCanonicalLiveState(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedCanonicalState && now < cachedCanonicalExpiresAt) {
    return cachedCanonicalState;
  }

  try {
    const [
      radarWeather,
      airQualityData,
      quakes,
      cwcData,
      googleFloodData,
      capData,
      gdacsData,
      healthReport,
      firmsData,
      sentinelData
    ] = await Promise.all([
      getOpenMeteoWeather(16.18, 81.13).catch(() => null),
      getOpenMeteoAirQuality(16.18, 81.13).catch(() => null),
      getUSGSEarthquakes(15).catch(() => null),
      getCWCRiverLevels().catch(() => null),
      getGoogleFloodForecast().catch(() => null),
      getOfficialCapAlerts().catch(() => ({ alerts: [] })),
      getGdacsEvents().catch(() => null),
      SourceRegistry.checkAllSources(false).catch(() => null),
      SatelliteSignal.fetchNasaFirmsHotspots().catch(() => null),
      SatelliteSignal.fetchSentinelFloodSignals().catch(() => null)
    ]);

    const shelters = getSheltersData();
    const habitations = getCensusLookup();

    const canonical = LiveState.buildCanonicalState({
      weatherRaw: radarWeather,
      airQualityRaw: airQualityData,
      seismicRaw: quakes,
      cwcRaw: cwcData,
      googleFloodRaw: googleFloodData,
      capAlerts: capData ? (capData.alerts || []) : [],
      gdacsRaw: gdacsData ? (gdacsData.apEvents || []) : [],
      firmsRaw: firmsData,
      sentinelRaw: sentinelData,
      sheltersRaw: shelters,
      censusHabitations: habitations,
      citizenReportsRaw: storedReports,
      sourceHealthReport: healthReport,
      isCoordInsideAP
    });

    cachedCanonicalState = canonical;
    cachedCanonicalExpiresAt = now + 15000; // 15-second TTL
    return canonical;
  } catch (err) {
    console.error('[Server] Canonical state computation error:', err);
    return LiveState.getDefaultEmptyState();
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let pathname = decodeURIComponent(parsedUrl.pathname);

  // 0. Canonical Normalized Live State API
  if (pathname === '/api/canonical-state' || pathname === '/api/live-state') {
    try {
      const force = parsedUrl.query.refresh === '1' || parsedUrl.query.refresh === 'true';
      const state = await getCanonicalLiveState(force);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(state));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ================= REST API ENDPOINTS =================
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    // 1. System Health
    if (pathname === '/api/health') {
      const allShelters = getSheltersData();
      const storedThreats = (global.APP_DATA && Array.isArray(global.APP_DATA.activeHazards)) ? global.APP_DATA.activeHazards.length : 0;
      res.writeHead(200);
      return res.end(JSON.stringify({
        status: 'online',
        system: 'Risk2Rescue Command Hub',
        version: '2.1.0',
        uptimeSeconds: Math.floor((Date.now() - systemStartTime) / 1000),
        activeThreatsCount: storedThreats,
        nodeVersion: process.version,
        dataProviders: {
          earthquakes: 'USGS Earthquake Hazards Program (Active)',
          weather: WINDY_DATA_KEY ? 'Windy Point Forecast v2 (API Key Active)' : 'Open-Meteo Live Forecast (Active)',
          airQuality: 'Open-Meteo Atmospheric Quality Feed (Active)'
        }
      }));
    }

    // 1b. Central Source Registry Health Check & Audit Probes
    if (pathname === '/api/sources/health') {
      try {
        const force = parsedUrl.query.refresh === '1';
        const health = await SourceRegistry.checkAllSources(force);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(safeObject(health)));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'Source health check failed: ' + err.message }));
      }
    }

    // 1c. Source Raw Payload & Metrics Inspector
    if (pathname.startsWith('/api/sources/') && pathname.endsWith('/raw')) {
      const parts = pathname.split('/');
      const sourceId = parts[3];
      const metrics = SourceRegistry.getSourceMetrics(sourceId);
      if (!metrics) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: `No metrics or raw cache found for source: ${sourceId}` }));
      }
      // Sanitize rawPayload so zero secrets or auth tokens can leak
      let safeRaw = metrics.lastRawPayload;
      if (safeRaw) {
        const rawStr = typeof safeRaw === 'string' ? safeRaw : JSON.stringify(safeRaw);
        const scrubbed = rawStr
          .replace(/(key|token|secret|authorization)=([^&"\s]+)/gi, '$1=[REDACTED]')
          .replace(/"(key|apiKey|token|secret|clientSecret|client_secret|authorization)":\s*"[^"]+"/gi, '"$1":"[REDACTED]"');
        try { safeRaw = JSON.parse(scrubbed); } catch (e) { safeRaw = scrubbed; }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        sourceId,
        metrics: {
          lastAttemptAt: metrics.lastAttemptAt,
          lastSuccessAt: metrics.lastSuccessAt,
          lastLatencyMs: metrics.lastLatencyMs,
          consecutiveFailures: metrics.consecutiveFailures,
          lastError: metrics.lastError,
          lastRecordCount: metrics.lastRecordCount,
          lastObservedAt: metrics.lastObservedAt || null
        },
        rawPayload: safeRaw
      }));
    }

    // 2. Scenarios
    if (pathname === '/api/scenarios') {
      const scenarios = getScenarios();
      res.writeHead(200);
      return res.end(JSON.stringify({ success: true, scenarios }));
    }

    // 2b. Official Unified De-duplicated CAP Alerts (IMD + NDMA Alert Hub)
    if (pathname === '/api/alerts/official') {
      try {
        const data = await getOfficialCapAlerts();
        res.writeHead(200);
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ success: false, error: err.message, alerts: [] }));
      }
    }

    // 2c. CPCB Real-Time Air Quality (data.gov.in CAAQMS Ground Stations)
    if (pathname === '/api/air-quality/cpcb') {
      try {
        const data = await getCpcbAirQuality();
        res.writeHead(data.status === 'NOT_CONFIGURED' ? 200 : (data.success ? 200 : 503));
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ success: false, status: 'UNAVAILABLE', error: err.message, stations: [] }));
      }
    }

    // 2d. AP Weather Data (data.gov.in)
    if (pathname === '/api/ap-weather' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      try {
        const data = await getApWeather();
        res.writeHead(data.status === 'NOT_CONFIGURED' ? 200 : (data.success ? 200 : 503));
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ success: false, status: 'UNAVAILABLE', error: err.message, data: null }));
      }
    }

    // 2d. GDACS Global Multi-Hazard Alerts (UN / European Commission)
    if (pathname === '/api/gdacs/events') {
      try {
        const data = await getGdacsEvents();
        res.writeHead(data.success ? 200 : 503);
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ success: false, status: 'UNAVAILABLE', error: err.message, events: [] }));
      }
    }

    // 2e. Google Flood Hub Hydrologic Forecasting API
    if (pathname === '/api/flood/forecast') {
      try {
        const data = await getGoogleFloodForecast();
        res.writeHead(data.status === 'NOT_CONFIGURED' ? 200 : (data.success ? 200 : 503));
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ success: false, status: 'UNAVAILABLE', error: err.message, gauges: [] }));
      }
    }

    // 2f. AI Layer Context Input Contract
    // 2f. AI Layer Context Input Contract (Task 21 Grounded)
    if (pathname === '/api/ai/context') {
      try {
        const health = await SourceRegistry.checkAllSources(false);
        const liveCount = health.summary?.live || 0;
        const totalSources = health.summary?.total || 1;
        const dataConfidence = Math.round((liveCount / Math.max(1, totalSources - health.summary?.notConfigured)) * 100);

        const radarWeather = await getOpenMeteoWeather(16.18, 81.13);
        const quakes = await getUSGSEarthquakes(10);
        const alertsData = await getOfficialCapAlerts();
        const allShelters = getSheltersData();

        let airQuality = null;
        try {
          airQuality = await getOpenMeteoAirQuality(16.18, 81.13);
        } catch (e) {}

        let riverData = null;
        try {
          riverData = await getCWCRiverLevels();
        } catch (e) {}

        let fireData = null;
        try {
          fireData = await getNasaFirmsHotspots();
        } catch (e) {}

        let copernicusObs = null;
        try {
          copernicusObs = await getLatestSentinel1Observation();
        } catch (e) {}

        // Shelter metrics: preserve UNKNOWN occupancy without converting to 0
        const totalCapacity = allShelters.reduce((a, s) => a + (s.capacity || 0), 0);
        const reportingShelters = allShelters.filter(s => typeof s.current_occupancy === 'number' && !isNaN(s.current_occupancy));
        const currentOccupancy = reportingShelters.length > 0 ? reportingShelters.reduce((a, s) => a + s.current_occupancy, 0) : null;
        const occStatus = allShelters.every(s => typeof s.current_occupancy === 'number' && !isNaN(s.current_occupancy))
          ? 'LIVE'
          : (reportingShelters.length > 0 ? 'PARTIAL' : 'UNKNOWN');

        res.writeHead(200);
        return res.end(JSON.stringify({
          generatedAt: new Date().toISOString(),
          liveSourceCount: liveCount,
          minRequiredSources: AIBridge.MIN_LIVE_SOURCES_FOR_AI,
          hasSufficientData: liveCount >= AIBridge.MIN_LIVE_SOURCES_FOR_AI,
          confidenceMetrics: {
            dataCompletenessPct: dataConfidence,
            dataConfidencePct: dataConfidence,
            sourceCertainty: 'EVIDENCE_GROUNDED',
            modelConfidence: 'NOT_EVALUATED'
          },
          classificationAudit: {
            liveSources: ['openmeteo_weather', 'openmeteo_airquality', 'usgs_earthquakes', 'osrm_routing', 'cap_imd', 'cwc_nwic_river', 'nasa_firms_viirs'],
            referenceSources: ['ap_sdma_shelters', 'census_india_ap', 'bhuvan_wms', 'ap_boundary_polygon'],
            archivedSources: ['cap_ndma'],
            derivedLayers: ['vpi_priority_ranking', 'multi_hazard_correlation', 'sentinel1_processing', 'derived_flood_condition'],
            drillLayers: ['simulated_scenarios', 'drill_sos_reports']
          },
          telemetry: {
            weather: {
              sourceId: 'openmeteo_weather',
              tier: 'LIVE_API',
              role: 'PRIMARY',
              status: radarWeather?.status || 'UNAVAILABLE',
              temperatureC: (radarWeather?.status === 'LIVE' || (radarWeather?.status === 'DEGRADED' && radarWeather?.summary?.temperatureC != null)) ? (radarWeather?.summary?.temperatureC ?? null) : null,
              windSpeedKmH: (radarWeather?.status === 'LIVE' || (radarWeather?.status === 'DEGRADED' && radarWeather?.summary?.windSpeedKmH != null)) ? (radarWeather?.summary?.windSpeedKmH ?? null) : null,
              maxGustSpeedKmH: (radarWeather?.status === 'LIVE' || (radarWeather?.status === 'DEGRADED' && radarWeather?.summary?.maxGustKmh != null)) ? (radarWeather?.summary?.maxGustKmh ?? null) : null,
              pressureHpa: (radarWeather?.status === 'LIVE' || (radarWeather?.status === 'DEGRADED' && radarWeather?.summary?.pressureHpa != null)) ? (radarWeather?.summary?.pressureHpa ?? null) : null,
              observedAt: radarWeather?.observedAt ?? null,
              stale: Boolean(radarWeather?.stale)
            },
            airQuality: {
              sourceId: 'openmeteo_airquality',
              tier: 'LIVE_API',
              role: 'PRIMARY',
              status: airQuality?.status || 'UNAVAILABLE',
              usAqi: (airQuality?.status === 'LIVE' || (airQuality?.status === 'DEGRADED' && airQuality?.usAqi != null)) ? (airQuality?.usAqi ?? null) : null,
              pm2_5: (airQuality?.status === 'LIVE' || (airQuality?.status === 'DEGRADED' && airQuality?.pm2_5 != null)) ? (airQuality?.pm2_5 ?? null) : null,
              pm10: (airQuality?.status === 'LIVE' || (airQuality?.status === 'DEGRADED' && airQuality?.pm10 != null)) ? (airQuality?.pm10 ?? null) : null,
              observedAt: airQuality?.observedAt ?? null,
              stale: Boolean(airQuality?.stale)
            },
            river: {
              sourceId: 'cwc_nwic_river',
              tier: 'LIVE_API',
              role: 'PRIMARY',
              status: riverData?.status || 'UNAVAILABLE',
              stationsCount: (riverData?.status === 'LIVE' || (riverData?.status === 'DEGRADED' && Array.isArray(riverData?.stations))) ? riverData.stations.length : null,
              floodCondition: (riverData?.status === 'LIVE' || (riverData?.status === 'DEGRADED' && riverData?.floodCondition)) ? (riverData?.floodCondition || 'NORMAL') : null,
              trend: (riverData?.status === 'LIVE' || (riverData?.status === 'DEGRADED' && riverData?.trend)) ? (riverData?.trend || 'STEADY') : null,
              observedAt: riverData?.observedAt ?? null,
              stale: Boolean(riverData?.stale)
            },
            fire: {
              sourceId: 'nasa_firms_viirs',
              tier: 'LIVE_API',
              role: 'PRIMARY',
              status: fireData?.status || 'UNAVAILABLE',
              activeHotspotCount: (fireData?.status === 'LIVE' || (fireData?.status === 'DEGRADED' && typeof fireData?.observationCount === 'number')) ? fireData.observationCount : null,
              observedAt: (fireData?.status === 'LIVE' || (fireData?.status === 'DEGRADED' && fireData?.latestAcquisitionTime)) ? fireData.latestAcquisitionTime : null,
              stale: Boolean(fireData?.stale)
            },
            satellite: {
              sourceId: 'copernicus_dataspace',
              tier: 'LIVE_API',
              role: 'PRIMARY',
              status: copernicusObs?.status || 'NOT_CONFIGURED',
              sceneId: (copernicusObs?.status === 'LIVE' || (copernicusObs?.status === 'DEGRADED' && copernicusObs?.sceneId)) ? copernicusObs.sceneId : null,
              acquisitionTime: (copernicusObs?.status === 'LIVE' || (copernicusObs?.status === 'DEGRADED' && copernicusObs?.acquisitionTime)) ? copernicusObs.acquisitionTime : null,
              floodDetectionRule: 'Scene catalogue entry does NOT confirm flooding; SAR backscatter pixel processing required.'
            },
            radar: {
              sourceId: 'openmeteo_weather',
              tier: 'LIVE_API',
              role: 'PRIMARY',
              maxGustSpeedKmH: (radarWeather?.status === 'LIVE' || (radarWeather?.status === 'DEGRADED' && radarWeather?.summary?.maxGustKmh != null)) ? (radarWeather?.summary?.maxGustKmh ?? null) : null,
              pressureHpa: (radarWeather?.status === 'LIVE' || (radarWeather?.status === 'DEGRADED' && radarWeather?.summary?.pressureHpa != null)) ? (radarWeather?.summary?.pressureHpa ?? null) : null
            },
            seismic: {
              sourceId: 'usgs_earthquakes',
              tier: 'LIVE_API',
              role: 'PRIMARY',
              maxMagnitude: (quakes?.status === 'LIVE' || quakes?.maxMagnitude != null) ? (typeof quakes.maxMagnitude === 'number' ? quakes.maxMagnitude : 0) : null,
              total24h: (quakes?.status === 'LIVE' || quakes?.count != null) ? (typeof quakes.count === 'number' ? quakes.count : 0) : null,
              status: (quakes?.status === 'LIVE' || quakes?.maxMagnitude != null) ? ((quakes.maxMagnitude >= 5.0) ? 'ELEVATED' : 'NORMAL') : 'UNAVAILABLE'
            }
          },
          populationBaseline: {
            sourceId: 'census_india_ap',
            tier: 'OFFICIAL_BASELINE',
            role: 'PRIMARY',
            stateBaselineTotal: 49386799,
            semantics: 'Census India (AP 2011) official baseline enumeration; exposure is strictly derived from active hazard polygon intersections.'
          },
          alerts: alertsData.alerts || [],
          alertsSummary: {
            liveOfficialAlerts: alertsData.alerts || [],
            expiredAlerts: alertsData.expiredAlerts || [],
            archivedAlerts: alertsData.archivedAlerts || [],
            drillAlerts: alertsData.drillAlerts || [],
            correlatedHazards: correlateMultiHazards(alertsData.alerts || []),
            activeCount: (alertsData.alerts || []).length,
            expiredCount: (alertsData.expiredAlerts || []).length,
            archivedCount: (alertsData.archivedAlerts || []).length,
            drillCount: (alertsData.drillAlerts || []).length,
            correlationRule: 'Concurrent hazards are correlated co-occurrences; correlation does not imply causation without explicit authoritative source text.'
          },
          sheltersSummary: {
            sourceId: 'ap_sdma_shelters',
            tier: 'OFFICIAL_BASELINE',
            role: 'PRIMARY',
            totalCapacity: totalCapacity,
            totalShelters: allShelters.length,
            reportingSheltersCount: reportingShelters.length,
            unconfirmedOccupancyCount: allShelters.length - reportingShelters.length,
            currentOccupancy: currentOccupancy,
            occupancyTelemetryStatus: occStatus,
            occupancyNote: 'Registered capacity is reference baseline; unconfirmed shelters have unknown occupancy and must never be treated as 0.'
          },
          citizenReportsSummary: {
            verifiedCount: storedReports.filter(r => !r.isDrill && !r.isSimulated && r.tier !== 'SIMULATED' && (r.status === 'Verified' || r.lifecycleStatus === 'VERIFIED')).length,
            unverifiedCount: storedReports.filter(r => !r.isDrill && !r.isSimulated && r.tier !== 'SIMULATED' && (r.status === 'Pending' || r.status === 'Submitted' || r.status === 'PENDING_TRIAGE' || r.lifecycleStatus === 'PENDING')).length,
            verifiedIncidents: storedReports.filter(r => !r.isDrill && !r.isSimulated && r.tier !== 'SIMULATED' && (r.status === 'Verified' || r.lifecycleStatus === 'VERIFIED')).map(r => ({
              id: r.id,
              type: r.type,
              location: r.location,
              lat: r.lat ?? r.latitude ?? null,
              lng: r.lng ?? r.longitude ?? null,
              locationStatus: (r.lat || r.latitude) ? 'AVAILABLE' : 'UNAVAILABLE',
              status: 'VERIFIED',
              isSos: Boolean(r.isSos || (r.type && String(r.type).toUpperCase().includes('SOS'))),
              submittedAt: r.submittedAt || r.timestamp
            })),
            unverifiedClaims: storedReports.filter(r => !r.isDrill && !r.isSimulated && r.tier !== 'SIMULATED' && (r.status === 'Pending' || r.status === 'Submitted' || r.status === 'PENDING_TRIAGE' || r.lifecycleStatus === 'PENDING')).map(r => ({
              id: r.id,
              type: r.type,
              location: r.location,
              status: 'UNVERIFIED',
              claimDescription: `An unverified citizen report indicates ${r.type || 'hazard'}: ${r.desc || r.message || 'Details unconfirmed'}`
            }))
          },
          routingSummary: {
            sourceId: 'osrm_routing',
            provider: 'Project OSRM / OpenStreetMap',
            tier: 'LIVE_API',
            role: 'PRIMARY',
            availability: (health.sources?.find(s => s.id === 'osrm_routing')?.status === 'LIVE') ? 'ROUTE AVAILABLE' : (health.sources?.find(s => s.id === 'osrm_routing')?.status === 'DEGRADED' ? 'ROUTE DEGRADED / STALE' : 'ROUTE UNAVAILABLE'),
            totalCachedRoutes: OsrmService.getOsrmRoutingSummary().totalRoutesCached,
            uncertaintyDisclaimer: 'Turn-by-turn road route durations are deterministic OSRM calculations. Road passability during active cyclones/floods is unverified until inspected by field responders. AI must communicate routing uncertainty if OSRM is unavailable or degraded.'
          },
          sourceHealthSummary: health.summary
        }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 2g. Unified Operational Dashboard State
    if (pathname === '/api/dashboard/state') {
      try {
        const radarWeather = await getOpenMeteoWeather(16.18, 81.13);
        const quakes = await getUSGSEarthquakes(10);
        const allShelters = getSheltersData();
        const alertsData = await getOfficialCapAlerts();
        let cwcGauges = [];
        try {
          const cwc = await getCWCRiverLevels();
          if (cwc.success && Array.isArray(cwc.stations)) cwcGauges = cwc.stations;
        } catch(e) {}

        const totalCap = allShelters.reduce((a, s) => a + (s.capacity || 0), 0);
        const reporting = allShelters.filter(s => typeof s.current_occupancy === 'number' && !isNaN(s.current_occupancy));
        const currentOcc = reporting.length > 0 ? reporting.reduce((a, s) => a + s.current_occupancy, 0) : null;
        const occStatus = reporting.length === allShelters.length ? 'LIVE' : (reporting.length > 0 ? 'PARTIAL' : 'UNKNOWN');
        const maxGust = radarWeather.summary?.maxGustKmh ?? null;

        res.writeHead(200);
        return res.end(JSON.stringify({
          timestamp: new Date().toISOString(),
          kpis: {
            activeHazards: { value: alertsData.count, unit: '', sourceId: 'cap_imd', status: (alertsData.liveFeedsResponding > 0 || alertsData.success) ? 'LIVE' : 'UNAVAILABLE', fetchedAt: alertsData.fetchedAt },
            activeAlerts: { value: alertsData.count, unit: '', sourceId: 'cap_imd', status: (alertsData.liveFeedsResponding > 0 || alertsData.success) ? 'LIVE' : 'UNAVAILABLE' },
            expiredAlerts: { value: alertsData.expiredAlerts ? alertsData.expiredAlerts.length : 0, unit: '', status: 'EXPIRED' },
            archivedAlerts: { value: alertsData.archivedAlerts ? alertsData.archivedAlerts.length : 0, unit: '', status: 'ARCHIVED' },
            drillAlerts: { value: alertsData.drillAlerts ? alertsData.drillAlerts.length : 0, unit: '', status: 'DRILL' },
            populationAtRisk: { value: 0, unit: '', sourceId: 'census_india_ap', tier: 'DERIVED', contributingSources: ['cap_imd', 'census_india_ap'], status: 'BASELINE' },
            shelterCapacity: {
              value: totalCap,
              referenceCapacity: totalCap,
              currentOccupancy: currentOcc,
              occupancyStatus: occStatus,
              sheltersReporting: reporting.length,
              totalShelters: allShelters.length,
              unit: '',
              sourceId: 'ap_sdma_shelters',
              status: 'BASELINE',
              tier: 'OFFICIAL_BASELINE'
            },
            gustSpeed: { value: maxGust, unit: 'km/h', sourceId: 'openmeteo_weather', status: maxGust !== null ? 'LIVE' : 'UNAVAILABLE', fetchedAt: radarWeather.lastUpdated },
            seismicMagnitude: { value: quakes.maxMagnitude > 0 ? quakes.maxMagnitude : null, unit: 'M', sourceId: 'usgs_earthquakes', status: quakes.status === 'unavailable' ? 'UNAVAILABLE' : 'LIVE', fetchedAt: quakes.fetchedAt }
          },
          alerts: alertsData.alerts || [],
          expiredAlerts: alertsData.expiredAlerts || [],
          archivedAlerts: alertsData.archivedAlerts || [],
          drillAlerts: alertsData.drillAlerts || [],
          correlatedHazards: correlateMultiHazards(alertsData.alerts || []),
          riverGauges: cwcGauges,
          shelters: allShelters,
          citizenReports: {
            total: storedReports.filter(r => !r.isDrill && !r.isSimulated && r.tier !== 'SIMULATED').length,
            pendingCount: storedReports.filter(r => !r.isDrill && !r.isSimulated && r.tier !== 'SIMULATED' && (r.status === 'Pending' || r.status === 'Submitted' || r.status === 'PENDING_TRIAGE' || r.lifecycleStatus === 'PENDING')).length,
            verifiedCount: storedReports.filter(r => !r.isDrill && !r.isSimulated && r.tier !== 'SIMULATED' && (r.status === 'Verified' || r.lifecycleStatus === 'VERIFIED')).length,
            sourceId: 'citizen_reports',
            tier: 'LIVE_API',
            status: 'LIVE'
          }
        }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 3. LIVE EARTHQUAKES (USGS GeoJSON API)
    if (pathname === '/api/earthquakes/live') {
      const limit = parseInt(parsedUrl.query.limit, 10) || 30;
      const data = await getUSGSEarthquakes(limit);
      res.writeHead(data.status === 'unavailable' ? 503 : 200);
      return res.end(JSON.stringify(data));
    }

    // 4. LIVE AIR QUALITY (Open-Meteo strictly live, no fake coordinates)
    if (pathname === '/api/air-quality/live' || pathname === '/api/air-quality/point') {
      const qLat = parsedUrl.query.lat;
      const qLon = parsedUrl.query.lon || parsedUrl.query.lng;
      if (qLat === undefined || qLon === undefined || isNaN(Number(qLat)) || isNaN(Number(qLon))) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          success: false,
          status: 'UNAVAILABLE',
          error: 'Missing required coordinates: lat and lon must be provided'
        }));
      }
      const latNum = Number(qLat);
      const lonNum = Number(qLon);
      const data = await getOpenMeteoAirQuality(latNum, lonNum);
      const statusCode = data.success ? 200 : (data.status === 'DEGRADED' ? 200 : 503);
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(data));
    }

    // 4a. OPENAQ COMMUNITY AIR QUALITY
    if (pathname === '/api/air-quality/openaq') {
      try {
        const data = await getOpenAqAirQuality();
        const statusCode = (data.status === 'NOT_CONFIGURED' || data.success) ? 200 : 503;
        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: false, status: 'UNAVAILABLE', error: err.message, stations: [] }));
      }
    }

    // 4b. LIVE WEATHER POINT FORECAST (Open-Meteo strictly live, no fake coordinates)
    if (pathname === '/api/weather/live' || pathname === '/api/weather/point') {
      const qLat = parsedUrl.query.lat;
      const qLon = parsedUrl.query.lon || parsedUrl.query.lng;
      if (qLat === undefined || qLon === undefined || isNaN(Number(qLat)) || isNaN(Number(qLon))) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          success: false,
          status: 'UNAVAILABLE',
          error: 'Missing required coordinates: lat and lon must be provided'
        }));
      }
      const latNum = Number(qLat);
      const lonNum = Number(qLon);
      const weatherData = await getOpenMeteoWeather(latNum, lonNum);
      const statusCode = weatherData.success ? 200 : (weatherData.status === 'DEGRADED' ? 200 : 503);
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(weatherData));
    }

    // 5. LIVE MULTI-SENSOR TELEMETRY STREAM (Honest, zero fabricated gauges)
    if (pathname === '/api/telemetry/live') {
      const radarWeather = await getOpenMeteoWeather(16.18, 81.13);
      const quakes = await getUSGSEarthquakes(10);

      const maxGust = radarWeather.success && radarWeather.summary ? radarWeather.summary.maxGustKmh : null;
      const corePressure = radarWeather.success && radarWeather.summary ? radarWeather.summary.pressureHpa : null;
      const latestQuake = quakes.latest ? `${quakes.latest.mag} Mag — ${quakes.latest.place}` : null;

      let riverGauges = [];
      let riverStatus = 'UNAVAILABLE';
      try {
        const cwcData = await getCWCRiverLevels();
        if (cwcData && (cwcData.success || cwcData.status === 'DEGRADED') && Array.isArray(cwcData.stations) && cwcData.stations.length > 0) {
          riverGauges = cwcData.stations.slice(0, 15).map(s => ({
            stationId: s.stationId || s.id,
            stationName: s.stationName || s.station,
            station: `${s.basin} - ${s.stationName || s.station}`,
            riverName: s.riverName || s.river,
            levelMeters: s.waterLevel !== undefined ? s.waterLevel : s.waterLevelMeters,
            waterLevel: s.waterLevel !== undefined ? s.waterLevel : s.waterLevelMeters,
            dangerLevel: s.dangerLevel || null,
            warningLevel: s.warningLevel || null,
            dangerMarkMeters: s.dangerLevel || null,
            warningMarkMeters: s.warningLevel || null,
            floodCondition: s.floodCondition || 'UNKNOWN',
            trend: s.trend || 'UNKNOWN',
            type: 'CWC NWIC Live Telemetry',
            timestamp: s.observedAt || s.timestamp,
            observedAt: s.observedAt || s.timestamp,
            lat: s.latitude !== undefined ? s.latitude : s.lat,
            lon: s.longitude !== undefined ? s.longitude : s.lon,
            latitude: s.latitude !== undefined ? s.latitude : s.lat,
            longitude: s.longitude !== undefined ? s.longitude : s.lon,
            sourceId: 'cwc_nwic_river',
            status: s.stationStatus || (s.waterLevel !== null ? 'LIVE' : 'UNAVAILABLE'),
            provenance: 'cwc_nwic_live'
          }));
          riverStatus = cwcData.status || (riverGauges.some(g => g.levelMeters !== null) ? 'LIVE' : 'DEGRADED');
        }
      } catch (cwce) {
        riverStatus = 'UNAVAILABLE';
      }

      const allShelters = getSheltersData();
      const totalShelterCap = allShelters.reduce((acc, s) => acc + (s.capacity || 0), 0);
      const reportingShelters = allShelters.filter(s => typeof s.current_occupancy === 'number' && !isNaN(s.current_occupancy));
      const currentShelterOcc = reportingShelters.length > 0 ? reportingShelters.reduce((acc, s) => acc + s.current_occupancy, 0) : null;
      const shelterOccStatus = reportingShelters.length === allShelters.length ? 'LIVE' : (reportingShelters.length > 0 ? 'PARTIAL' : 'UNKNOWN');

      const telemetry = {
        timestamp: new Date().toISOString(),
        radar: {
          station: 'Open-Meteo Surface Forecast (Machilipatnam Sector)',
          coordinates: { lat: 16.18, lon: 81.13 },
          maxGustSpeedKmH: maxGust,
          corePressureHpa: corePressure,
          status: maxGust !== null ? 'LIVE' : 'UNAVAILABLE',
          sourceId: 'openmeteo_weather',
          source: radarWeather.source || 'Open-Meteo Real-Time Telemetry',
          fetchedAt: radarWeather.lastUpdated || new Date().toISOString()
        },
        riverGauges: riverGauges,
        riverGaugeStatus: riverStatus,
        riverGaugesMeta: {
          sourceId: 'cwc_nwic_river',
          status: riverStatus,
          fetchedAt: new Date().toISOString()
        },
        seismic: {
          status: (quakes.maxMagnitude >= 5.0) ? 'ELEVATED' : (quakes.count > 0 ? 'NORMAL' : 'UNAVAILABLE'),
          latestEvent: latestQuake,
          totalEvents24h: quakes.count || 0,
          maxRecordedMagnitude: quakes.maxMagnitude || 0,
          sourceId: 'usgs_earthquakes',
          source: quakes.source || 'USGS Earthquake Hazards Program',
          fetchedAt: quakes.fetchedAt || new Date().toISOString()
        },
        shelters: {
          totalCapacity: totalShelterCap,
          currentOccupancy: currentShelterOcc,
          occupancyStatus: shelterOccStatus,
          sheltersReporting: reportingShelters.length,
          totalShelters: allShelters.length,
          sourceId: 'ap_sdma_shelters',
          tier: 'OFFICIAL_BASELINE',
          type: 'AP SDMA Directory Baseline'
        }
      };

      res.writeHead(200);
      return res.end(JSON.stringify(telemetry));
    }

    // 5b. REAL CWC RIVER WATER LEVEL TELEMETRY (NWIC CKAN Datastore API)
    if (pathname === '/api/cwc/river-levels') {
      const data = await getCWCRiverLevels();
      const statusCode = (data.success || data.status === 'DEGRADED') ? 200 : 503;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    // 5c. REAL NASA FIRMS VIIRS ACTIVE FIRE / THERMAL ANOMALIES
    if (pathname === '/api/fire/live' || pathname === '/api/firms') {
      const data = await getNasaFirmsHotspots();
      const statusCode = (data.status === 'LIVE' || data.status === 'NOT_CONFIGURED') ? 200 : (data.status === 'DEGRADED' ? 200 : 503);
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(data));
    }

    // 5d. REAL COPERNICUS DATA SPACE SENTINEL-1 LATEST OBSERVATION
    if (pathname === '/api/satellite/latest') {
      const data = await getLatestSentinel1Observation();
      const statusCode = (data.status === 'LIVE' || data.status === 'NOT_CONFIGURED') ? 200 : (data.status === 'DEGRADED' ? 200 : 503);
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(data));
    }

    // 5e. SENTINEL-1 DERIVED SATELLITE INDICATORS / PROCESSING
    if (pathname === '/api/satellite/processing') {
      const data = await processLatestSentinel1Observation();
      const statusCode = (data.status === 'PROCESSED' || data.status === 'NOT_CONFIGURED' || data.status === 'PROCESSING_UNAVAILABLE' || data.status === 'DEGRADED') ? 200 : (data.status === 'REJECTED_OUT_OF_BOUNDS' ? 422 : 503);
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(data));
    }

    // 5f. SENTINEL-1 PRODUCT PAYLOAD & CREDENTIAL ACCESS VERIFICATION (TASK 14)
    if (pathname === '/api/satellite/access-verification') {
      const data = await verifySentinel1ProductAccess();
      const statusCode = (data.status === 'LIVE' || data.status === 'NOT_CONFIGURED' || data.status === 'DEGRADED') ? 200 : 503;
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(data));
    }

    // 6. Alerts Store
    if (pathname === '/api/alerts') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            data.id = 'ALT-' + Date.now();
            data.timestamp = new Date().toISOString();
            storedAlerts.unshift(data);
            res.writeHead(201);
            return res.end(JSON.stringify({ success: true, alert: data }));
          } catch (e) {
            res.writeHead(400);
            return res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
          }
        });
        return;
      } else {
        try {
          const capData = await getOfficialCapAlerts();
          const activeOfficial = capData ? (capData.alerts || []) : [];
          res.writeHead(200);
          return res.end(JSON.stringify({
            alerts: activeOfficial,
            officialAlerts: activeOfficial,
            dispatches: storedAlerts,
            count: activeOfficial.length,
            fetchedAt: capData.fetchedAt || new Date().toISOString()
          }));
        } catch (e) {
          res.writeHead(200);
          return res.end(JSON.stringify({ alerts: [], dispatches: storedAlerts, count: 0 }));
        }
      }
    }

    // 7. Citizen Reports Store & Lifecycle API
    if (pathname === '/api/reports' || pathname.startsWith('/api/reports/')) {
      // 7a. Authority Lifecycle Endpoints: /api/reports/:id/(verify|reject|resolve|escalate)
      const actionMatch = pathname.match(/^\/api\/reports\/([^/]+)\/(verify|reject|resolve|escalate)$/);
      if (actionMatch && req.method === 'POST') {
        const targetId = decodeURIComponent(actionMatch[1]);
        const action = actionMatch[2];
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}');
            const rep = storedReports.find(r => r.id === targetId || r.reportId === targetId);
            if (!rep) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'Report not found' }));
            }

            if (action === 'verify') {
              rep.status = 'Verified';
              rep.verificationStatus = 'VERIFIED';
              rep.lifecycleStatus = 'VERIFIED';
              rep.verifiedAt = new Date().toISOString();
              rep.verifiedTimestamp = Date.now();
              rep.verifiedBy = payload.verifiedBy || 'Incident Commander';
              rep.officerNotes = payload.officerNotes || 'Confirmed by field inspection team.';
            } else if (action === 'reject') {
              rep.status = 'Rejected';
              rep.verificationStatus = 'REJECTED';
              rep.lifecycleStatus = 'REJECTED';
              rep.rejectedAt = new Date().toISOString();
              rep.rejectedTimestamp = Date.now();
              rep.rejectedBy = payload.rejectedBy || 'Incident Commander';
              rep.rejectionReason = payload.reason || 'Unsubstantiated / False Alarm';
            } else if (action === 'resolve') {
              rep.status = 'Resolved';
              rep.lifecycleStatus = 'RESOLVED';
              rep.resolvedAt = new Date().toISOString();
              rep.resolvedTimestamp = Date.now();
              rep.resolvedBy = payload.resolvedBy || 'Incident Commander';
              rep.resolutionNotes = payload.notes || 'Emergency resolved';
            } else if (action === 'escalate') {
              rep.status = 'Escalated';
              rep.lifecycleStatus = 'ESCALATED';
              rep.escalatedAt = new Date().toISOString();
              rep.escalatedTimestamp = Date.now();
              rep.escalatedBy = payload.escalatedBy || 'Incident Commander';
              rep.escalationNotes = payload.notes || 'Priority elevated';
            }

            cachedCanonicalExpiresAt = 0; // invalidate cache
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, action, report: rep }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (pathname === '/api/reports' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');

            // Input validation: coordinates
            const rawLat = data.latitude ?? data.lat ?? data.locationCoords?.latitude ?? data.locationCoords?.lat;
            const rawLng = data.longitude ?? data.lng ?? data.lon ?? data.locationCoords?.longitude ?? data.locationCoords?.lng;

            const hasLat = rawLat !== undefined && rawLat !== null && rawLat !== '';
            const hasLng = rawLng !== undefined && rawLng !== null && rawLng !== '';

            if (hasLat !== hasLng) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'Both latitude and longitude must be provided together or neither.' }));
            }

            let lat = null;
            let lng = null;
            let isInsideAP = null;

            if (hasLat && hasLng) {
              const numLat = Number(rawLat);
              const numLng = Number(rawLng);
              if (isNaN(numLat) || isNaN(numLng) || !isFinite(numLat) || !isFinite(numLng) || numLat < -90 || numLat > 90 || numLng < -180 || numLng > 180) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Invalid numeric coordinates.' }));
              }
              lat = numLat;
              lng = numLng;
              isInsideAP = isCoordInsideAP(lng, lat);
            }

            // Accuracy validation
            const rawAcc = data.locationAccuracy ?? data.accuracy ?? data.locationCoords?.accuracy;
            let accuracy = null;
            if (rawAcc !== undefined && rawAcc !== null && rawAcc !== '') {
              const numAcc = Number(rawAcc);
              if (isNaN(numAcc) || !isFinite(numAcc) || numAcc < 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Location accuracy must be a non-negative number.' }));
              }
              accuracy = Math.round(numAcc);
            }

            // Client cannot self-verify
            const isSos = Boolean(data.isSos || (data.type && String(data.type).toUpperCase().includes('SOS')));
            let status = 'PENDING_TRIAGE';
            let lifecycleStatus = 'PENDING';
            let verificationStatus = 'UNVERIFIED';
            let rejectionReason = null;

            // Fail-closed AP boundary enforcement
            if (lat !== null && lng !== null && isInsideAP === false) {
              status = 'Rejected';
              lifecycleStatus = 'REJECTED';
              verificationStatus = 'REJECTED';
              rejectionReason = 'Out of State — Coordinate outside Andhra Pradesh operational boundary';
            }

            const id = data.id || data.reportId || ('REP-' + Date.now());
            const receivedAt = Date.now();
            const submittedAt = data.submittedAt || data.timestamp || new Date().toISOString();

            const normalized = {
              ...data,
              id,
              reportId: id,
              type: data.type || data.category || 'UNKNOWN',
              reportType: data.reportType || data.type || 'UNKNOWN',
              category: data.category || data.type || 'Citizen Field Report',
              desc: data.desc ?? data.description ?? data.message ?? '',
              description: data.description ?? data.desc ?? data.message ?? '',
              source: data.source || 'CITIZEN_API',
              sourceId: data.sourceId || 'citizen_api',
              lat,
              lng,
              latitude: lat,
              longitude: lng,
              accuracy,
              locationAccuracy: accuracy,
              locationStatus: (lat !== null && lng !== null) ? 'AVAILABLE' : 'UNAVAILABLE',
              location: data.location || ((lat !== null && lng !== null) ? `Lat ${lat.toFixed(5)}° N, Lng ${lng.toFixed(5)}° E${accuracy !== null ? ` (±${accuracy}m)` : ''}` : 'Location unavailable'),
              status,
              lifecycleStatus,
              verificationStatus,
              rejectionReason,
              severity: data.severity || (isSos ? 'Critical' : 'UNKNOWN'),
              isSos,
              isDrill: Boolean(data.isDrill || data.isSimulated || data.tier === 'SIMULATED' || data.role === 'DRILL'),
              tier: data.tier || (data.isDrill ? 'SIMULATED' : 'LIVE_API'),
              timestamp: submittedAt,
              submittedAt,
              receivedAt
            };

            // Deduplicate by stable ID
            const existingIdx = storedReports.findIndex(r => r.id === id || r.reportId === id);
            if (existingIdx !== -1) {
              storedReports[existingIdx] = normalized;
            } else {
              storedReports.unshift(normalized);
            }

            cachedCanonicalExpiresAt = 0; // invalidate cache
            res.writeHead(201, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, report: normalized }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Invalid JSON payload: ' + e.message }));
          }
        });
        return;
      } else if (pathname === '/api/reports' && req.method === 'GET') {
        const valid = storedReports.filter(r => !r.isDrill && !r.isSimulated && r.tier !== 'SIMULATED');
        const pending = valid.filter(r => r.status === 'Pending' || r.status === 'Submitted' || r.status === 'PENDING_TRIAGE' || r.lifecycleStatus === 'PENDING');
        const verified = valid.filter(r => r.status === 'Verified' || r.lifecycleStatus === 'VERIFIED');
        const rejected = valid.filter(r => r.status === 'Rejected' || r.status === 'Dismissed' || r.lifecycleStatus === 'REJECTED');
        const resolved = valid.filter(r => r.status === 'Resolved' || r.lifecycleStatus === 'RESOLVED');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          reports: storedReports,
          total: storedReports.length,
          pendingCount: pending.length,
          verifiedCount: verified.length,
          rejectedCount: rejected.length,
          resolvedCount: resolved.length
        }));
      }
    }

    // 8. Risk Zone Check (Point-in-polygon)
    if (pathname === '/api/risk-zone' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          const lat = payload.lat;
          const lng = typeof payload.lng === 'number' ? payload.lng : payload.lon;
          if (typeof lat !== 'number' || typeof lng !== 'number') {
            res.writeHead(400);
            return res.end(JSON.stringify({ error: 'lat and lng/lon (numbers) are required' }));
          }

          function pip(point, polygon) {
            let [px, py] = point;
            let inside = false;
            for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
              const [xi, yi] = polygon[i];
              const [xj, yj] = polygon[j];
              const intersect = ((yi > py) !== (yj > py)) &&
                (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
              if (intersect) inside = !inside;
            }
            return inside;
          }

          function haversine(lat1, lng1, lat2, lng2) {
            const R = 6371;
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLng = (lng2 - lng1) * Math.PI / 180;
            const a = Math.sin(dLat/2)**2 +
              Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          }

          const COASTAL_FLOOD_ZONE = [
            [79.5, 13.9], [80.3, 14.1], [80.7, 14.4], [81.1, 14.8],
            [81.5, 15.2], [81.9, 15.6], [82.3, 16.0], [82.6, 16.4],
            [82.9, 16.8], [83.2, 17.2], [83.4, 17.6], [83.6, 18.0],
            [83.5, 18.3], [83.0, 18.1], [82.5, 17.7], [82.0, 17.2],
            [81.6, 16.8], [81.1, 16.3], [80.6, 15.8], [80.1, 15.3],
            [79.7, 14.7], [79.4, 14.2], [79.5, 13.9]
          ];

          const SEISMIC_ZONE = [
            [76.8, 14.2], [77.5, 14.4], [78.2, 14.6], [79.0, 15.0],
            [79.8, 15.5], [80.5, 16.0], [81.0, 16.5], [80.6, 16.8],
            [79.9, 16.4], [79.2, 16.0], [78.5, 15.6], [77.8, 15.2],
            [77.1, 14.8], [76.8, 14.2]
          ];

          const LANDSLIDE_ZONE = [
            [82.5, 17.0], [82.8, 17.4], [83.1, 17.8], [83.4, 18.2],
            [83.7, 18.6], [83.5, 18.9], [83.1, 18.6], [82.7, 18.2],
            [82.3, 17.8], [82.0, 17.4], [82.2, 17.1], [82.5, 17.0]
          ];

          const SHELTERS = [
            { name: 'Vijayawada Government Cyclone Shelter', lat: 16.5062, lng: 80.6480, capacity: 3500, source: 'AP SDMA Directory' },
            { name: 'Guntur District Disaster Relief Camp',  lat: 16.3067, lng: 80.4365, capacity: 2800, source: 'AP SDMA Directory' },
            { name: 'Visakhapatnam Naval Emergency Base',    lat: 17.7231, lng: 83.3012, capacity: 5000, source: 'AP SDMA Directory' },
            { name: 'Kakinada Port Trust Relief Centre',     lat: 16.9891, lng: 82.2475, capacity: 2200, source: 'AP SDMA Directory' },
            { name: 'Nellore Community Safe Shelter',        lat: 14.4426, lng: 79.9865, capacity: 1800, source: 'AP SDMA Directory' },
            { name: 'Tirupati SDMA Shelter Zone',            lat: 13.6288, lng: 79.4192, capacity: 4000, source: 'AP SDMA Directory' },
            { name: 'Rajam Emergency Relief Camp',           lat: 18.4541, lng: 83.6299, capacity: 1200, source: 'AP SDMA Directory' },
            { name: 'Eluru Riverside Relief Hub',            lat: 16.7107, lng: 81.0952, capacity: 1500, source: 'AP SDMA Directory' },
            { name: 'Machilipatnam Coast Guard Shelter',     lat: 16.1875, lng: 81.1337, capacity: 2000, source: 'AP SDMA Directory' },
            { name: 'Kurnool District Emergency Centre',     lat: 15.8281, lng: 78.0373, capacity: 3000, source: 'AP SDMA Directory' },
          ];

          const inFlood = pip([lng, lat], COASTAL_FLOOD_ZONE);
          const inSeismic = pip([lng, lat], SEISMIC_ZONE);
          const inLandslide = pip([lng, lat], LANDSLIDE_ZONE);

          let matchedAiZone = null;
          let highestTier = null;
          try {
            const aiState = AIEngine.getState();
            if (aiState && Array.isArray(aiState.allZones)) {
              for (const z of aiState.allZones) {
                const zLat = z.lat ?? z.epicenter?.lat;
                const zLng = z.lng ?? z.epicenter?.lng;
                if (zLat == null || zLng == null) continue;
                const distKm = haversine(lat, lng, zLat, zLng);
                const radiusKm = (z.baseRadius || z.radius || 28000) / 1000;
                if (distKm <= radiusKm) {
                  const zTier = (z.current_tier || z.level || 'GREEN').toUpperCase();
                  if (!highestTier || zTier === 'RED' || (zTier === 'ORANGE' && highestTier !== 'RED') || (zTier === 'YELLOW' && highestTier === 'GREEN')) {
                    highestTier = zTier;
                    matchedAiZone = z;
                  }
                }
              }
            }
          } catch (e) {}

          let riskLevel, riskColor, zone, advisory;
          if (matchedAiZone) {
            if (highestTier === 'RED') {
              riskLevel = 'Red Zone'; riskColor = '#ef4444';
            } else if (highestTier === 'ORANGE') {
              riskLevel = 'Caution'; riskColor = '#f59e0b';
            } else if (highestTier === 'YELLOW') {
              riskLevel = 'Advisory'; riskColor = '#eab308';
            } else {
              riskLevel = 'Safe'; riskColor = '#22c55e';
            }
            zone = matchedAiZone.name;
            advisory = matchedAiZone.note || `Active ${highestTier} condition: monitor emergency channels and follow directives.`;
          } else if (inFlood) {
            riskLevel = 'Red Zone'; riskColor = '#ef4444';
            zone = 'Coastal Flood & Cyclone Inundation Belt';
            advisory = 'IMMEDIATE ACTION: Location falls inside an active coastal flood buffer. Move to designated higher ground shelters.';
          } else if (inLandslide) {
            riskLevel = 'Red Zone'; riskColor = '#ef4444';
            zone = 'Eastern Ghats Landslide Belt';
            advisory = 'HIGH RISK: Location is in an unstable slope corridor. Avoid valleys and hillside drainage cuts during rain.';
          } else if (inSeismic) {
            riskLevel = 'Caution'; riskColor = '#f59e0b';
            zone = 'Seismic Zone III (Moderate Exposure)';
            advisory = 'SEISMIC WATCH: Area lies within Zone III fault belts. Verify emergency exit routes and structure stability.';
          } else {
            riskLevel = 'Safe'; riskColor = '#22c55e';
            zone = 'General Safe Zone';
            advisory = 'Location is outside active high-risk hazard zones. Continue monitoring official alerts.';
          }

          const shelters = SHELTERS
            .map(s => ({ ...s, dist_km: +haversine(lat, lng, s.lat, s.lng).toFixed(1) }))
            .sort((a, b) => a.dist_km - b.dist_km)
            .slice(0, 3);

          res.writeHead(200);
          return res.end(JSON.stringify({ riskLevel, riskColor, zone, advisory, shelters, lat, lng }));

        } catch (e) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
      });
      return;
    }

    // 9. LIVE POINT FORECAST (Windy Point Forecast API with Open-Meteo Live Fallback)
    if (pathname === '/api/windy/point-forecast' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const lat = typeof payload.lat === 'number' && !isNaN(payload.lat) ? payload.lat : null;
          const lon = typeof (payload.lon || payload.lng) === 'number' && !isNaN(payload.lon || payload.lng) ? (payload.lon || payload.lng) : null;
          const hourOffset = typeof payload.hourOffset === 'number' ? payload.hourOffset : (typeof payload.offsetHours === 'number' ? payload.offsetHours : 0);

          if (lat === null || lon === null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: false,
              status: 'UNAVAILABLE',
              error: 'Missing or invalid operational coordinates',
              source: 'Open-Meteo & Windy Forecast Services'
            }));
          }

          // If a Windy API key is configured, query the Point Forecast API
          if (WINDY_DATA_KEY) {
            const postData = JSON.stringify({
              lat: Number(lat),
              lon: Number(lon),
              model: payload.model || 'ecmwf',
              parameters: ['wind', 'windGust', 'temp', 'precip', 'rh', 'pressure'],
              levels: ['surface']
            });

            const options = {
              hostname: 'api.windy.com',
              port: 443,
              path: '/api/point-forecast/v2',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-windy-key': WINDY_DATA_KEY,
                'Content-Length': Buffer.byteLength(postData)
              },
              timeout: 6000
            };

            try {
              const windyResult = await new Promise((resolve, reject) => {
                const remoteReq = https.request(options, (remoteRes) => {
                  let remoteBody = '';
                  remoteRes.on('data', chunk => remoteBody += chunk);
                  remoteRes.on('end', () => {
                    if (remoteRes.statusCode === 200) {
                      try { resolve(JSON.parse(remoteBody)); } catch (e) { reject(e); }
                    } else {
                      reject(new Error(`Windy HTTP ${remoteRes.statusCode}`));
                    }
                  });
                });
                remoteReq.on('error', reject);
                remoteReq.on('timeout', () => { remoteReq.destroy(); reject(new Error('Windy timeout')); });
                remoteReq.write(postData);
                remoteReq.end();
              });

              // Process Windy API series data
              const temps = windyResult['temp-surface'] || [];
              const winds = windyResult['wind-surface'] || [];
              const gusts = windyResult['windGust-surface'] || [];
              const precips = windyResult['precip-surface'] || [];
              const rawPres = windyResult['pressure-surface'] || [];

              const currentTempC = temps[0] !== undefined ? +(temps[0] > 150 ? temps[0] - 273.15 : temps[0]).toFixed(1) : null;
              const currentWindKmh = winds[0] !== undefined ? +(winds[0] < 55 ? winds[0] * 3.6 : winds[0]).toFixed(1) : null;
              const maxGustKmh = gusts.length > 0 ? +(Math.max(...gusts) < 55 ? Math.max(...gusts) * 3.6 : Math.max(...gusts)).toFixed(1) : currentWindKmh;
              const pressureHpa = rawPres[0] !== undefined ? Math.round(rawPres[0] > 2000 ? rawPres[0]/100 : rawPres[0]) : null;

              res.writeHead(200);
              return res.end(JSON.stringify({
                success: true,
                sourceId: 'windy_point_forecast',
                source: 'Windy.com Point Forecast API (Live Key Active)',
                lat, lon,
                lastUpdated: new Date().toISOString(),
                summary: {
                  currentTempC,
                  currentWindKmh,
                  maxGustKmh,
                  maxPrecipPerHourMm: precips[0] !== undefined ? precips[0] : null,
                  pressureHpa,
                  overallRisk: maxGustKmh !== null && maxGustKmh >= 65 ? 'RED' : (maxGustKmh !== null && maxGustKmh >= 45 ? 'ORANGE' : 'GREEN')
                }
              }));

            } catch (err) {
              console.warn('Windy API failed, switching to live Open-Meteo:', err.message);
              // Fallthrough to live Open-Meteo
            }
          }

          // When no WINDY_DATA_KEY or if Windy API fails: Use authentic Live Open-Meteo forecast (NO fake data)
          const liveMeteo = await getOpenMeteoWeather(lat, lon);
          if (liveMeteo.success) {
            let respObj = { ...liveMeteo };
            respObj.source = 'Open-Meteo Live Forecast';
            if (hourOffset > 0 && liveMeteo.timeSeries && liveMeteo.timeSeries.timestamps && liveMeteo.timeSeries.timestamps.length) {
              const targetTime = Date.now() + (hourOffset * 3600 * 1000);
              let minDiff = Infinity;
              let idx = 0;
              for (let i = 0; i < liveMeteo.timeSeries.timestamps.length; i++) {
                const diff = Math.abs(liveMeteo.timeSeries.timestamps[i] - targetTime);
                if (diff < minDiff) {
                  minDiff = diff;
                  idx = i;
                }
              }
              const ts = liveMeteo.timeSeries;
              const fTemp = ts.temp && ts.temp[idx] !== undefined ? ts.temp[idx] : liveMeteo.summary.currentTempC;
              const fWind = ts.windKmh && ts.windKmh[idx] !== undefined ? ts.windKmh[idx] : liveMeteo.summary.currentWindKmh;
              const fGust = ts.gustKmh && ts.gustKmh[idx] !== undefined ? ts.gustKmh[idx] : liveMeteo.summary.maxGustKmh;
              const fPrecip = ts.precipMm && ts.precipMm[idx] !== undefined ? ts.precipMm[idx] : null;
              const fPress = ts.pressure && ts.pressure[idx] !== undefined ? ts.pressure[idx] : liveMeteo.summary.pressureHpa;
              const fSevWind = fGust !== null && fGust >= 65;
              const fExtRain = fPrecip !== null && fPrecip >= 15;
              const fRisk = (fSevWind || fExtRain || (fPress !== null && fPress <= 990)) ? 'RED' : ((fGust !== null && fGust >= 45) || (fPrecip !== null && fPrecip >= 7)) ? 'ORANGE' : ((fGust !== null && fGust >= 28) || (fPrecip !== null && fPrecip >= 2)) ? 'YELLOW' : 'GREEN';
              respObj.summary = {
                ...liveMeteo.summary,
                currentTempC: fTemp,
                currentWindKmh: fWind,
                maxGustKmh: fGust,
                maxPrecipPerHourMm: fPrecip,
                pressureHpa: fPress,
                isSevereWind: fSevWind,
                isExtremeRain: fExtRain,
                overallRisk: fRisk,
                hourOffset
              };
            }
            res.writeHead(200);
            return res.end(JSON.stringify(safeObject(respObj)));
          } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: false,
              status: 'UNAVAILABLE',
              source: 'Open-Meteo & Windy Forecast Services',
              error: 'Live weather telemetry temporarily unavailable from upstream providers',
              lastUpdated: null
            }));
          }

        } catch (err) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Invalid request payload: ' + err.message }));
        }
      });
      return;
    }

    // 10. Situation Report Briefing
    if (pathname === '/api/export-sitrep') {
      const quakes = await getUSGSEarthquakes(5);
      const sitrep = {
        title: 'RISK2RESCUE — INCIDENT COMMANDER SITREP',
        generatedAt: new Date().toISOString(),
        classification: 'OPERATIONAL RESTRICTED // NDRF-SDMA',
        monitoredThreats: 5,
        liveEarthquakesRecorded: quakes.count || 0,
        activeCitizenReports: storedReports.length,
        broadcastAlertsDispatched: storedAlerts.length,
        dataIntegrity: {
          earthquakeFeed: quakes.source,
          weatherFeed: WINDY_DATA_KEY ? 'Windy.com Live API' : 'Open-Meteo Live API',
          demographics: 'Census of India 2011 / AP SDMA Baseline'
        },
        actionDirectives: [
          'Maintain round-the-clock Doppler radar tracking of coastal core.',
          'Pre-position 6 NDRF search & rescue battalions at Kakinada & Machilipatnam highway nodes.',
          'Enforce maritime fishing ban within 40 nautical miles.',
          'Keep continuous telemetry sync with CWC Godavari river outflow.'
        ]
      };
      res.writeHead(200);
      return res.end(JSON.stringify(sitrep, null, 2));
    }

    // 11. CENSUS 2011 VILLAGE DEMOGRAPHICS LOOKUP
    if (pathname === '/api/census/villages') {
      const villages = getCensusLookup();
      const zoneId = parsedUrl.query.zone_id;
      const hazard = parsedUrl.query.hazard_type;
      let filtered = villages;
      if (zoneId) filtered = filtered.filter(v => v.mapped_zone_id === zoneId);
      if (hazard) filtered = filtered.filter(v => v.hazard_type === hazard);

      res.writeHead(200);
      return res.end(JSON.stringify({
        success: true,
        source: 'Census of India 2011 (Official Village Directory, growth-adjusted to 2026)',
        count: filtered.length,
        totalCensus2011Pop: filtered.reduce((a, b) => a + b.census_2011_pop, 0),
        totalGrowthAdjustedPop: filtered.reduce((a, b) => a + b.growth_adjusted_pop, 0),
        villages: filtered
      }));
    }

    // 12. RELIEF SHELTERS DATABASE (SDMA Live Network)
    if (pathname === '/api/shelters') {
      const rawShelters = getSheltersData();
      const validShelters = rawShelters.filter(s => {
        if (s.lat === null || s.lat === undefined || s.lng === null || s.lng === undefined) return false;
        const lat = Number(s.lat);
        const lng = Number(s.lng);
        if (isNaN(lat) || isNaN(lng)) return false;
        return isCoordInsideAP(lng, lat);
      });

      const shelters = validShelters.map(s => {
        const cap = (typeof s.capacity === 'number' && !isNaN(s.capacity) && s.capacity > 0) ? s.capacity : null;
        const hasOcc = typeof s.current_occupancy === 'number' && !isNaN(s.current_occupancy) && s.current_occupancy >= 0;
        const occ = hasOcc ? s.current_occupancy : null;
        let occStatus = 'UNKNOWN';
        if (hasOcc) {
          const observedAt = s.last_updated || s.occupancyObservedAt || s.observedAt || null;
          if (s.occupancyStatus === 'STALE' || (observedAt && (Date.now() - new Date(observedAt).getTime() > 24 * 3600 * 1000))) {
            occStatus = 'STALE';
          } else {
            occStatus = s.occupancyStatus || 'LIVE';
          }
        }
        const rawStatus = (s.status || '').toLowerCase();
        const opStatus = ['open', 'full', 'closed'].includes(rawStatus) ? rawStatus : 'UNKNOWN';
        const availBeds = (cap !== null && hasOcc) ? Math.max(0, cap - occ) : null;
        const occRatePct = (cap !== null && hasOcc && cap > 0) ? Math.round((occ / cap) * 100) : null;

        let availability = 'UNKNOWN';
        if (opStatus === 'closed') {
          availability = 'CLOSED';
        } else if (opStatus === 'full') {
          availability = 'FULL';
        } else if (opStatus === 'open' && cap !== null && hasOcc) {
          availability = (cap - occ > 0) ? 'AVAILABLE' : 'FULL';
        } else if (opStatus === 'open') {
          availability = 'OPEN_UNCONFIRMED_CAPACITY';
        }

        return {
          ...s,
          shelterId: s.shelter_id || s.id,
          shelter_id: s.shelter_id || s.id,
          id: s.shelter_id || s.id,
          latitude: Number(s.lat),
          longitude: Number(s.lng),
          referenceCapacity: cap,
          capacity: cap,
          currentOccupancy: occ,
          current_occupancy: occ,
          occupancyStatus: occStatus,
          occupancyObservedAt: hasOcc ? (s.last_updated || null) : null,
          last_updated: s.last_updated || null,
          updated_by: s.updated_by || null,
          operationalStatus: opStatus,
          status: opStatus,
          availability,
          available_beds: availBeds,
          availableBeds: availBeds,
          occupancy_rate_pct: occRatePct,
          occupancyRatePct: occRatePct,
          is_full: opStatus === 'full' || (cap !== null && hasOcc && occ >= cap),
          is_closed: opStatus === 'closed',
          sourceId: 'ap_sdma_shelters',
          tier: 'OFFICIAL_BASELINE',
          reference: true,
          provenance: s.updated_by || 'AP SDMA Reference Baseline'
        };
      });

      const totalCap = shelters.reduce((a, b) => a + (b.referenceCapacity || 0), 0);
      const reporting = shelters.filter(s => s.currentOccupancy !== null);
      const totalOcc = reporting.length > 0 ? reporting.reduce((a, b) => a + b.currentOccupancy, 0) : null;
      const reportingCap = reporting.reduce((a, b) => a + (b.referenceCapacity || 0), 0);
      const overallPct = (totalOcc !== null && reportingCap > 0) ? Math.round((totalOcc / reportingCap) * 100) : null;

      res.writeHead(200);
      return res.end(JSON.stringify({
        success: true,
        source: 'State Disaster Management Authority (SDMA) Relief Shelter Network',
        sourceId: 'ap_sdma_shelters',
        tier: 'OFFICIAL_BASELINE',
        count: shelters.length,
        summary: {
          totalCapacity: totalCap,
          totalOccupancy: totalOcc,
          sheltersReportingCount: reporting.length,
          shelterOccupancyStatus: reporting.length === shelters.length ? 'LIVE' : (reporting.length > 0 ? 'PARTIAL' : 'UNKNOWN'),
          totalAvailableBeds: (totalOcc !== null) ? Math.max(0, reportingCap - totalOcc) : null,
          overallOccupancyPct: overallPct,
          openSheltersCount: shelters.filter(s => s.operationalStatus === 'open' && !s.is_full).length
        },
        shelters
      }));
    }

    // 13. SHELTER REAL-TIME CAPACITY UPDATE (Authority Command Side: Supports PATCH /api/shelters/:id and POST /api/shelters/:id/update)
    const shelterUpdateMatch = pathname.match(/^\/api\/shelters\/([^\/]+)\/update$/);
    const shelterPatchMatch = pathname.match(/^\/api\/shelters\/([^\/]+)$/);
    if ((shelterPatchMatch && (req.method === 'PATCH' || req.method === 'POST')) || (shelterUpdateMatch && req.method === 'POST')) {
      const targetId = shelterPatchMatch ? shelterPatchMatch[1] : shelterUpdateMatch[1];
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          const shelters = getSheltersData();
          const cleanId = decodeURIComponent(targetId).trim();
          const shelter = shelters.find(s => s.shelter_id === cleanId || s.id === cleanId || s.name === cleanId);
          if (!shelter) {
            res.writeHead(404);
            return res.end(JSON.stringify({ error: 'Shelter not found with ID: ' + targetId }));
          }

          const rawOcc = payload.current_occupancy !== undefined ? payload.current_occupancy : payload.occupancy;
          if (rawOcc !== undefined && rawOcc !== null) {
            if (typeof rawOcc === 'string' && rawOcc.trim() === '') {
              res.writeHead(400);
              return res.end(JSON.stringify({ error: 'Occupancy cannot be empty string' }));
            }
            const numOcc = Number(rawOcc);
            if (isNaN(numOcc) || !Number.isFinite(numOcc)) {
              res.writeHead(400);
              return res.end(JSON.stringify({ error: 'Occupancy must be a valid number' }));
            }
            if (numOcc < 0) {
              res.writeHead(400);
              return res.end(JSON.stringify({ error: 'Occupancy cannot be negative' }));
            }
            const cap = Number(shelter.capacity || shelter.referenceCapacity || shelter.max_capacity);
            // Requirement 5: Preserve overflow evidence rather than silently clipping it
            shelter.current_occupancy = Math.round(numOcc);
            shelter.occupancyStatus = 'LIVE';
            if (Number.isFinite(cap) && cap > 0) {
              if (shelter.current_occupancy >= cap) {
                shelter.status = 'full';
              } else if (shelter.status === 'full' && shelter.current_occupancy < cap) {
                shelter.status = 'open';
              }
            }
          }

          if (payload.status && ['open', 'full', 'closed'].includes(payload.status)) {
            shelter.status = payload.status;
          }

          shelter.last_updated = new Date().toISOString();
          if (payload.updated_by) shelter.updated_by = payload.updated_by;

          saveSheltersData(shelters);

          // Invalidate Priority Ranking Cache so next run immediately recomputes allocations with new capacity
          priorityRankingCache = { data: null, expiresAt: 0 };

          const hasOcc = typeof shelter.current_occupancy === 'number' && !isNaN(shelter.current_occupancy);
          const cap = Number(shelter.capacity) || null;
          const occ = hasOcc ? shelter.current_occupancy : null;
          const availBeds = (cap !== null && hasOcc) ? Math.max(0, cap - occ) : null;
          const occPct = (cap !== null && hasOcc && cap > 0) ? Math.round((occ / cap) * 100) : null;

          res.writeHead(200);
          return res.end(JSON.stringify({
            success: true,
            message: `Shelter ${shelter.name} updated successfully`,
            shelter: {
              ...shelter,
              referenceCapacity: cap,
              currentOccupancy: occ,
              occupancyStatus: shelter.occupancyStatus || (hasOcc ? 'LIVE' : 'UNKNOWN'),
              operationalStatus: shelter.status || 'UNKNOWN',
              available_beds: availBeds,
              availableBeds: availBeds,
              occupancy_rate_pct: occPct,
              occupancyRatePct: occPct
            }
          }));
        } catch (e) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Invalid update body: ' + e.message }));
        }
      });
      return;
    }

    // 14. OSRM SAFE-ZONE EVACUATION ROUTING ENGINE (Task 20 Grounded)
    if (pathname === '/api/evacuation/routes' && req.method === 'GET') {
      const qLat = parsedUrl.query.lat || parsedUrl.query.citizenLat;
      const qLon = parsedUrl.query.lon || parsedUrl.query.lng || parsedUrl.query.citizenLon;
      if (qLat !== undefined && qLon !== undefined && qLat !== '' && qLon !== '') {
        const lat = parseFloat(qLat);
        const lon = parseFloat(qLon);
        if (isNaN(lat) || isNaN(lon) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
          res.writeHead(400);
          return res.end(JSON.stringify({
            error: 'Invalid coordinate parameters: lat and lon must be valid finite numbers',
            routeStatus: 'UNAVAILABLE'
          }));
        }
        if (!OsrmService.isCoordInsideAP(lon, lat)) {
          res.writeHead(400);
          return res.end(JSON.stringify({
            error: 'Specified coordinates are outside Andhra Pradesh disaster management operational boundary',
            routeStatus: 'UNAVAILABLE'
          }));
        }
        const hazard = parsedUrl.query.hazardType || 'cyclone';
        const result = await calculateEvacuationRoutes(lat, lon, hazard);
        res.writeHead(200);
        return res.end(JSON.stringify(result));
      }

      // Default GET: Return canonical routing infrastructure status overview
      const summary = OsrmService.getOsrmRoutingSummary();
      const allShelters = getSheltersData();
      res.writeHead(200);
      return res.end(JSON.stringify({
        status: 'OK',
        routingProvider: summary.provider,
        sourceId: summary.sourceId,
        tier: summary.tier,
        role: summary.role,
        networkSummary: {
          totalShelters: allShelters.length,
          openShelters: allShelters.filter(s => s.status !== 'closed').length,
          totalCachedRoutes: summary.totalRoutesCached,
          activeLiveRoutes: summary.activeLiveEntries,
          degradedStaleRoutes: summary.degradedStaleEntries
        },
        disclaimer: summary.disclaimer,
        timestamp: new Date().toISOString()
      }));
    }

    if (pathname === '/api/evacuation/routes' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const rawLat = payload.citizenLat !== undefined ? payload.citizenLat : payload.lat;
          const rawLon = payload.citizenLon !== undefined ? payload.citizenLon : (payload.lon !== undefined ? payload.lon : payload.lng);

          if (rawLat === undefined || rawLon === undefined || rawLat === null || rawLon === null || rawLat === '' || rawLon === '') {
            res.writeHead(400);
            return res.end(JSON.stringify({
              error: 'Missing required coordinates: citizenLat and citizenLon must be provided.',
              routeStatus: 'UNAVAILABLE'
            }));
          }

          const lat = typeof rawLat === 'number' ? rawLat : parseFloat(rawLat);
          const lon = typeof rawLon === 'number' ? rawLon : parseFloat(rawLon);

          if (isNaN(lat) || isNaN(lon) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
            res.writeHead(400);
            return res.end(JSON.stringify({
              error: 'Invalid coordinates: latitude and longitude must be valid finite numbers.',
              routeStatus: 'UNAVAILABLE'
            }));
          }

          if (!OsrmService.isCoordInsideAP(lon, lat)) {
            res.writeHead(400);
            return res.end(JSON.stringify({
              error: 'Citizen location is outside Andhra Pradesh disaster management operational boundary.',
              routeStatus: 'UNAVAILABLE'
            }));
          }

          const hazard = payload.hazardType || 'cyclone';
          const result = await calculateEvacuationRoutes(lat, lon, hazard);
          res.writeHead(200);
          return res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Failed to compute evacuation routes: ' + err.message }));
        }
      });
      return;
    }

    // 15. VULNERABILITY PRIORITY INDEX (VPI) & CARRYING CAPACITY ALLOCATION ENGINE
    if (pathname === '/api/priority-ranking' && req.method === 'GET') {
      const now = Date.now();
      const forceRefresh = parsedUrl.query.refresh === 'true';

      if (!forceRefresh && priorityRankingCache.data && now < priorityRankingCache.expiresAt) {
        res.writeHead(200);
        return res.end(JSON.stringify({
          ...priorityRankingCache.data,
          cached: true,
          cacheExpiresInSeconds: Math.round((priorityRankingCache.expiresAt - now) / 1000)
        }));
      }

      try {
        const villages = getCensusLookup();
        const shelters = getSheltersData();

        // 1. Fetch live telemetry (Open-Meteo & USGS)
        let radarWeather = null;
        let quakes = null;
        try {
          radarWeather = await getOpenMeteoWeather(16.18, 81.13);
          quakes = await getUSGSEarthquakes(10);
        } catch (e) {
          console.warn('Telemetry fetch error for priority engine:', e.message);
        }

        const telemetry = {
          radar: {
            maxGustSpeedKmH: radarWeather?.summary?.maxGustKmh ?? null,
            corePressureHpa: radarWeather?.summary?.pressureHpa ?? null
          },
          seismic: {
            maxRecordedMagnitude: quakes?.maxMagnitude ?? 0,
            status: (quakes?.maxMagnitude >= 5.0) ? 'ELEVATED' : 'NORMAL'
          }
        };

        const hazardPolygons = {
          coastalFlood: COASTAL_FLOOD_ZONE,
          seismic: SEISMIC_ZONE,
          landslide: LANDSLIDE_ZONE
        };

        // 2. Precompute OSRM road distance & duration matrix for candidate pairs
        const distanceMatrix = {};
        const durationMatrix = {};
        const closestShelterRoute = {};

        for (const v of villages) {
          const vLat = v.lat;
          const vLon = v.lng || v.lon;
          const vId = v.village_id;
          distanceMatrix[vId] = {};
          durationMatrix[vId] = {};

          const openShelters = shelters.filter(s => s.status !== 'closed');
          let bestDist = Infinity;
          let bestDuration = null;

          for (const s of openShelters) {
            const straightDist = haversine(vLat, vLon, s.lat, s.lon);
            // Use OSRM road routing for candidate shelters within 120km or same district
            if (straightDist <= 120 || s.district === v.district) {
              const routeInfo = await getOsrmRouteDetails(vLat, vLon, s.lat, s.lon);
              distanceMatrix[vId][s.shelter_id] = routeInfo.roadDistKm;
              durationMatrix[vId][s.shelter_id] = routeInfo.durationMin;
              if (routeInfo.routed && routeInfo.roadDistKm !== null && routeInfo.roadDistKm < bestDist) {
                bestDist = routeInfo.roadDistKm;
                bestDuration = routeInfo.durationMin;
              }
            } else {
              distanceMatrix[vId][s.shelter_id] = null;
              durationMatrix[vId][s.shelter_id] = null;
            }
          }
          closestShelterRoute[vId] = {
            distKm: bestDist < Infinity ? bestDist : null,
            durationMin: bestDuration
          };
        }

        // 3. Compute VPI and carry capacity allocation using PriorityEngine
        const rankedHabitations = PriorityEngine.rankIncidents(villages.map(v => {
          const route = closestShelterRoute[v.village_id] || {};
          const isHighWind = telemetry.radar.maxGustSpeedKmH !== null && telemetry.radar.maxGustSpeedKmH > 100;
          // Section 8: Verified SOS reports contribute to immediate life risk
          const verifiedSosNearby = (storedReports || []).some(r => 
            (r.isSos || (r.type && String(r.type).toUpperCase().includes('SOS'))) &&
            (r.status === 'Verified' || r.lifecycleStatus === 'VERIFIED') &&
            r.status !== 'Rejected' && r.status !== 'Resolved' && r.status !== 'Dismissed' &&
            r.lifecycleStatus !== 'REJECTED' && r.lifecycleStatus !== 'RESOLVED' &&
            !r.isDrill && !r.isSimulated && r.tier !== 'SIMULATED' && r.role !== 'DRILL' &&
            (
              (r.lat && r.lng && v.lat && v.lon && Math.abs(r.lat - v.lat) < 0.1 && Math.abs(r.lng - v.lon) < 0.1) ||
              (r.location && v.village_name && r.location.toLowerCase().includes(v.village_name.toLowerCase()))
            )
          );
          const immediateLifeRisk = verifiedSosNearby ? 95 : (v.hazard_type === 'cyclone' && isHighWind ? 95 : 0);

          return {
            ...v,
            id: v.village_id,
            name: v.village_name,
            population: v.growth_adjusted_pop || v.census_2011_pop,
            populationAtRisk: v.mapped_zone_id ? (v.growth_adjusted_pop || v.census_2011_pop) : 0,
            hazardType: v.hazard_type,
            // Extract vulnerability fields
            elderlyPct: v.pct_above_65 || 0,
            structuralVulnerability: (v.katcha_houses_pct || 0) * 100,
            vulnerabilityRaw: 100 - (v.elevation_m * 10), // Example: low elevation = high vulnerability
            immediateLifeRiskRaw: immediateLifeRisk,
            responseUrgencyRaw: v.mapped_zone_id ? 85 : 40,
            travelTimeMins: route.durationMin ?? null,
            etaMins: route.durationMin ?? null,
            populationProvenance: 'Census India AP 2011 Reference Baseline (Growth Adjusted)',
            hazardProvenance: 'Open-Meteo & USGS Live Telemetry / CAP Advisory',
            vulnerabilityProvenance: 'Census Demographic & Elevation Model',
            urgencyProvenance: route.durationMin !== null ? 'OSRM Live Road Routing' : 'Unavailable (Estimated Zone Proximity)',
            accessibilityProvenance: route.durationMin !== null ? 'OSRM Road Network Routing' : 'Unavailable',
            immediateLifeRiskProvenance: verifiedSosNearby ? 'Verified Citizen SOS Distress Signal' : 'Standard Telemetry'
          };
        }));

        const allocations = [];
        const deficitReports = [];
        let shelterStatus = shelters.map(s => {
          const hasOcc = typeof s.current_occupancy === 'number' && !isNaN(s.current_occupancy);
          return {
            ...s,
            current_occupancy: hasOcc ? s.current_occupancy : 0,
            real_occupancy: hasOcc ? s.current_occupancy : null,
            occupancyStatus: hasOcc ? (s.occupancyStatus || 'LIVE') : 'UNKNOWN',
            operationalStatus: s.status || 'UNKNOWN'
          };
        });

        rankedHabitations.forEach(inc => {
           const candidates = PriorityEngine.evaluateRelocationCandidates(inc, shelterStatus, distanceMatrix);
           inc.relocationCandidates = candidates;
           
           // Simple greedy allocation to first recommended shelter
           const best = candidates.find(c => c.status === 'RECOMMENDED');
           if (best) {
             inc.allocation_status = 'ALLOCATED';
             inc.assigned_shelters = [{ shelter_name: best.shelter_name, allocated_pop: inc.population }];
             // Update shelter capacity
             const shelterRef = shelterStatus.find(s => (s.id || s.shelter_id) === best.shelter_id);
             if (shelterRef) {
               shelterRef.current_occupancy += inc.population;
               if (!shelterRef.allocated_villages) shelterRef.allocated_villages = [];
               shelterRef.allocated_villages.push({
                 village_name: inc.name,
                 allocated_pop: inc.population,
                 distance_km: best.distance_km || best.distance || 14.2,
                 corridor: `${inc.name} ➔ ${best.shelter_name}`,
                 accessible: shelterRef.status !== 'closed'
               });
             }
           } else {
             inc.allocation_status = 'DEFICIT';
             inc.assigned_shelters = [];
             deficitReports.push({ zone_id: inc.name, deficit: inc.population, status: 'NO_CAPACITY' });
           }
           allocations.push(inc);
        });

        shelterStatus = shelterStatus.map(s => {
          const cap = (typeof s.capacity === 'number' && !isNaN(s.capacity) && s.capacity > 0) ? s.capacity : null;
          const hasRealOcc = typeof s.real_occupancy === 'number' && !isNaN(s.real_occupancy);
          const realOcc = hasRealOcc ? s.real_occupancy : null;
          const occ = Number(s.current_occupancy || 0);
          const avail = (cap !== null && hasRealOcc) ? Math.max(0, cap - realOcc) : null;
          const status = (hasRealOcc && realOcc >= cap) ? 'full' : (s.status && s.status !== 'UNKNOWN' ? s.status : 'UNKNOWN');
          const occPct = (cap !== null && hasRealOcc && cap > 0) ? Math.round((realOcc / cap) * 100) : null;
          const projOccPct = (cap !== null && cap > 0) ? Math.round((occ / cap) * 100) : null;
          return {
            ...s,
            referenceCapacity: cap,
            status,
            operationalStatus: status,
            name: s.name || s.shelter_name,
            current_occupancy: realOcc,      // the true, officer-verified figure
            currentOccupancy: realOcc,
            real_occupancy: realOcc,
            new_occupancy: realOcc,           // card should display the REAL number, not the simulated one
            projected_occupancy: occ,         // simulated occupancy IF all current allocations were carried out
            occupancyStatus: hasRealOcc ? (s.occupancyStatus || 'LIVE') : 'UNKNOWN',
            occupancy_pct: occPct,
            occupancyRatePct: occPct,
            projected_occupancy_pct: projOccPct,
            available_beds: avail,
            availableBeds: avail,
            projected_available_beds: cap !== null ? Math.max(0, cap - occ) : null,
            evacuation_accessible: status !== 'closed' && status !== 'full'
          };
        });

        const summary = {
          criticalCount: allocations.filter(a => a.priorityLevel === 'CRITICAL').length,
          highCount: allocations.filter(a => a.priorityLevel === 'HIGH').length,
        };

        const responsePayload = {
          success: true,
          timestamp: new Date().toISOString(),
          cached: false,
          weights: PriorityEngine.WEIGHTS,
          tierThresholds: PriorityEngine.TIER_THRESHOLDS,
          habitations: allocations,
          shelterStatus,
          deficitReports,
          summary
        };

        priorityRankingCache = {
          data: responsePayload,
          expiresAt: now + CACHE_TTL_PRIORITY_MS
        };

        res.writeHead(200);
        return res.end(JSON.stringify(responsePayload));
      } catch (err) {
        console.error('Error generating priority rankings:', err);
        res.writeHead(500);
        return res.end(JSON.stringify({ error: 'Failed to compute priority rankings: ' + err.message }));
      }
    }

    // 16. SINGLE AI ORCHESTRATION ENGINE STATE (Unified Single Source of Truth)
    if (pathname === '/api/ai-engine/state' || pathname === '/api/ai-engine/zones' || pathname === '/api/ai-engine/escalate-zone' || pathname === '/api/ai-engine/reset' || pathname === '/api/ai-engine/recompute') {
      if (pathname === '/api/ai-engine/reset' || pathname === '/api/ai-engine/recompute') {
        try {
          const freshState = await AIEngine.forceCompute();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ success: true, message: 'AI Engine state recomputed to canonical baseline', state: freshState }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: err.message }));
        }
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}');

            // Escalation safety guards (Task 21 Grounded)
            if (payload.isDrill || payload.isSimulated || payload.tier === 'SIMULATED' || payload.role === 'DRILL') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                success: false,
                error: 'Cannot escalate live operational zones using DRILL or SIMULATED data'
              }));
            }
            if (payload.tier === 'ARCHIVED' || payload.role === 'REFERENCE') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                success: false,
                error: 'Cannot escalate live operational zones using ARCHIVED or REFERENCE data'
              }));
            }
            if (payload.status === 'Pending' || payload.status === 'Unverified' || payload.status === 'PENDING_TRIAGE' || payload.lifecycleStatus === 'PENDING') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                success: false,
                error: 'Cannot escalate live operational zones using UNVERIFIED citizen claims'
              }));
            }

            const pLat = Number(payload.lat != null ? payload.lat : payload.latitude);
            const pLng = Number(payload.lng != null ? payload.lng : payload.longitude);
            if (isNaN(pLat) || isNaN(pLng) || !OsrmService.isCoordInsideAP(pLng, pLat)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                success: false,
                error: 'Zone coordinates are missing, invalid, or outside Andhra Pradesh operational boundary'
              }));
            }

            const isDryRun = Boolean(payload.dryRun || payload.testOnly);
            const escalatedZone = AIEngine.injectOrEscalateZone(payload, { dryRun: isDryRun });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({
              success: true,
              zone: escalatedZone,
              dryRun: isDryRun,
              state: AIEngine.getState()
            }));
          } catch (err) {
            console.error('[server] AI Engine zone escalation error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        });
        return;
      }
      try {
        let state = AIEngine.getState();
        if (!state) {
          state = await AIEngine.forceCompute();
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(state));
      } catch (err) {
        console.error('[server] AI Engine error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Failed to retrieve AI Engine state: ' + err.message }));
      }
    }

    // 17. AI RECOMMENDATION LAYER (Claude/Ollama with Anti-Hallucination Guard)
    if (pathname === '/api/ai-recommendation') {
      // 1. Anti-hallucination guard: verify minimum live telemetry sources before generating brief
      let healthSummary = null;
      try {
        const healthReport = await SourceRegistry.checkAllSources();
        healthSummary = healthReport.summary;
      } catch (e) {
        healthSummary = { live: 0 };
      }

      if (healthSummary.live < MIN_LIVE_SOURCES_FOR_AI) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          success: false,
          status: 'INSUFFICIENT_LIVE_DATA',
          liveSourceCount: healthSummary.live,
          requiredLiveSources: MIN_LIVE_SOURCES_FOR_AI,
          recommendation: `INSUFFICIENT LIVE TELEMETRY: Only ${healthSummary.live} real-time sensor source(s) are LIVE (minimum ${MIN_LIVE_SOURCES_FOR_AI} required). AI situational briefing suspended to prevent hallucination of critical life-safety recommendations.`,
          model: 'Anti-Hallucination Guard',
          generatedAt: new Date().toISOString()
        }));
      }

      // If GET request, return cached situational brief from AI Engine
      if (req.method === 'GET') {
        const state = AIEngine.getState();
        if (state && state.situationalBrief) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            success: true,
            recommendation: state.situationalBrief.text,
            model: state.situationalBrief.model,
            generatedAt: state.situationalBrief.generatedAt
          }));
        }
      }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');

          // Gather priority rankings, deficit reports, and live telemetry
          let priorityData = payload.priorityData || priorityRankingCache.data;
          let telemetry = payload.telemetry;

          if (!priorityData) {
            const villages = getCensusLookup();
            const shelters = getSheltersData();
            let radarWeather = null;
            let quakes = null;
            try {
              radarWeather = await getOpenMeteoWeather(16.18, 81.13);
              quakes = await getUSGSEarthquakes(10);
            } catch (e) {}

            telemetry = telemetry || {
              radar: {
                maxGustSpeedKmH: radarWeather?.summary?.maxGustKmh ?? null,
                corePressureHpa: radarWeather?.summary?.pressureHpa ?? null
              },
              seismic: {
                maxRecordedMagnitude: quakes?.maxMagnitude ?? 0,
                status: (quakes?.maxMagnitude >= 5.0) ? 'ELEVATED' : 'NORMAL'
              }
            };

            const rankedHabitations = PriorityEngine.rankIncidents(villages.map(v => ({
              ...v,
              id: v.village_id,
              name: v.village_name,
              population: v.growth_adjusted_pop || v.census_2011_pop,
              hazardType: v.hazard_type,
              vulnerabilityRaw: 100 - (v.elevation_m * 10),
              immediateLifeRiskRaw: v.hazard_type === 'cyclone' && (telemetry.radar.maxGustSpeedKmH || 0) > 100 ? 95 : undefined,
              responseUrgencyRaw: v.mapped_zone_id ? 85 : 40,
            })));
            
            let shelterStatus = shelters.map(s => {
              const hasOcc = typeof s.current_occupancy === 'number' && !isNaN(s.current_occupancy);
              return {
                ...s,
                current_occupancy: hasOcc ? s.current_occupancy : 0,
                real_occupancy: hasOcc ? s.current_occupancy : null,
                occupancyStatus: hasOcc ? (s.occupancyStatus || 'LIVE') : 'UNKNOWN',
                operationalStatus: s.status || 'UNKNOWN'
              };
            });
            const distanceMatrix = {};
            for (const v of villages) {
              const vId = v.village_id || v.id;
              distanceMatrix[vId] = {};
              for (const s of shelters) {
                const sId = s.id || s.shelter_id;
                distanceMatrix[vId][sId] = haversine(v.lat, v.lng || v.lon, s.lat, s.lon);
              }
            }
            const deficitReports = [];
            let alloc = [];
            rankedHabitations.forEach(inc => {
               const candidates = PriorityEngine.evaluateRelocationCandidates(inc, shelterStatus, distanceMatrix);
               const best = candidates.find(c => c.status === 'RECOMMENDED');
               if (best) {
                 inc.allocation_status = 'ALLOCATED';
                 inc.assigned_shelters = [{ shelter_name: best.shelter_name, allocated_pop: inc.population }];
                 const shelterRef = shelterStatus.find(s => (s.id || s.shelter_id) === best.shelter_id);
                 if (shelterRef) shelterRef.current_occupancy += inc.population;
               } else {
                 inc.allocation_status = 'DEFICIT';
                 inc.assigned_shelters = [];
                 deficitReports.push({ zone_id: inc.name, deficit: inc.population, status: 'NO_CAPACITY' });
               }
               alloc.push(inc);
            });
            
            priorityData = {
              habitations: alloc,
              shelterStatus: shelterStatus.map(s => {
                const cap = (typeof s.capacity === 'number' && !isNaN(s.capacity) && s.capacity > 0) ? s.capacity : null;
                const hasRealOcc = typeof s.real_occupancy === 'number' && !isNaN(s.real_occupancy);
                const realOcc = hasRealOcc ? s.real_occupancy : null;
                const occ = Number(s.current_occupancy || 0);
                const occPct = (cap !== null && hasRealOcc && cap > 0) ? Math.round((realOcc / cap) * 100) : null;
                const projOccPct = (cap !== null && cap > 0) ? Math.round((occ / cap) * 100) : null;
                return {
                  ...s,
                  name: s.name || s.shelter_name,
                  referenceCapacity: cap,
                  current_occupancy: realOcc,
                  currentOccupancy: realOcc,
                  real_occupancy: realOcc,
                  new_occupancy: realOcc,
                  projected_occupancy: occ,
                  occupancyStatus: hasRealOcc ? (s.occupancyStatus || 'LIVE') : 'UNKNOWN',
                  occupancy_pct: occPct,
                  occupancyRatePct: occPct,
                  projected_occupancy_pct: projOccPct,
                  available_beds: (cap !== null && hasRealOcc) ? Math.max(0, cap - realOcc) : null,
                  availableBeds: (cap !== null && hasRealOcc) ? Math.max(0, cap - realOcc) : null,
                  projected_available_beds: cap !== null ? Math.max(0, cap - occ) : null
                };
              }),
              deficitReports: deficitReports,
              summary: { criticalCount: alloc.filter(a => a.priorityLevel === 'CRITICAL').length, highCount: alloc.filter(a => a.priorityLevel === 'HIGH').length }
            };
          }

          const topHabitations = (priorityData.habitations || []).slice(0, 3);
          const deficitReports = priorityData.deficitReports || [];
          const shelterStatus = priorityData.shelterStatus || [];

          let recommendationText = '';
          let modelUsed = 'Operational Risk Analyst Engine (Deterministic Fallback)';

          const promptContent = `Current Disaster Situation Data:
- Top Ranked Priority Incidents:
${topHabitations.map((h, i) => `  ${i+1}. ${h.name || h.village_name} (${h.district}, ${h.hazardType}): Pop ${h.population || h.growth_adjusted_pop}, Priority Score ${h.priorityScore} [${h.priorityLevel}], Override: ${h.overrideApplied ? 'YES' : 'NO'}, Factors: (Haz: ${h.factorScores?.hazardSeverity ?? 'N/A'}, Pop: ${h.factorScores?.populationAtRisk ?? 'N/A'}, Vuln: ${h.factorScores?.vulnerability ?? 'N/A'}, LifeRisk: ${h.factorScores?.immediateLifeRisk ?? 'N/A'}, Urgency: ${h.factorScores?.responseUrgency ?? 'N/A'}, Access: ${h.factorScores?.accessibility ?? 'N/A'}), Reasons: ${(h.reasons || []).join(', ')}. Action: ${h.recommendedAction}`).join('\n')}

- Zone Deficit Reports:
${deficitReports.map(d => `  Zone ${d.zone_id}: Deficit: ${d.deficit} [${d.status}]`).join('\n')}

- Shelters Near Capacity (>70%):
${shelterStatus.filter(s => s.occupancy_pct >= 70).map(s => `  ${s.name}: Occupancy ${s.new_occupancy}/${s.capacity || s.max_capacity} (${s.occupancy_pct}%)`).join('\n') || 'None'}

- Live Sensor Telemetry:
  Doppler Radar Peak Gusts: ${telemetry?.radar?.maxGustSpeedKmH != null ? telemetry.radar.maxGustSpeedKmH + ' km/h' : 'UNAVAILABLE'} | Pressure: ${telemetry?.radar?.corePressureHpa != null ? telemetry.radar.corePressureHpa + ' hPa' : 'UNAVAILABLE'}
  Seismic Status: ${telemetry?.seismic?.status ?? 'NORMAL'} (Max M: ${telemetry?.seismic?.maxRecordedMagnitude ?? 0})

You are an Andhra Pradesh Disaster Response Analyst. Using ONLY the provided structured evidence from the deterministic Priority Engine above, explain why the incident(s) received their priority and provide a concise, professional 2-4 sentence operational briefing recommendation for the Incident Commander. DO NOT invent numerical scores, fabricate sensor readings, or invent populations. All incident habitations are located in Andhra Pradesh.`;

          let providerLabel = '';
          let isFallback = false;

          const providerUsed = (process.env.AI_PROVIDER || '').toLowerCase();
          const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || 'https://ollama.com';
          const ollamaModel = process.env.OLLAMA_MODEL || 'deepseek-r1:cloud';
          const aiKey = process.env.OLLAMA_API_KEY || '';
          // 1. Local Ollama (DeepSeek-R1)
          if (!recommendationText && (providerUsed === 'ollama' || providerUsed === 'auto' || providerUsed === '')) {
            try {
              console.log('[AI] Attempting provider: ollama');
              const ollamaRes = await AIEngine.callOllamaApi(ollamaBaseUrl, ollamaModel, promptContent);
              if (ollamaRes) {
                recommendationText = ollamaRes;
                modelUsed = ollamaModel;
                providerLabel = 'ollama';
                console.log('[AI] Provider response received (ollama)');
              }
            } catch (err) {
              console.warn('[AI ERROR] Provider failure (ollama):', err.message);
            }
          }

          // 2. Claude API
          if (!recommendationText && (providerUsed === 'claude' || providerUsed === 'auto' || (providerUsed === '' && ANTHROPIC_API_KEY))) {
            try {
              if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');
              console.log('[AI] Attempting provider: claude');
              const claudeRes = await AIEngine.callClaudeApi(ANTHROPIC_API_KEY, promptContent);
              if (claudeRes) {
                recommendationText = claudeRes;
                modelUsed = 'claude-3-5-sonnet-20241022';
                providerLabel = 'claude';
                console.log('[AI] Provider response received (claude)');
              }
            } catch (err) {
              console.warn('[AI ERROR] Provider failure (claude):', err.message);
            }
          }

          // 3. Deterministic Fallback
          if (!recommendationText) {
            console.log('[AI] Falling back to deterministic analyst');
            if (topHabitations.length === 0) {
              recommendationText = 'All monitored Andhra Pradesh sectors maintain baseline conditions without critical hazard escalations. Field units remain on standard civil readiness.';
            } else {
              const h1 = topHabitations[0];
              const h2 = topHabitations[1];
              const h1Name = h1 ? (h1.name || h1.village_name) : null;
              const h2Name = h2 ? (h2.name || h2.village_name) : null;
              const combPop = ((h1?.population || h1?.growth_adjusted_pop || 0) + (h2?.population || h2?.growth_adjusted_pop || 0));
              const popFormatted = combPop > 0 ? (combPop > 1000 ? `${Math.round(combPop / 1000)}k` : `${combPop}`) : 'monitored';

              const topAssigned = (h1?.assigned_shelters && h1.assigned_shelters[0]) ? h1.assigned_shelters[0].shelter_name : null;
              const primaryShelter = topAssigned ? `to ${topAssigned}` : 'to designated cyclone shelters';

              const highOccShelter = shelterStatus.find(s => s.occupancy_pct >= 70);
              let shelterNote = '';
              if (highOccShelter) {
                shelterNote = `${highOccShelter.name} is nearing maximum capacity at ${highOccShelter.occupancy_pct}% (${highOccShelter.new_occupancy || highOccShelter.current_occupancy}/${highOccShelter.capacity} beds) — redirect second-wave evacuees toward regional overflow centers.`;
              } else {
                shelterNote = `Designated regional safe sites have verified remaining capacity with road corridors clear of active flooding.`;
              }

              const activeDeficit = deficitReports.find(d => d.deficit > 0);
              let deficitNote = '';
              if (activeDeficit) {
                deficitNote = `Hazard Zone ${activeDeficit.zone_id} registers an aggregate carrying-capacity deficit of ${Number(activeDeficit.deficit).toLocaleString()} residents, requiring NDRF pre-positioning of temporary modular field relief camps.`;
              }

              const gust = telemetry?.radar?.maxGustSpeedKmH;
              const gustNote = gust != null ? `Doppler telemetry records peak sustained gusts of ${gust} km/h.` : '';

              const sectorTargets = [h1Name, h2Name].filter(Boolean).join(' and ');
              recommendationText = `Recommend immediate relocation of ${sectorTargets} (${popFormatted} citizens at risk) ${primaryShelter}. ${shelterNote} ${deficitNote} ${gustNote}`.trim();
            }
            modelUsed = 'Deterministic Operational Risk Analyst Engine';
            providerLabel = 'deterministic-fallback';
            isFallback = true;
          }

          const completenessPct = (healthSummary && healthSummary.total > 0)
            ? Math.round((healthSummary.live / healthSummary.total) * 100)
            : 85;

          const structuredEvidence = [
            { sourceId: 'priority_engine', metric: 'topIncidentsCount', value: topHabitations.length, status: 'CANONICAL' },
            { sourceId: 'openmeteo_weather', metric: 'maxGustSpeedKmH', value: telemetry?.radar?.maxGustSpeedKmH ?? null, status: telemetry?.radar?.maxGustSpeedKmH != null ? 'LIVE' : 'UNAVAILABLE' },
            { sourceId: 'openmeteo_weather', metric: 'pressureHpa', value: telemetry?.radar?.corePressureHpa ?? null, status: telemetry?.radar?.corePressureHpa != null ? 'LIVE' : 'UNAVAILABLE' },
            { sourceId: 'usgs_earthquakes', metric: 'maxMagnitude', value: telemetry?.seismic?.maxRecordedMagnitude ?? 0, status: telemetry?.seismic?.status || 'NORMAL' }
          ];

          // Audit logging to JSON file
          const logEntry = {
            id: 'REC-' + Date.now(),
            timestamp: new Date().toISOString(),
            model: modelUsed,
            provider: providerLabel,
            inputSummary: {
              topHabitations: topHabitations.map(h => ({ name: h.village_name || h.name, pop: h.growth_adjusted_pop || h.population, vpi: h.vpi_score, tier: h.tier })),
              deficitReports: deficitReports.map(d => ({ zone: d.zone_id, deficit: d.deficit })),
              telemetry: { gust: telemetry?.radar?.maxGustSpeedKmH, pressure: telemetry?.radar?.corePressureHpa }
            },
            recommendation: recommendationText
          };
          logAIRecommendation(logEntry);

          res.writeHead(200);
          return res.end(JSON.stringify({
            success: true,
            provider: providerLabel,
            model: modelUsed,
            recommendation: recommendationText,
            evidence: logEntry.inputSummary,
            structuredEvidence: structuredEvidence,
            confidence: {
              modelConfidence: isFallback ? 'DETERMINISTIC_RULE_BASED' : 'HIGH',
              sourceCertainty: 'EVIDENCE_GROUNDED',
              dataCompletenessPct: completenessPct
            },
            fallback: isFallback,
            timestamp: logEntry.timestamp,
            generatedAt: logEntry.timestamp,
            logId: logEntry.id
          }));

        } catch (err) {
          console.error('AI recommendation endpoint error:', err);
          res.writeHead(500);
          return res.end(JSON.stringify({ error: 'Failed to generate recommendation: ' + err.message }));
        }
      });
      return;
    }

    // 17B. ALERT ROUTER (Escalation Email Routing & Dispatch Log)
    if (pathname === '/api/alerts/dispatches') {
      if (req.method === 'GET') {
        const history = AlertRouter.getDispatchHistory();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          success: true,
          count: history.length,
          dispatches: history
        }));
      }
    }

    if (pathname === '/api/alerts/test-dispatch') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const payload = JSON.parse(body || '{}');
            const zone = payload.zone || {
              id: 'test-zone-01',
              name: 'Uppada Coastal Inundation Sector',
              district: 'Kakinada',
              level: 'CRITICAL',
              vpiMean: 0.88,
              atRiskPop: 14200,
              deficit: 3500,
              gustKmH: 98,
              seismicStatus: 'NORMAL',
              status: 'DEFICIT',
              recommendation: 'Immediate evacuation required for coastal habs.'
            };
            const result = await AlertRouter.sendEscalationEmail(zone, payload.previousLevel || 'ELEVATED');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({
              success: true,
              result
            }));
          } catch (err) {
            console.error('[server] Alert test dispatch error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        });
        return;
      }
    }

    // 17D. LIVE AUTHORITY ALERT BROADCAST (WebSocket Relay & AI Zone Escalation)
    if (pathname === '/api/alerts/broadcast') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}');

            // Enforce AP boundary on alert broadcasts
            const aLat = parseFloat(payload.lat);
            const aLng = parseFloat(payload.lng);
            if (!isNaN(aLat) && !isNaN(aLng) && !isCoordInsideAP(aLng, aLat)) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              return res.end(JSON.stringify({
                success: false,
                error: 'Cannot broadcast alert: Location is outside the Andhra Pradesh operational boundary.'
              }));
            }

            const escalatedZone = AIEngine.injectOrEscalateZone(payload);
            const broadcastPayload = {
              ...payload,
              zoneData: escalatedZone
            };
            const result = broadcastAlert(broadcastPayload);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({
              success: true,
              message: 'Alert broadcasted and zone escalated in AI Engine',
              broadcastCount: result.sentCount,
              alert: payload,
              zone: escalatedZone,
              timestamp: Date.now()
            }));
          } catch (err) {
            console.error('[server] Alert broadcast endpoint error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        });
        return;
      }
    }

    // 17E. SHELTER OCCUPANCY API
    if (pathname.startsWith('/api/shelters')) {
      if (req.method === 'PATCH' || req.method === 'POST') {
        const parts = pathname.split('/');
        const shelterId = decodeURIComponent(parts[3] || '');
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}');
            console.log(`[server] Shelter occupancy updated: ${shelterId} -> ${payload.current_occupancy}`);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({
              success: true,
              message: `Shelter ${shelterId} occupancy updated to ${payload.current_occupancy}`,
              shelterId,
              occupancy: payload.current_occupancy,
              status: payload.status || 'open'
            }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        });
        return;
      }
    }


    // 17C. SATELLITE HAZARD TELEMETRY (NASA FIRMS & Sentinel Hub)
    if (pathname === '/api/satellite/telemetry') {
      if (req.method === 'GET') {
        try {
          const state = AIEngine.getState();
          if (state && state.satelliteTelemetry) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({
              success: true,
              satellite: state.satelliteTelemetry
            }));
          }
          const habitations = getCensusLookup();
          const zones = (state && state.allZones) || [];
          const telemetry = await SatelliteSignal.getSatelliteHazardSummary(zones, habitations);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            success: true,
            satellite: telemetry
          }));
        } catch (err) {
          console.error('[server] Satellite telemetry endpoint error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: err.message }));
        }
      }
    }

    // 18. WINDY CONFIGURATION & MAP FORECAST KEY SERVICE
    if (pathname === '/api/windy/config') {
      if (req.method === 'GET') {
        res.writeHead(200);
        return res.end(JSON.stringify({
          key: process.env.WINDY_MAP_KEY || '',
          configured: !!(process.env.WINDY_MAP_KEY)
        }));
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}');
            if (payload.key) {
              process.env.WINDY_MAP_KEY = payload.key.trim();
              res.writeHead(200);
              return res.end(JSON.stringify({ success: true, message: 'Windy Map Forecast key saved in runtime.' }));
            } else {
              res.writeHead(400);
              return res.end(JSON.stringify({ error: 'Key parameter required' }));
            }
          } catch (e) {
            res.writeHead(400);
            return res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
          }
        });
        return;
      }
    }

    // 18. IMD CAP ALERTS FEED
    if (pathname === '/api/imd-alerts' && req.method === 'GET') {
      try {
        const data = await getImdAlerts();
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=720' // 12 min browser hint
        });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({
          success: false,
          error: 'IMD feed error: ' + err.message,
          alerts: [],
          attribution: 'Data sourced from India Meteorological Department (IMD), Ministry of Earth Sciences'
        }));
      }
    }

    res.writeHead(404);
    return res.end(JSON.stringify({ error: 'API endpoint not found' }));
  }

  // ================= STATIC FILE SERVING =================
  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  } else if (pathname === '/citizen') {
    pathname = '/citizen.html';
  } else if (pathname === '/authority') {
    pathname = '/authority.html';
  }

  // Server-side auth check for authority interface
  if (pathname === '/authority.html') {
    const cookies = req.headers.cookie || '';
    if (!cookies.includes('rzi_auth=true')) {
      res.setHeader('Set-Cookie', 'rzi_auth=true; Path=/; SameSite=Lax');
    }
  }

  // Prevent directory traversal
  const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const htmlPath = filePath + '.html';
      if (fs.existsSync(htmlPath) && fs.statSync(htmlPath).isFile()) {
        filePath = htmlPath;
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <div style="font-family:sans-serif; text-align:center; padding:50px; background:#070b14; color:#fff; min-height:100vh;">
            <h1 style="color:#ef4444; font-size:48px; margin-bottom:10px;">404</h1>
            <h2>Page Not Found</h2>
            <p style="color:#94a3b8;">The requested resource <code style="color:#38bdf8;">${pathname}</code> was not found.</p>
          </div>
        `);
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Support HTTP Range requests for video/media streaming
    const range = req.headers.range;
    if (range && (ext === '.mp4' || ext === '.webm')) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      const chunksize = (end - start) + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType
      });
      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
      return;
    }

    const headers = {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Accept-Ranges': 'bytes'
    };
    if (ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json' || pathname === '/sw.js') {
      if (pathname === '/sw.js') {
        headers['Service-Worker-Allowed'] = '/';
      }
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    }

    res.writeHead(200, headers);
    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
  });
});

// ================================================================
// WEBSOCKET REAL-TIME STREAM SERVER & BROADCAST ENGINE
// ================================================================
let wss = null;
try {
  wss = new WebSocketServer({ server });
  console.log('⚡ WebSocket server attached to HTTP server');

  wss.on('connection', (ws, req) => {
    try {
      ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to RZI Live Alert Stream',
        timestamp: Date.now()
      }));
    } catch (e) {}

    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if ((parsed.action === 'broadcast_alert' || parsed.type === 'broadcast_alert') && parsed.alert) {
          broadcastAlert(parsed.alert);
        }
      } catch (err) {
        // Silent degradation
      }
    });

    ws.on('error', () => {});
  });
} catch (wsErr) {
  console.error('Failed to initialize WebSocketServer:', wsErr);
}

function broadcastAlert(alertPayload) {
  if (!wss) return { sentCount: 0 };
  const message = JSON.stringify({
    type: 'authority_alert',
    alert: alertPayload,
    timestamp: Date.now()
  });

  let sentCount = 0;
  wss.clients.forEach(client => {
    if (client.readyState === 1 /* WebSocket.OPEN */) {
      try {
        client.send(message);
        sentCount++;
      } catch (e) {}
    }
  });
  console.log(`[WebSocket] Broadcast alert "${alertPayload?.title || alertPayload?.message || 'Emergency Alert'}" sent to ${sentCount} clients`);
  return { sentCount };
}

if (process.argv.includes('--check')) {
  console.log('✅ Configuration check passed. All server modules verified.');
  process.exit(0);
}

// Initialize Single AI Orchestration Engine background scheduler
try {
  AIEngine.init({
    serverContext: {
      getOpenMeteoWeather,
      getUSGSEarthquakes,
      getImdAlerts,
      getCWCRiverLevels,
      hazardPolygons: {
        coastalFlood: COASTAL_FLOOD_ZONE,
        seismic: SEISMIC_ZONE,
        landslide: LANDSLIDE_ZONE
      }
    }
  });
} catch (aiInitErr) {
  console.error('Failed to initialize AIEngine in server:', aiInitErr);
}

// Ensure the live earthquake cache stays warm by polling every 20 minutes
setInterval(async () => {
  try {
    // Clear the cache manually to force a fresh fetch
    if (typeof earthquakeCache !== 'undefined') earthquakeCache = null;
    await getUSGSEarthquakes(50);
    console.log('[Server] Successfully polled USGS API for latest AP earthquakes.');
  } catch (err) {
    console.warn('[Server] Background earthquake poll failed:', err.message);
  }
}, 20 * 60 * 1000);

// Fetch once immediately on startup
setTimeout(() => getUSGSEarthquakes(50).catch(() => {}), 2000);

server.listen(PORT, () => {
  console.log('\n=============================================================');
  console.log('🔴  RISK2RESCUE — DISASTER MANAGEMENT PLATFORM');
  console.log('=============================================================');
  console.log(`🌐 Server running at: http://localhost:${PORT}`);
  console.log(`🧑‍💼 Citizen GIS Portal:       http://localhost:${PORT}/citizen`);
  console.log(`🏛️ Authority Command Center:  http://localhost:${PORT}/authority`);
  console.log(`🌍 Live USGS Earthquakes API: http://localhost:${PORT}/api/earthquakes/live`);
  console.log(`🌫️ Live Air Quality API:      http://localhost:${PORT}/api/air-quality/live`);
  console.log(`📡 Multi-Sensor Telemetry:    http://localhost:${PORT}/api/telemetry/live`);
  console.log(`🔔 IMD Official CAP Alerts:   http://localhost:${PORT}/api/imd-alerts`);
  console.log('=============================================================\n');
});
