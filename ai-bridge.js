/**
 * RISK2RESCUE — AI BRIDGE (ai-bridge.js)
 * Typed interface & proxy client connecting Node.js Command Hub to FastAPI GeoAI Microservice
 * 
 * Target Service: FastAPI at process.env.AI_SERVICE_URL (default: http://127.0.0.1:8001)
 * Features:
 * - Evidence-grounded DeepSeek-R1 / LangChain decision briefs
 * - TerraMind base flood model status probe
 * - Minimum live sources enforcement (anti-hallucination guard)
 */

const http = require('http');

const AI_SERVICE_BASE_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:8001';
const MIN_LIVE_SOURCES_FOR_AI = parseInt(process.env.MIN_LIVE_SOURCES_FOR_AI, 10) || 3;

function requestPost(pathName, payloadObj, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(pathName, AI_SERVICE_BASE_URL);
      const dataStr = JSON.stringify(payloadObj || {});
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 8001,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(dataStr)
        },
        timeout: timeoutMs
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              resolve({ raw: body });
            }
          } else {
            reject(new Error(`GeoAI HTTP ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`GeoAI request timed out after ${timeoutMs}ms`));
      });

      req.write(dataStr);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function requestGet(pathName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(pathName, AI_SERVICE_BASE_URL);
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 8001,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        timeout: timeoutMs
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              resolve({ raw: body });
            }
          } else {
            reject(new Error(`GeoAI HTTP ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`GeoAI request timed out after ${timeoutMs}ms`));
      });
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

const AIBridge = {
  MIN_LIVE_SOURCES_FOR_AI,

  /**
   * Health probe for FastAPI microservice
   */
  async getHealth() {
    return await requestGet('/health', 3000);
  },

  /**
   * Status probe for TerraMind foundation flood model
   */
  async getTerraMindStatus() {
    return await requestGet('/terramind/status', 3000);
  },

  /**
   * Request evidence-grounded LangChain test prompt execution
   * @param {string} prompt
   */
  async executeLangChainPrompt(prompt) {
    return await requestPost('/ai/langchain-test', { prompt }, 20000);
  },

  /**
   * Trigger Task 17 Evidence-Grounded Decision Brief from DeepSeek-R1 in FastAPI
   */
  async generateDecisionBrief() {
    return await requestPost('/ai/decision-brief', {}, 60000);
  }
};

module.exports = AIBridge;
