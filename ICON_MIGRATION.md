# Risk2Rescue — Icon System Migration Report

## 1. Executive Summary & Philosophy

Risk2Rescue (R2R) previously relied on mixed unicode emojis (e.g. 🏠, 🗺️, 🛰️, ⚠️, 🚨, 🌀, 🌊, 🏛️, 🧑‍💼) across its authority dashboards and citizen GIS views. While convenient for early prototyping, unicode emojis suffer from:
- Operating system inconsistencies (rendering vastly different visual designs and line weights on macOS, Windows, Linux, iOS, and Android).
- Inability to dynamically switch weights (regular vs. bold) between inactive and active states.
- Visual clutter and lack of monochrome professional GIS command-center aesthetics.

To solve this, R2R has migrated completely to **Uicons by Flaticon** using:
- **Regular Rounded (`fi-rr-*`)** for default/inactive elements.
- **Bold Rounded (`fi-br-*`)** for active/selected/emphasized navigation items and priority alerts.
- **Offline-first vendoring** so that the application functions 100% offline during disaster scenarios without external font CDN dependencies.

---

## 2. Offline-First Asset Architecture

All icon stylesheets and webfont binaries are vendored directly inside the project repository under `assets/uicons/`:

```
assets/uicons/
├── css/
│   ├── uicons-regular-rounded.css
│   └── uicons-bold-rounded.css
└── webfonts/
    ├── uicons-regular-rounded.woff2
    ├── uicons-regular-rounded.woff
    ├── uicons-regular-rounded.eot
    ├── uicons-bold-rounded.woff2
    ├── uicons-bold-rounded.woff
    └── uicons-bold-rounded.eot
```

### Font URL Rebasing
The CSS `@font-face` definitions were adjusted from package-relative paths to `../webfonts/`, ensuring that when loaded from `assets/uicons/css/`, they accurately reference the local webfonts without generating HTTP 404s or triggering third-party font requests.

---

## 3. Central Icon Registry (`js/icons.js`) & Helper

A single source of truth was established at [`js/icons.js`](file:///Users/srimudunuri/Desktop/R2R-F5/R2R-F5/R2R-F5/js/icons.js) with Universal Module Definition (UMD) compatibility for browser globals (`window.ICONS`, `window.iconHtml`) and Node.js (`module.exports`):

```javascript
// Helper for generating accessible Uicons HTML
iconHtml(iconClass, extraClasses = '', ariaLabel = '')
```
- When `ariaLabel` is omitted, the `<i>` tag receives `aria-hidden="true"`.
- When `ariaLabel` is provided (e.g. standalone icon buttons), it receives `role="img" aria-label="..."`.

### Dynamic Dock Icon Synchronization (`syncDockIcons`)
In [`js/authority.js`](file:///Users/srimudunuri/Desktop/R2R-F5/R2R-F5/R2R-F5/js/authority.js), `syncDockIcons()` is integrated into `switchView(viewName)` and exported to `window.syncDockIcons`. It inspects each `.dock-item` in `#rzi-dock`:
- If `.dock-item` is `.active`, its icon class switches to `data-active-icon` (e.g. `fi-br-home`).
- If inactive, its icon class resets to `data-icon` (e.g. `fi-rr-home`).

---

## 4. Comprehensive Emoji to Uicons Mapping Table

| Old Emoji | Uicons Regular (`fi-rr-*`) | Uicons Bold (`fi-br-*`) | Semantic Role | Component / File | Substitution & Icon Set Notes |
|:---:|:---|:---|:---|:---|:---|
| 🏠 | `fi-rr-home` | `fi-br-home` | Nav: Home Command Center | Dock (`#rzi-dock`) in all 6 authority shells | Exact match in Uicons regular & bold |
| 🎛️ / ⚙️ | `fi-rr-settings-sliders` | `fi-br-settings-sliders` | Nav: Command Console | Dock (`#rzi-dock`) | Clean monochrome sliders |
| 🏘️ | `fi-rr-house-building` | `fi-br-house-building` | Nav: Habitations / Priority Queue | Dock (`#rzi-dock`) | Replaced multihouse emoji with house-building glyph |
| 🗺️ | `fi-rr-map` | `fi-br-map` | Nav / Basemap / Return | Dock, Topbar Basemap switchers, Return-to-map buttons | Universal GIS map icon |
| ⚠️ | `fi-rr-triangle-warning` | `fi-br-triangle-warning` | Warning / Active Hazards | Dock, Floating Hazard Button, Dropdown header | Clean triangle alert glyph |
| 📥 | `fi-rr-inbox-in` | `fi-br-inbox-in` | Nav: Citizen Dispatch Queue | Dock (`#rzi-dock`) | Inbox dispatch container glyph |
| 🏕️ | `fi-rr-person-shelter` | `fi-br-person-shelter` | Nav: Safe Sites & Capacity | Dock (`#rzi-dock`) | `tent` is not in Uicons free set; `person-shelter` is the standard humanitarian safe-site glyph |
| 🤖 | `fi-rr-robot` | `fi-br-robot` | Nav: AI Decision Support | Dock (`#rzi-dock`) | Futuristic AI assistance glyph |
| 🛰️ | `fi-rr-satellite-dish` / `fi-rr-satellite` | `fi-br-satellite-dish` / `fi-br-satellite` | Nav: Data Feeds / Satellite Basemap | Dock (`satellite-dish`), Basemap toggle (`satellite`) | Specific dish vs orbiting satellite distinction |
| 🌀 | `fi-rr-tornado` | `fi-br-tornado` | Cyclone / High Wind Hazard | `js/hazards.js`, `js/authority.js`, `js/citizen.js` | High-impact vortex line art |
| 🌊 | `fi-rr-wave` | `fi-br-wave` | Storm Surge / Tsunami | `js/hazards.js`, `js/authority.js` | `waves` does not exist in Uicons free set; `wave` is used |
| 🌧️ / ⛈️ | `fi-rr-cloud-showers-heavy` | `fi-br-cloud-showers-heavy` | Flash Flood / Rain Hazard | `js/hazards.js`, `js/data.js`, `js/citizen.js` | Cloud with heavy rain droplets |
| 🌋 | `fi-rr-mountain` | `fi-br-mountain` | Landslide / Mountain Risk | `js/hazards.js` | Steep terrain ridge glyph |
| ⚡ | `fi-rr-bolt` | `fi-br-bolt` | Earthquake Seismic Spike | `js/hazards.js` | High voltage/seismic impulse line |
| 🏭 | `fi-rr-factory` | `fi-br-factory` | Industrial Hazard | `js/hazards.js` | Industrial facility silhouette |
| 🔥 | `fi-rr-flame` | `fi-br-flame` | Forest Fire / Wildfire | `js/hazards.js` | Clean fire flame glyph |
| 🌤️ / ☀️ | `fi-rr-sun` / `fi-rr-cloud-sun` | `fi-br-sun` / `fi-br-cloud-sun` | Sunny / Partly Cloudy | `js/data.js`, `js/citizen.js`, `js/windy-integration.js` | Weather telemetry chips |
| ⛈️ | `fi-rr-thunderstorm` | `fi-br-thunderstorm` | Severe Thunderstorm | `js/data.js`, `js/citizen.js` | Replaces bolt/cloud combinations |
| 💨 | `fi-rr-wind` | `fi-br-wind` | Wind / High Gusts | `js/data.js`, `js/citizen.js`, `js/windy-integration.js` | Wind stream lines |
| 📡 | `fi-rr-radar` | `fi-br-radar` | Windy Weather Radar Layer | `js/map.js` (`LAYER_CONFIG`) | Scanning radar display |
| ⛰️ | `fi-rr-mountains` | `fi-br-mountains` | Elevation Topo Layer | `js/map.js` (`LAYER_CONFIG`) | Topographic contour lines & peaks |
| 🔍 | `fi-rr-search` | `fi-br-search` | Location / Zone Search | Topbars across `authority*.html` and `citizen.html` | Search magnifying glass |
| 📍 | `fi-rr-marker` | `fi-br-marker` | My GPS Location Button | Bottom-left dock in `citizen.html` | Pin map marker |
| 📢 | `fi-rr-bullhorn` | `fi-br-bullhorn` | Issue Alert / Citizen Report | Topbar actions, report problem modal | Megaphone / broadcast horn |
| 🚨 | `fi-rr-alarm-exclamation` | `fi-br-alarm-exclamation` | SOS / Emergency Banner | Emergency SOS button, live broadcast alert | `siren` is not in free set; `alarm-exclamation` provides identical emergency semantics |
| 🚶 / 🏃 | `fi-rr-running` | `fi-br-running` | Evacuation Route ("Show me way out") | Inspector in `citizen.html` | Evacuation running figure |
| 🛡️ | `fi-rr-shield-check` | `fi-br-shield-check` | Map Legend Tiers / Auth Emblem | Map legend header in all authority shells, login emblems | Shield with security checkmark |
| 🏛️ | `fi-rr-building` | `fi-br-building` | Authority Command Portal | Navigation popover in `index.html`, `authority-login.html` | Classical governmental building facade |
| 🧑‍💼 | `fi-rr-user` | `fi-br-user` | Citizen Portal | Navigation popover in `index.html` | Citizen/user profile avatar |
| 🌐 | `fi-rr-globe` | `fi-br-globe` | Language Switcher | Header in `portal.html` | World globe glyph |
| 🧠 | `fi-rr-brain` | `fi-br-brain` | Decision Support Brief | Topbar action in authority shells | Cognitive AI decision support |
| ➔ / 🗺️ | `fi-rr-arrow-small-left` | `fi-br-arrow-small-left` | Back to Live GIS Map | View overlay close button in all authority shells | Smooth left navigational arrow |

---

## 5. Attribution Compliance

In full compliance with Flaticon's license requirements for web applications, attribution has been incorporated in the UI across all pages:

- **Authority Dashboards** (`authority.html`, `authority-map.html`, `authority-capacity.html`, `authority-ai.html`, `authority-queue.html`, `authority-citizen.html`):
  - In the Dock Profile Panel beneath the Sign Out button:
    `Icons: Uicons by <a href="https://www.flaticon.com/uicons" target="_blank" rel="noopener">Flaticon</a>`
  - In the collapsible Map Legend footer:
    `Icons: Uicons by <a href="https://www.flaticon.com/uicons" target="_blank" rel="noopener">Flaticon</a>`
- **Citizen Intelligence Map** (`citizen.html`):
  - At the base of the Inspector drawer.
- **Index Landing Page** (`index.html`):
  - Inside the sliding Verified Authoritative Data Feeds drawer in the footer.
- **Portal Gateway** (`portal.html`):
  - In the footer navigation links row.
- **Officer Login** (`authority-login.html`):
  - In the security & compliance notice footer.

---

## 6. Verification & Regression Testing

1. **Font Loading & Offline Verification**:
   - HTTP GET requests to `assets/uicons/css/uicons-regular-rounded.css` and `assets/uicons/css/uicons-bold-rounded.css` return HTTP 200.
   - Webfont binaries (`assets/uicons/webfonts/uicons-regular-rounded.woff2`, `uicons-bold-rounded.woff2`) load locally with 0 external network requests.
2. **Dynamic Weight Switching**:
   - Switching views via `switchView('habitations')`, `switchView('decision-support')`, etc. invokes `syncDockIcons()`, correctly converting the target dock item's icon from `fi-rr-*` to `fi-br-*` while restoring previous items to `fi-rr-*`.
3. **Full Regression Suite**:
   - All 19 test suites (`test_task8.js` through `test_task26.js`) executed via `scratch/run_all_regressions.js`.
   - **Result**: **2192 / 2192 assertions passing (100% pass rate, 0 failures, exit 0)**.
