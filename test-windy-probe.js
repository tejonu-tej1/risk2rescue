const https = require('https');


const key = process.env.WINDY_DATA_KEY;
const url = 'https://api.windy.com/api/point-forecast/v2';
const payload = JSON.stringify({
  lat: 16.99,
  lon: 82.25,
  model: 'gfs',
  parameters: ['temp', 'wind', 'windGust'],
  levels: ['surface'],
  key: key
});

const req = https.request(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('--- RAW JSON RESPONSE ---');
    console.log(data.substring(0, 500) + (data.length > 500 ? '...\n[TRUNCATED]' : ''));
    
    try {
      const json = JSON.parse(data);
      console.log('\njson.ts type:', typeof json.ts, Array.isArray(json.ts) ? 'Array' : 'Not Array');
      console.log('json.ts value:', JSON.stringify(json.ts).substring(0, 100));
      
      const observedAt = json.ts ? new Date(json.ts).toISOString() : null;
      console.log('observedAt:', observedAt);
    } catch (e) {
      console.log('\n--- ERROR / STACK TRACE ---');
      console.error(e.stack);
    }
  });
});

req.on('error', e => console.error(e));
req.write(payload);
req.end();
