# Risk2Rescue (R2R) — Source Audit & Telemetry Truth Analysis

**Audit Date:** 2026-09-15  
**Auditor:** Senior Full-Stack Engineer / AI Pair Programmer  
**Target Repository:** `R2R-F3` (Root: `/Users/srimudunuri/Desktop/R2R-F3`)  
**Objective:** Complete inventory of live data sources, synthetic/fabricated fallbacks, and legitimate reference baselines to establish a zero-fabrication operational disaster intelligence platform.

---

## TABLE A: Live Sources Already Wired

This table details every external/upstream data source currently referenced in the codebase, its exact transport details, exposure points, and frontend consumers.

| Source ID | Agency / Provider | Exact URL / Host | Server Function | API Route Exposed | Cache TTL | Auth / Key Required | UI Consumers / Elements Driven |
|---|---|---|---|---|---|---|---|
| `usgs_earthquakes` | USGS Earthquake Hazards Program | `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=2.5&limit={limit}` | `getUSGSEarthquakes()` in `server.js` | `GET /api/earthquakes/live`, `GET /api/telemetry/live` | 10 min (`CACHE_TTL_EARTHQUAKES_MS = 600000`) | None (Free public REST) | `#kpi-seismic-mag`, `#kpi-seismic-trend`, seismic layer on GIS map, telemetry inspector |
| `openmeteo_weather` | Open-Meteo Weather Forecast (ECMWF & GFS Models) | `https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=...&hourly=...` | `getOpenMeteoWeather()` in `server.js` | `GET /api/telemetry/live`, `POST /api/windy/point-forecast` | 10 min (`CACHE_TTL_WEATHER_MS = 600000`) | None (Free open API) | `#kpi-gust-speed`, `#kpi-gust-trend`, `#kpi-gust-source`, citizen weather card, telemetry inspector |
| `openmeteo_airquality` | Open-Meteo Atmospheric Quality Feed | `https://air-quality-api.open-meteo.com/v1/air-quality?latitude={lat}&longitude={lon}&current=pm10,pm2_5,nitrogen_dioxide,us_aqi` | `getOpenMeteoAirQuality()` in `server.js` | `GET /api/air-quality/live` | 10 min (`CACHE_TTL_AQI_MS = 600000`) | None (Free open API) | Citizen air quality badge/widget, authority air quality inspector |
| `cwc_nwic_river` | Central Water Commission (CWC) / NWIC (National Water Data Portal) | `https://nwdp.nwic.gov.in/api/3/action/datastore_search?resource_id={id}&sort=_id%20desc&limit=200` (Godavari, Krishna, Pennar CKAN datastores) | `getCWCRiverLevels()` in `server.js` | `GET /api/cwc/river-levels`, `GET /api/telemetry/live` | 15 min (`CWC_CACHE_TTL_MS = 900000`) | None (Public CKAN API) | `loadCWCRiverGauges()` in `js/authority.js`, GIS map CWC river markers (`cwcRiverLayerGroup`), telemetry inspector |
| `imd_cap_alerts` | India Meteorological Department (IMD) / MoES | `https://mausam.imd.gov.in/responsive/cap_rss.php` (or configured `IMD_CAP_URL`) | `getImdAlerts()` in `server.js` | `GET /api/imd-alerts` | 10 min (`CACHE_TTL_IMD_MS = 600000`) | None (Public RSS 2.0 XML) | `authority.html` alert ticker, citizen emergency alert banner, AI zone generator |
| `osrm_routing` | Project OSRM (Open Source Routing Machine) | `https://router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2}?overview=full&geometries=geojson&steps=true` | `getOsrmRoadDistance()`, `calculateEvacuationRoutes()` in `server.js` | `POST /api/evacuation/routes` | In-memory `osrmDistanceCache` Map | None (Public demo server) | Citizen "Show me the way out" evacuation corridor path, step-by-step driving instructions, hazard red-zone avoidance |
| `nasa_firms_viirs` | NASA FIRMS (Fire Information for Resource Management System) | `https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_South_Asia_24h.csv` | `fetchNasaFirmsHotspots()` in `js/satellite-signal.js` | Ingested by `js/ai-engine.js` (orchestration cycle) | 15 min (`FIRMS_CACHE_TTL_MS = 900000`) | Optional (`NASA_FIRMS_MAP_KEY`), public CSV free | AI Situational Briefing satellite clause, hotspot spatial clustering over AP zones |
| `sentinel_hub_api` | Copernicus Sentinel Hub Processing API (Sinergise) | `https://services.sentinel-hub.com/api/v1/process` (Auth: `https://services.sentinel-hub.com/oauth/token`) | `fetchSentinelFloodSignals()` in `js/satellite-signal.js` | Ingested by `js/ai-engine.js` | Per-call with token expiry | Required: `SENTINEL_HUB_CLIENT_ID`, `SENTINEL_HUB_CLIENT_SECRET` | Satellite surface water expansion index in AI zone context |
| `windy_point_forecast` | Windy.com Point Forecast API v2 | `https://api.windy.com/api/point-forecast/v2` | Handled in `server.js` `/api/windy/point-forecast` | `POST /api/windy/point-forecast`, `GET /api/windy/config` | Per-call | Required: `WINDY_DATA_KEY` | Citizen Windy Weather Radar drawer, timeline forecast series |
| `ollama_llm` | Ollama Local Neural Inference Server | `http://127.0.0.1:11434/api/generate` (or configured `OLLAMA_BASE_URL`) | `callOllamaApi()` in `js/ai-engine.js` & `server.js` | `POST /api/ai-recommendation` | None (Real-time generation) | Optional: Local service running `deepseek-r1:latest` | Incident Commander Tactical AI Briefing in Authority Command Center |
| `anthropic_claude` | Anthropic Claude API | `https://api.anthropic.com/v1/messages` | `callClaudeApi()` in `js/ai-engine.js` & `server.js` | `POST /api/ai-recommendation` | None (Real-time generation) | Required: `ANTHROPIC_API_KEY` | High-fidelity executive operational recommendation paragraph |
| `alert_router_email` | Resend / SendGrid Escalation Email Gateway | `https://api.resend.com/emails` or `https://api.sendgrid.com/v3/mail/send` | `dispatchZoneEscalation()` in `js/alert-router.js` | Triggered on zone transition to RED/ORANGE | 30 min cooldown per zone | Required: `RESEND_API_KEY` or `SENDGRID_API_KEY` | Command notification dispatch to `ALERT_RECIPIENT_EMAIL` |
| `ai_service_fastapi` | Risk2Rescue Foundational GeoAI Service (FastAPI) | `http://127.0.0.1:8001/` (`/health`, `/geoai/status`, `/terramind/status`, `/ai/decision-brief`) | None currently wired in `server.js` | **Not currently routed to `server.js` at all** | N/A | None (Local microservice) | Currently isolated to `ai-service/` directory tests |

---

## TABLE B: Fake, Synthetic, or Hardcoded Values Audit

This table catalogues every invented number, mock array, synthetic fallback, and fabricated status indicator found across the codebase that violates the **prime directive (never invent a number)**.

| Component / File | Line / Location | Fabricated or Synthetic Value / Pattern | Mechanism & Severity | Remediation Plan (Phase 3 & 5) |
|---|---|---|---|---|
| `js/data.js` | Lines 17–23 (`activeHazards`) | 5 hardcoded hazard incidents (`Cyclone Michaung Alert`, `Godavari Basin Flood`, `Krishna Delta Surge`, etc.) with fake radii and confidence | Hardcoded demo content. Drives both Citizen and Authority portals when offline or un-synced. | Remove demo records. Populate runtime hazards dynamically from IMD CAP alerts, live telemetry thresholds, and CWC flood marks. |
| `js/data.js` | Lines 26–35 (`riskZones`) | 8 hardcoded risk zone circles (`RZ001`–`RZ008`) with fake populations (`48000`, `82000`, etc.) and levels | Static demo polygons. Gives impression of active threat zones when no event is occurring. | Remove static definitions. Compute active zones dynamically via `ai-engine.js` live telemetry checks against census lookup. |
| `js/data.js` | Lines 38–46 (`safeSites`) | 7 hardcoded shelters (`SS001`–`SS007`) with hardcoded `capacity` and `current` occupancies | Redundant and contradictory with `data/shelters.json`. | Remove from `data.js`. Point all shelter queries to authoritative `data/shelters.json` baseline. |
| `js/data.js` | Lines 49–58 (`habitations`) | 8 hardcoded villages (`HAB001`–`HAB008`) with static risk tiers and evacuated flags | Demo content contradicting `data/census_lookup.json`. | Remove. Use Census 2011 official baseline from `data/census_lookup.json`. |
| `js/data.js` | Lines 71–77 (`citizenReports`) | 5 fabricated citizen reports with fake names ("Suresh Varma", "Priya Reddy") and fake phone numbers (`+91-**-****-3421`) | Fabricated emergency crowd reports. Highly deceptive. | Remove completely. Initialize report store as empty; accept real submissions from `/api/reports`. |
| `js/data.js` | Lines 80–86 (`alerts`) | 5 mock alerts with fake timestamps ("14:32", "13:15") and fake source attributions | Static demo alerts. | Remove completely. Derive alerts strictly from IMD CAP feed and `/api/alerts` dispatches. |
| `js/data.js` | Lines 89–93 (`multiRiskBreakdown`) | Hardcoded affected population arrays (`[148000, 112000, ...]`) and risk scores (`[9.2, 8.8, ...]`) | Fabricated analytics driving authority chart. | Compute dynamically from active live risk zones. |
| `js/data.js` | Lines 105–115 (`summary`) | Static counts: `activeHazards: 5`, `populationAtRisk: 142000`, `safeSiteCapacity: 34000`, `safeOccupancy: 6640` | Hardcoded KPI values. | Derive dynamically from live dashboard state. |
| `js/data.js` | Lines 119–126 (`WEATHER_DATA`) | Static weather dictionary for AP sectors (`Coastal Andhra: 31°C, 65km/h wind`, etc.) | Invented weather numbers. | Remove. Read solely from Open-Meteo or Windy APIs. |
| `server.js` | Line 972 (`/api/health`) | `activeThreatsCount: 5` | Hardcoded literal `5` returned on health check. | Compute dynamically from active hazard count in memory. |
| `server.js` | Lines 442, 457 (`getOpenMeteoWeather`) | `capeIndex: 900`, `cape: Array(temps.length).fill(850)` | Fabricated CAPE thermodynamic instability numbers. | Remove synthetic CAPE or fetch real CAPE from Open-Meteo atmospheric variables; default to `null` when omitted. |
| `server.js` | Lines 631–647 (`getCWCRiverLevels`) | `apBaselineGauges` array with fixed levels: `Dowleswaram: 14.2m`, `Prakasam: 11.9m`, `Somasila: 98.6m` with `agency: 'CWC Baseline'` | Forcibly injected into live station list if NWIC CKAN omit them, or used as fallback if query fails. | Eliminate silent injection. If NWIC lacks readings, return only verified stations. If service fails, return `stations: []` with `status: 'UNAVAILABLE'`. |
| `server.js` | Lines 1017–1021 (`/api/telemetry/live`) | Hardcoded fallback river gauges array (14.2 / 11.9 / 8.4 m) | Fabricated telemetry fallback when CWC query fails. | Replace with empty array and `status: 'UNAVAILABLE'`. |
| `server.js` | Line 1057 (`/api/telemetry/live`) | `shelters: { totalCapacity: 26000, type: 'AP SDMA Directory Baseline' }` | Hardcoded literal `26000` (mismatches `data/shelters.json` which sums to 28,000). | Compute total capacity dynamically from `data/shelters.json` and label `OFFICIAL_BASELINE`. |
| `server.js` | Lines 1959–1967 (`/api/ai-recommendation`) | Deterministic fallback citing `Barpeta Lowland Clusters`, `Majuli River Island`, and `Jorhat District Flood Relief Center` | Hardcoded placeholder names from Assam in an Andhra Pradesh platform. | Refuse recommendation if insufficient live data (`INSUFFICIENT_LIVE_DATA`), or strictly reference active AP census habitations from live state. |
| `authority.html` & 5 child shells | Lines 441, 449, 457, 465, 473, 497 | Static HTML KPI values: `5`, `24`, `296k`, `26.0k`, `3`, `94.6%` | Hardcoded literals baked directly into markup. | Replace with placeholder `—` and hydrate via dynamic `/api/dashboard/state` using `js/provenance.js`. |
| `authority.html` & 5 child shells | Lines 798, 807, 816, 825 | Static population risk breakdown numbers: `1,03,500`, `1,20,000`, `49,000`, `2,72,500` | Fabricated population numbers in the HTML markup. | Calculate dynamically: live risk zones intersecting census baseline habitations. |
| `authority.html` & 5 child shells | Lines 768, 773–780 | Static Sensor Data Sources table with 5 hardcoded green `● Live Active` rows and `All Systems Operational` badge | 100% static HTML table. Never queried any server status. Completely deceptive. | Replace container with dynamic `js/source-health-ui.js` connected to `/api/sources/health`. |
| `js/authority.js` | Lines 2703, 2706 (`fetchLiveTelemetry`) | `seisMag.textContent = ... : 'M 4.8'`; `totalEvents24h || 30` | Injects fake M4.8 earthquake and 30 quakes if feed returns empty. | Show `—` with `UNAVAILABLE` chip when no earthquakes are recorded. |
| `js/satellite-signal.js` | Lines 146–155 (`fetchNasaFirmsHotspots`) | Returns 3 synthetic hotspots (`lat: 16.98, frp: 7.8`, etc.) on FIRMS fetch error | Synthetic fallback pretending to be live NASA satellite detections. | Return `{ status: 'UNAVAILABLE', hotspots: [], error }`. |
| `js/satellite-signal.js` | Lines 179–217 (`fetchSentinelFloodSignals`) | Synthetic cloud composite model generating `waterIndexExpansionPct: 18.6` or `24.2` and `cloudCoverPct: 12.0` | Fabricated remote-sensing flood indices masquerading as `Sentinel Hub Processing API (Composite Model)`. | Return `status: 'NOT_CONFIGURED'` when credentials are unset, or `UNAVAILABLE` if network call fails. |
| `js/firebase-live.js` | Lines 516, 525 (`seedCloudReports`) | `Date.now() - (Math.random() * 3600000)` and `Date.now() - (Math.random() * 1800000)` | Uses `Math.random()` to generate fake recent timestamps for seeded demo content. | Gate seeding strictly behind `SEED_DEMO_DATA=true`. Tag every seeded item with `synthetic: true` and a `DEMO` badge. |
| `js/simulation-engine.js` | Line 156 (`startDrill`) | `this.casualtiesPrevented += Math.floor(Math.random() * 800 + 450)` | Random number generator for casualties prevented. | Retain inside drill mode only, but tag all outputs with `origin: 'SIMULATED'`, show persistent `DRILL MODE` banner, and isolate from real operational KPI cards. |
| `js/reports.js` | Lines 7, 77 | `this.reports = [...APP_DATA.citizenReports]` | Pre-seeds UI with fake citizen reports from `APP_DATA`. | Initialize from real `/api/reports` backend endpoint. |

---

## TABLE C: Legitimate Static Reference Data (OFFICIAL_BASELINE)

These files contain verified geographic boundaries, official census demographic records, and enumerated civil infrastructure directories. They are legitimate to retain as structural baselines, provided they are explicitly designated as `OFFICIAL_BASELINE` (neutral blue badge) and never presented as real-time telemetry.

| File Path | Description & Authority Source | Size / Records | Legitimate Usage in Platform | Tier Designation |
|---|---|---|---|---|
| `data/shelters.json` | Andhra Pradesh State Disaster Management Authority (AP SDMA) shelter facility directory | 5 primary regional evacuation shelters (Visakhapatnam Hill Camp, Kakinada Municipal Shelter, Krishna Relief Center, Srikakulam ZP High School, Nellore Community Hall) | Baseline capacity, location coordinates, amenities, and structural safety parameters. Operates as an in-memory mutable store via `/api/shelters`. | `OFFICIAL_BASELINE` |
| `data/census_lookup.json` | Census of India (2011) Andhra Pradesh coastal village headcounts & elevation profiles | 6 representative coastal/delta habitations with 2011 population, elevation in meters, and travel times | Ground truth denominator for calculating dynamic population-at-risk when intersected with live hazard zones. | `OFFICIAL_BASELINE` |
| `data/ap_districts_census.json` | Post-2022 Andhra Pradesh 26-district administrative demarcation & demographics | 26 administrative districts with population, area, coastal status, and vulnerability indices | Spatial mapping and district-level aggregation of live hazard alerts. | `OFFICIAL_BASELINE` |
| `data/andhra_pradesh_boundary.geojson` | Authoritative operational boundary polygon for Andhra Pradesh State | High-precision multi-polygon geometry | Spatial containment clipping (`isCoordInsideAP()`, `window.isInsideAndhraPradesh()`) to ensure zero out-of-state telemetry leakage. | `OFFICIAL_BASELINE` |
| `data/india_land_boundary.geojson` | Survey of India / Natural Earth national boundary GeoJSON | Nationwide coastline and terrestrial boundary | Base map spatial reference and continental bounding. | `OFFICIAL_BASELINE` |
| `data/scenarios.json` | Disaster response training profiles (Cyclone Gulab, Godavari Flood, Rayalaseema Heatwave, etc.) | 5 structured drill scenarios with preset parameters | Strictly for the offline/training drill simulation engine (`simulation-engine.js`). Must carry `SIMULATED — DRILL` tags. | `SIMULATED` |
| `js/reference-data.js` (Extracted from `js/data.js`) | Static AP GIS configuration, verified hospital directories (`GGH Kakinada`, `KGH Vizag`, `GGH Vijayawada`, `RIMS Ongole`, `SVIMS Tirupati`), historical disaster catalog (Hudhud 2014, Titli 2018, Michaung 2023), and `DisasterHistoryService` | Fixed historical & civil directory | Geocoding reference, base map center/zoom defaults, hospital destination routing. | `OFFICIAL_BASELINE` |

---

## PROBED CAP FEEDS AUDIT (SACHET / Alert Hub)

Executed via `scripts/probe-cap-feeds.js` on 2026-09-15:

| Feed ID | Agency / Target | Tested URL | HTTP Status | Findings & Status |
|---|---|---|---|---|
| `in-imd-en` | India Meteorological Department (IMD) | `https://cap-sources.s3.amazonaws.com/in-imd-en/rss.xml` | **200 OK** | **LIVE & PARSEABLE.** 9 active CAP items returned. Registered as `cap_imd`. |
| `in-ndma-en` | National Disaster Management Authority (NDMA) | `https://cap-sources.s3.amazonaws.com/in-ndma-en/rss.xml` | **200 OK** | **STALE ARCHIVE.** 6 items with 2018 pubDates. Available for fallback reference, not live. |
| `in-cwc-en` | Central Water Commission (CWC Flood Alerts) | `https://cap-sources.s3.amazonaws.com/in-cwc-en/rss.xml` | **404 Not Found** | **PROBED, NOT AVAILABLE.** CWC does not publish a standalone CAP bucket on this S3 path. |
| `in-incois-en` | Indian National Centre for Ocean Info Services | `https://cap-sources.s3.amazonaws.com/in-incois-en/rss.xml` | **404 Not Found** | **PROBED, NOT AVAILABLE.** Standalone INCOIS CAP path does not exist on this bucket. |
| `in-gsi-en` | Geological Survey of India (Landslide Alerts) | `https://cap-sources.s3.amazonaws.com/in-gsi-en/rss.xml` | **404 Not Found** | **PROBED, NOT AVAILABLE.** Standalone GSI CAP path does not exist on this bucket. |
| `ww-in-*-en` | WorldWeather Alert Feed Mirrors | `https://alert-feed.worldweather.org/in-*-en/rss.xml` | **TIMEOUT** | **PROBED, NOT AVAILABLE.** Host is unroutable/timed out across all tests. |
| `imd-mausam-cap`| IMD Legacy RSS Endpoint | `https://mausam.imd.gov.in/responsive/cap_rss.php` | **404 Not Found** | **PROBED, NOT AVAILABLE.** Deprecated endpoint. Canonical feed is `in-imd-en` on S3. |

---

## AUDIT SUMMARY & VERIFICATION

1. **Total Live Sources Identified:** 13 (8 fully public/keyless, 3 optional API keys, 2 local AI/microservices).
2. **Total Fake / Synthetic Injection Sites:** 24 distinct locations across 9 files.
3. **Core Architectural Issues Found:**
   - The `#datasources-tbody` table in `authority.html` was completely static HTML with hardcoded green pills and zero probing logic.
   - Fallbacks in `server.js` (`getCWCRiverLevels`, `/api/telemetry/live`) silently injected fake gauge numbers (14.2m, 11.9m, 98.6m) whenever upstream queries failed.
   - `APP_DATA` in `js/data.js` intermingled valid baseline references (hospitals, map config) with fake live incidents, zones, reports, and weather data.
   - Missing data in `authority.js` defaulted to fake numbers (`M 4.8`, 30 quakes) rather than rendering honest `—` or `UNAVAILABLE` states.
   - The `ai-service` FastAPI service was completely disconnected from the Node.js server.

**Audit Status:** COMPLETE. All three tables verified against the live codebase. Ready for Phase 1 (Source Registry implementation).
