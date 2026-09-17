# Risk2Rescue — AI Integration Plan & Telemetry Contract

## 1. Executive Summary

The Risk2Rescue (R2R) AI Decision Support layer provides automated operational briefings and evacuation recommendations to Incident Commanders managing disaster response across Andhra Pradesh. Under the Live Data Truth Migration, the AI layer is strictly governed by anti-hallucination controls: **no briefing is ever generated on synthesized or missing data**.

---

## 2. Anti-Hallucination Architectural Guard

### 2.1 The `MIN_LIVE_SOURCES_FOR_AI` Circuit Breaker
- **Threshold**: Configurable via `process.env.MIN_LIVE_SOURCES_FOR_AI` (Default: `3`).
- **Mechanism**: Prior to evaluating any AI prompt or invoking an LLM provider (Ollama / Claude API), `/api/ai-recommendation` queries `SourceRegistry.checkAllSources()`.
- **Enforcement**:
  ```javascript
  const healthReport = await SourceRegistry.checkAllSources();
  if (healthReport.summary.live < MIN_LIVE_SOURCES_FOR_AI) {
    return res.end(JSON.stringify({
      success: false,
      status: 'INSUFFICIENT_LIVE_DATA',
      liveSourceCount: healthReport.summary.live,
      requiredLiveSources: MIN_LIVE_SOURCES_FOR_AI,
      recommendation: `INSUFFICIENT LIVE TELEMETRY: Only ${healthReport.summary.live} real-time sensor source(s) are LIVE (minimum ${MIN_LIVE_SOURCES_FOR_AI} required). AI situational briefing suspended to prevent hallucination of critical life-safety recommendations.`,
      model: 'Anti-Hallucination Guard',
      generatedAt: new Date().toISOString()
    }));
  }
  ```

### 2.2 Rejection of Synthetic Substitutes
If network connectivity fails or upstream data providers (e.g., IMD, USGS, CPCB, CWC) become unreachable, the platform reports honest `UNAVAILABLE` or `DEGRADED` states. Synthetic placeholders (such as fake radar gusts or mock seismic magnitudes) are strictly prohibited from feeding the AI prompt.

---

## 3. Dynamic Context Contract (`GET /api/ai/context`)

The endpoint `GET /api/ai/context` packages the complete real-time state of Andhra Pradesh for ingestion by local LLMs (DeepSeek-R1 via Ollama), Claude 3.5 Sonnet, or the Python FastAPI microservice (`ai-service/`).

```json
{
  "timestamp": "2026-09-15T04:10:00.000Z",
  "state": "Andhra Pradesh",
  "dataHealth": {
    "liveSourcesCount": 4,
    "systemStatus": "OPERATIONAL",
    "sources": [
      { "id": "cap_imd", "status": "LIVE", "role": "PRIMARY", "cadenceMs": 900000 },
      { "id": "usgs_earthquakes", "status": "LIVE", "role": "PRIMARY", "cadenceMs": 600000 },
      { "id": "open_meteo_weather", "status": "LIVE", "role": "PRIMARY", "cadenceMs": 600000 },
      { "id": "cpcb_caaqms_air", "status": "NOT_CONFIGURED", "role": "PRIMARY", "cadenceMs": 1800000 },
      { "id": "gdacs_events", "status": "LIVE", "role": "CROSS_CHECK", "cadenceMs": 1800000 }
    ]
  },
  "liveTelemetry": {
    "radar": {
      "maxGustSpeedKmH": 74.2,
      "corePressureHpa": 994,
      "station": "Machilipatnam Sector",
      "sourceId": "open_meteo_weather"
    },
    "seismic": {
      "maxRecordedMagnitude": 0,
      "totalEvents24h": 0,
      "latestEvent": "Quiet",
      "status": "NORMAL",
      "sourceId": "usgs_earthquakes"
    },
    "airQuality": {
      "sourceId": "open_meteo_air_quality",
      "role": "CROSS_CHECK",
      "aqi": 68,
      "pm25": 20.4,
      "status": "LIVE"
    }
  },
  "officialAlerts": [
    {
      "sourceId": "cap_imd",
      "capIdentifier": "IN-IMD-20260915-001",
      "agency": "India Meteorological Department",
      "severity": "Severe",
      "urgency": "Immediate",
      "headline": "Squall and Heavy Rainfall Advisory for North Andhra Coast",
      "geoMatch": "TEXT"
    }
  ],
  "topHabitationsAtRisk": [
    {
      "id": "VILL_001",
      "name": "Pedana Coastal Clusters",
      "district": "Krishna",
      "hazardType": "cyclone",
      "population": 18400,
      "priorityScore": 88.4,
      "priorityLevel": "CRITICAL",
      "allocatedShelter": "Krishna District Cyclone Shelter"
    }
  ],
  "capacitySummary": {
    "totalShelterCapacity": 28000,
    "currentOccupancy": 3200,
    "availableBeds": 24800,
    "criticalSheltersOver70Pct": []
  }
}
```

---

## 4. Multi-Tier AI Provider Hierarchy

When live telemetry criteria are satisfied, the recommendation pipeline executes turn-by-turn fallback:

1. **Local Ollama (DeepSeek-R1 / Qwen2.5)**:
   - High privacy, zero external cloud dependency.
   - Ideal for on-premise emergency response vehicles or disconnected command centers.
2. **Anthropic Claude 3.5 Sonnet**:
   - High-reasoning cloud fallback when `ANTHROPIC_API_KEY` is provided.
   - Structured JSON/markdown generation with zero hallucination constraints.
3. **Deterministic Operational Risk Analyst Engine**:
   - Zero-dependency mathematical fallback.
   - Evaluates weighted priority vectors from `js/priority-engine.js` (Hazard Severity, Population at Risk, Structural Vulnerability, Immediate Life Risk, Response Urgency, Accessibility).
   - Generates actionable orders for Andhra Pradesh habitations (`Pedana`, `Uppada`, `Machilipatnam`, `Kakinada`, etc.) referencing real designated cyclone centers.

---

## 5. Provenance Injection & Audit Trail

- **Input Tracing**: Every recommendation logged to disk (`ai_recommendations_audit.json`) carries:
  - Timestamp & generation latency.
  - Model ID & provider label.
  - Exact structured input parameters (top habitations, active deficits, sensor readings).
  - List of active source IDs backing the decision.
- **UI Attribution**: The authority interface displays the model name, confidence score, and clickable provenance badges linking directly to individual source telemetry streams.
