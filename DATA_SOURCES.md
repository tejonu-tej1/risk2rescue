# Risk2Rescue — Platform Data Sources & Telemetry Truth Reference

**Standard:** Zero-Fabrication Emergency Response Telemetry  
**Scope:** Andhra Pradesh Multi-Hazard Command & Citizen Operations  
**Date:** 2026-09-15  

---

## TELEMETRY ROLES & TIER SEMANTICS

| Role / Tier | Strict Meaning & Display Semantics |
|---|---|
| `PRIMARY` | Official issuing authority or primary ground-truth sensor network. |
| `CROSS_CHECK` | Independent secondary model or global feed used for corroboration. **Never silently replaces a failed primary.** |
| `FORECAST` | Forward-looking numerical or AI projection (e.g. 7-day flood horizon). Clearly visually separated from observed readings. |
| `LIVE_API` | Real-time upstream network endpoint. Only green `● LIVE` if fresh probe succeeds now. |
| `OFFICIAL_BASELINE`| Verified enumerated civil directory (shelters, 2011 census, state boundary). Displayed with neutral blue `ℹ BASELINE`. |
| `DERIVED` | Computed from live inputs × baselines. Must explicitly cite contributing source IDs. |
| `SIMULATED` | Training drill engine output. Only visible during active drill with amber `SIMULATED — DRILL` tag. |

---

## DATA SOURCES INVENTORY

### 1. Seismic & Earthquake Monitoring

#### `usgs_earthquakes` — Global Real-Time Seismic Feed (M2.5+)
- **Agency:** United States Geological Survey (USGS) Earthquake Hazards Program
- **What it Measures:** Real-time global seismic epicenters, magnitudes (Richter/moment magnitude), depth (km), and origin epoch.
- **Cadence:** 10 minutes (`600,000 ms`).
- **Role:** `PRIMARY`
- **Accuracy Caveats:** Global sensor array covers Indian subcontinent well for M3.0+ events. Micro-tremors (< M2.5) may not be recorded.
- **Licence & Attribution:** Public Domain (USGS). Attribute: `Data courtesy of U.S. Geological Survey`.
- **UI Failure Behaviour:** Renders `—` with an amber/red `UNAVAILABLE` chip. **Zero synthetic quakes (never defaults to fake M4.8).**

---

### 2. Meteorological & Doppler Radar

#### `openmeteo_weather` — Live Atmospheric & Surface Wind Forecast
- **Agency:** Open-Meteo (Aggregated ECMWF Integrated Forecasting System & NOAA GFS)
- **What it Measures:** Surface temperature (2m), 10m wind speed, peak gusts, surface pressure (hPa), relative humidity, precipitation rate (mm/h).
- **Cadence:** 10 minutes (`600,000 ms`).
- **Role:** `PRIMARY` (free keyless default)
- **Accuracy Caveats:** High-resolution numerical weather prediction models; radar actuals at coastal stations may vary during localized squall fronts.
- **Licence & Attribution:** Open Database Licence (ODbL) / CC BY 4.0. Attribute: `Weather data by Open-Meteo.com (ECMWF/GFS)`.
- **UI Failure Behaviour:** Radar gust KPI shows `— km/h` with `UNAVAILABLE` provenance badge.

#### `windy_point_forecast` — Windy Point Forecast API v2
- **Agency:** Windy.com / Windyty, SE
- **What it Measures:** Multi-model point forecast series (GFS, ECMWF, ICON) for coastal landfall corridors.
- **Cadence:** 15 minutes (`900,000 ms`).
- **Role:** `CROSS_CHECK`
- **Requires Key:** `WINDY_DATA_KEY`
- **Accuracy Caveats:** Available only when API key is configured.
- **Licence & Attribution:** Proprietary Commercial / Free Tier. Attribute: `Forecasts provided by Windy.com`.
- **UI Failure Behaviour:** Displays `NOT_CONFIGURED` with prompt to add key; Open-Meteo continues to display as itself, not as Windy.

---

### 3. Atmospheric Quality & CAAQMS Ground Stations

#### `cpcb_airquality` — Real-Time National Air Quality Index (CAAQMS)
- **Agency:** Central Pollution Control Board (CPCB), Ministry of Environment, Forest and Climate Change (MoEFCC)
- **What it Measures:** Continuous real-time ground-station observations of PM2.5, PM10, NO2, and Indian National AQI across AP urban centers (Visakhapatnam, Vijayawada, Tirupati, Rajahmundry, Amaravati).
- **Cadence:** 30 minutes (`1,800,000 ms`).
- **Role:** `PRIMARY`
- **Requires Key:** `DATA_GOV_IN_API_KEY` (Free via data.gov.in)
- **Accuracy Caveats:** Physical sensor downtime or calibration outages occur. Individual stations older than 3 hours are flagged `STALE`. If >50% of stations are stale, source status degrades to `DEGRADED`.
- **Licence & Attribution:** National Data Sharing and Accessibility Policy (NDSAP) / Government of India Open Data License. Attribute: `Data published by Central Pollution Control Board via data.gov.in`.
- **UI Failure Behaviour:** Displays `—` with `UNAVAILABLE` chip. When unconfigured, shows `NOT_CONFIGURED`.

#### `openmeteo_airquality` — Atmospheric PM2.5, PM10, NO2 Reanalysis
- **Agency:** Open-Meteo Atmospheric Quality Feed (CAMS / Copernicus Atmosphere Service)
- **What it Measures:** Modelled atmospheric reanalysis concentrations of particulate matter and chemical pollutants.
- **Cadence:** 10 minutes (`600,000 ms`).
- **Role:** `CROSS_CHECK`
- **Accuracy Caveats:** Atmospheric transport model, not a physical ground-level sensor.
- **Licence & Attribution:** CC BY 4.0. Attribute: `Atmospheric data by Open-Meteo / Copernicus CAMS`.
- **UI Failure Behaviour:** Renders secondary comparison chip; clearly labeled as `Modelled Reanalysis`.

#### `openaq_aq` — OpenAQ Verified Ground Sensor Platform
- **Agency:** OpenAQ Community
- **What it Measures:** Aggregated open ground station records.
- **Cadence:** 30 minutes.
- **Role:** `CROSS_CHECK`
- **Licence & Attribution:** CC BY 4.0 (OpenAQ).
- **UI Failure Behaviour:** Renders `UNAVAILABLE` on fetch failure.

---

### 4. Hydrology & River Basins

#### `cwc_nwic_river` — National Water Data Portal Basin River Level Gauges
- **Agency:** Central Water Commission (CWC), Ministry of Jal Shakti / NWIC
- **What it Measures:** Real-time observed river water level telemetry (meters) across Godavari, Krishna, and Pennar river basins.
- **Cadence:** 15 minutes (`900,000 ms`).
- **Role:** `PRIMARY` (Observed)
- **Accuracy Caveats:** Station telemetry reflects instantaneous river level. Flood danger marks vary per gauging station.
- **Licence & Attribution:** National Water Informatics Centre (NWIC) Open Data. Attribute: `National Water Data Portal (NWIC / Central Water Commission)`.
- **UI Failure Behaviour:** Missing or unreporting stations render `— m`. **Zero synthetic baseline injections (no fake 14.2m or 11.9m).**

#### `google_flood_forecast` — Google Flood Hub AI Hydrologic Forecast
- **Agency:** Google Flood Forecasting Initiative
- **What it Measures:** Hydrologic discharge forecasts up to 7 days ahead with flood status probability and lead times.
- **Cadence:** 60 minutes (`3,600,000 ms`).
- **Role:** `FORECAST`
- **Requires Key:** `GOOGLE_FLOOD_API_KEY`
- **Accuracy Caveats:** AI hydrological simulation driven by satellite precipitation and gauge models. Clearly differentiated from CWC observed levels.
- **Licence & Attribution:** Creative Commons Attribution 4.0 International (CC BY 4.0). Attribute: `Google Flood Forecasting Initiative (CC BY 4.0)`.
- **UI Failure Behaviour:** Unconfigured shows `NOT_CONFIGURED`. UI distinguishes `qualityVerified` vs unverified gauges.

---

### 5. Official Disaster Early Warnings & Alerts

#### `cap_imd` — National Common Alerting Protocol (CAP) Stream
- **Agency:** India Meteorological Department (IMD), Ministry of Earth Sciences (MoES)
- **What it Measures:** Official severe weather, cyclone landfall warnings, heavy rainfall red alerts, and squall advisories formatted in WMO CAP XML 2.0.
- **Cadence:** 10 minutes (`600,000 ms`).
- **Role:** `PRIMARY`
- **Accuracy Caveats:** Official government warning bulletin.
- **Licence & Attribution:** Government of India MoES Open Early Warning Data. Attribute: `India Meteorological Department (IMD), Ministry of Earth Sciences`.
- **UI Failure Behaviour:** Authority alert list displays empty state with `No Active Official IMD Alerts at this time`.

#### `gdacs_events` — Global Disaster Alert and Coordination System
- **Agency:** United Nations (OCHA) / European Commission (Joint Research Centre)
- **What it Measures:** Global multi-hazard alerts (Cyclones, Floods, Earthquakes) with Red/Orange/Green impact score.
- **Cadence:** 30 minutes (`1,800,000 ms`).
- **Role:** `CROSS_CHECK`
- **Accuracy Caveats:** Global scale; used strictly to corroborate Indian official alerts and raise confidence scores. Never creates a local hazard zone alone.
- **Licence & Attribution:** UN OCHA / European Commission Open Feed. Attribute: `GDACS (UN / European Commission)`.
- **UI Failure Behaviour:** Omits corroboration chip when GDACS is unreachable.

---

### 6. Earth Observation Satellites & Thermal Feeds

#### `nasa_firms_viirs` — VIIRS NRT 24-Hour Active Fire & Thermal Anomaly Feed
- **Agency:** NASA Earth Observing System Data and Information System (EOSDIS) / LANCE FIRMS
- **What it Measures:** Satellite thermal anomalies, fire radiative power (FRP in MW), and 375m pixel brightness temperatures from Suomi NPP VIIRS C2.
- **Cadence:** 15 minutes (`900,000 ms`).
- **Role:** `PRIMARY`
- **Accuracy Caveats:** Detects thermal anomalies (industrial flaring, agricultural burning, forest fires). Filtered spatially to Andhra Pradesh and Indian subcontinent.
- **Licence & Attribution:** NASA Open Data Policy. Attribute: `NASA FIRMS VIIRS Near-Real-Time Active Fire Data`.
- **UI Failure Behaviour:** Returns empty array with `UNAVAILABLE`. **Zero synthetic fire hotspots.**

#### `copernicus_dataspace` — Sentinel-1 SAR Radar Flood Penetration
- **Agency:** European Space Agency (ESA) / Copernicus Data Space Ecosystem
- **What it Measures:** All-weather synthetic aperture radar (SAR GRD VV/VH) backscatter and Sentinel-2 L2A NDWI surface water deltas.
- **Cadence:** 6 hours (`21,600,000 ms`) matching satellite revisit window.
- **Role:** `PRIMARY`
- **Requires Key:** `COPERNICUS_CLIENT_ID`
- **Accuracy Caveats:** SAR passes occur at discrete orbital intervals. Timestamp is mandatory: UI displays "Sentinel-1, acquired 6h ago".
- **Licence & Attribution:** Copernicus Sentinel Data Policy (Free, full and open). Attribute: `Contains modified Copernicus Sentinel data [2026]`.
- **UI Failure Behaviour:** When unconfigured, shows `NOT_CONFIGURED`. **Zero fake composite models.**

#### `bhuvan_wms` — ISRO / NRSC Bhuvan Geoportal WMS
- **Agency:** Indian Space Research Organisation (ISRO) / National Remote Sensing Centre (NRSC)
- **What it Measures:** High-resolution Indian satellite base ortho-imagery tiles.
- **Cadence:** Static Baseline (`86,400,000 ms`).
- **Role:** `PRIMARY`
- **Tier:** `OFFICIAL_BASELINE`
- **Licence & Attribution:** ISRO NRSC Open Geoportal. Attribute: `Bhuvan Geoportal, ISRO / NRSC`.
- **UI Failure Behaviour:** Falls back to OpenStreetMap / CartoDB base tiles.

---

### 7. Road Network & Civil Evacuation Routing

#### `osrm_routing` — Open Source Routing Machine (OSRM)
- **Agency:** Project OSRM / OpenStreetMap Contributors
- **What it Measures:** Road network distances, driving durations, walking durations, and turn-by-turn evacuation geometries.
- **Cadence:** In-memory cached corridors.
- **Role:** `PRIMARY`
- **Accuracy Caveats:** Assumes normal road network connectivity unless clipped against active Red Zone hazard polygons.
- **Licence & Attribution:** OpenStreetMap ODbL. Attribute: `© OpenStreetMap contributors, Project OSRM`.
- **UI Failure Behaviour:** Direct straight-line estimate with explicit "DIRECT ESTIMATE" label; never pretends to be road-routed.

---

### 8. Official Reference Baselines (OFFICIAL_BASELINE)

#### `ap_sdma_shelters` — Authoritative Evacuation Shelter Directory
- **Source:** Andhra Pradesh State Disaster Management Authority (AP SDMA)
- **Storage:** `data/shelters.json`
- **Role:** Enumerated civil capacity ground truth. Total Capacity: **28,000 beds** across 5 regional centers.

#### `census_india_ap` — Coastal Habitations Demographics Baseline
- **Source:** Census of India (2011), Ministry of Home Affairs
- **Storage:** `data/census_lookup.json` & `data/ap_districts_census.json`
- **Role:** Denominator for population-at-risk calculations when intersected with live hazard zones.

#### `ap_boundary_polygon` — Authoritative Operational State Boundary
- **Source:** Survey of India / AP SDMA GIS Cell
- **Storage:** `data/andhra_pradesh_boundary.geojson`
- **Role:** Spatial containment clipping to prevent out-of-state telemetry leakage.
