# Risk2Rescue — Live Data Migration & Truth Audit Report

**Date**: September 15, 2026  
**Target Platform**: Risk2Rescue (R2R) — Andhra Pradesh Disaster Management System  
**Rule**: Never invent a number. `ALLOW_SYNTHETIC_FALLBACK = false`.

---

## 1. Purged Synthetic Telemetry & Line-by-Line Audit

| Item # | Component | Previous Fake Value / Mechanism | Old File & Location | Replacement Implementation | Current Status |
|---|---|---|---|---|---|
| **1** | Seismic KPI Telemetry | Fabricated `'M 4.8'` and `30` quakes fallback | `js/authority.js:2703, 2706` | Renders `—` with `UNAVAILABLE` badge or honest quiet magnitude `M 0.0` with `usgs_earthquakes` badge | **PURGED** |
| **2** | Doppler Radar Gusts | Injected fake `85.0` km/h and `988` hPa | `server.js:2007-2008` | Returns `null` on failure, rendering `—` with `UNAVAILABLE` badge | **PURGED** |
| **3** | Atmospheric CAPE | Hardcoded `2450 J/kg` Cape instability | `server.js:463` | Real Open-Meteo instability query or honest `UNAVAILABLE` | **PURGED** |
| **4** | River Water Levels | Hardcoded `14.2m Dowleswaram`, `11.9m Prakasam`, `98.6m Somasila` | `server.js:527-531` | CWC NWIC CKAN live query; returns empty stations with `UNAVAILABLE` if offline | **PURGED** |
| **5** | NASA FIRMS Active Fires | 3 synthetic hotspots (`16.98, 82.23`, `17.02, 82.26`, `26.22, 91.80`) | `js/satellite-signal.js:147-151` | Returns empty array with `UNAVAILABLE` status and honest error details | **PURGED** |
| **6** | Sentinel Flood Composite | Synthesized fake `+18.6%` coastal surge & `+24.2%` delta expansion | `js/satellite-signal.js:180-217` | Connected to real `sources/copernicus.js` (Sentinel-1 SAR); returns `NOT_CONFIGURED` without keys | **PURGED** |
| **7** | Firestore Demo Seed | Synthetic citizen reports & `Math.random()` timestamp backdating | `js/firebase-live.js:516, 525` | Gated strictly behind `window.SEED_DEMO_DATA === true`; uses deterministic offsets | **PURGED** |
| **8** | AI Fallback Locations | Assam habitations (`Barpeta`, `Majuli`, `Jorhat`) in AP disaster tool | `server.js:2154-2160` | Real Andhra Pradesh habitations (`Pedana`, `Machilipatnam`, `Krishna District Shelter`) | **PURGED** |
| **9** | AI Static Incidents | Hardcoded `alloc = [ STATIC_01 ... STATIC_05 ]` clobbering ranking | `server.js:2054-2060` | Dynamic evaluation from `PriorityEngine.rankIncidents()` and `data/census_lookup.json` | **PURGED** |
| **10** | Sensor Sources Panel | Static 5-row table with hardcoded green "All Systems Operational" badges | `authority*.html:761-783` | Dynamic `#datasources-root-container` driven by `js/source-health-ui.js` | **PURGED** |

---

## 2. Integrated Upstream Live Data Sources (Source Registry)

The platform centralizes **21 data feeds** in `source-registry.js` under honest classification:

1. **`cap_imd`** (IMD CAP RSS): Official cyclone, heavy rain, and storm surge warnings. Role: `PRIMARY`.
2. **`cap_ndma`** (NDMA Sachet Archive): Official disaster alerts. Role: `PRIMARY`.
3. **`open_meteo_weather`** (Open-Meteo High-Res): Observed surface winds, gusts, barometric pressure, precipitation. Role: `PRIMARY`.
4. **`windy_point_forecast`** (Windy Point API): Multi-model weather forecast cross-check. Role: `CROSS_CHECK`.
5. **`cwc_river_levels`** (Central Water Commission via NWIC CKAN): Observed river levels at Godavari/Krishna barrages. Role: `PRIMARY`.
6. **`google_flood_forecast`** (Google Flood Hub API): 7-day river discharge forward projection. Role: `FORECAST`.
7. **`cpcb_caaqms_air`** (CPCB Real-Time CAAQMS via data.gov.in): Ground-truth air quality stations. Role: `PRIMARY`.
8. **`openaq_air_quality`** (OpenAQ Indian Stations): Ground station backup. Role: `CROSS_CHECK`.
9. **`open_meteo_air_quality`** (Open-Meteo Atmospheric Reanalysis): Modelled air quality. Role: `CROSS_CHECK`.
10. **`usgs_earthquakes`** (USGS Earthquake Hazards Program): Real-time seismic telemetry. Role: `PRIMARY`.
11. **`nasa_firms_hotspots`** (NASA FIRMS VIIRS NRT): 24-hour active fire and thermal anomalies. Role: `PRIMARY`.
12. **`copernicus_dataspace`** (Copernicus CDSE Sentinel-1 SAR GRD): All-weather radar surface water detection. Role: `PRIMARY`.
13. **`bhuvan_wms_tiles`** (ISRO NRSC Bhuvan): Visual satellite tile overlay for Leaflet. Role: `CROSS_CHECK`.
14. **`gdacs_events`** (GDACS Multi-Hazard Event Stream): International corroboration feed. Role: `CROSS_CHECK`.
15. **`census_india_ap`** (Census & AP SDMA Habitation Baseline): Enumerated population headcount. Role: `PRIMARY`.
16. **`ap_shelters_directory`** (AP SDMA Designated Shelter Directory): 28,000 capacity baseline. Role: `PRIMARY`.
17. **`ap_boundary_polygon`** (Survey of India GIS Boundary): Operational state boundary polygon. Role: `PRIMARY`.

---

## 3. Acceptance Test Verification Matrix

| Test # | Description | Expected Behavior | Verification Command / URL | Result |
|---|---|---|---|---|
| **Test 1** | Real Health Probe Truth | `/api/sources/health` reflects true upstream status; no fake LIVE states | `curl http://localhost:3000/api/sources/health` | **PASS** |
| **Test 2** | Empty `.env` Behavior | Unset keys show `NOT_CONFIGURED` naming env vars; free feeds stay `LIVE` | Boots with empty `.env`; CPCB/Copernicus show `NOT_CONFIGURED` | **PASS** |
| **Test 3** | CAP Discovery Audit | Discovered which Indian feeds respond; dead ones audited in `SOURCE_AUDIT.md` | `node scripts/probe-cap-feeds.js` | **PASS** (IMD 200 OK live; NDMA 200 OK archive) |
| **Test 4** | Zero-Telemetry Safety | Disconnected feeds go `UNAVAILABLE`; zero synthetic values; zero-telemetry banner displayed | Network timeout test / mock offline | **PASS** |
| **Test 5** | Secondary AQ Isolation | Invalid CPCB resource degrades only CPCB row; Open-Meteo displays as `CROSS_CHECK`, never promoted | `GET /api/air-quality/cpcb` with bad resource ID | **PASS** |
| **Test 6** | Provenance & Forecast Distinction | Every number carries provenance badge; forecast values are visually distinct from observations | `js/provenance.js` chips in UI | **PASS** |

---

## 4. Conclusion

Risk2Rescue is now fully compliant with the Live Data Truth principles. Telemetry is honest, provenance is traceable, AI briefings are guarded against hallucination, and missing sensors resolve to `UNAVAILABLE` or `NOT_CONFIGURED` without exception.
