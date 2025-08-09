// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- MongoDB setup ----------
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI not set in .env');
  process.exit(1);
}

mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(()=> console.log('Connected to MongoDB'))
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

const deviceSchema = new mongoose.Schema({
  userAgent: String,
  language: String,
  languages: [String],
  platform: String,
  vendor: String,
  online: Boolean,
  cookieEnabled: Boolean,
  screen: {
    width: Number,
    height: Number,
    availWidth: Number,
    availHeight: Number,
    colorDepth: Number,
    pixelDepth: Number
  },
  timezone: String,
  hardwareConcurrency: Number,
  deviceMemory: mongoose.Schema.Types.Mixed,
  referrer: String,
  pageURL: String,
  ip: String,
  location: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now }
}, { strict: false });

const Device = mongoose.model('Device', deviceSchema);

// ---------- Helpers ----------
// Simple in-memory cache for IP lookups
const ipCache = new Map();
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

async function lookupIP(ip) {
  // Check cache first
  const cacheKey = ip || 'auto';
  const cached = ipCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
    console.log('Using cached location data for:', cacheKey);
    return cached.data;
  }

  // Multiple free services to try
  const services = [
    {
      name: 'ipapi.co',
      getUrl: (ip) => ip ? `https://ipapi.co/${ip}/json/` : 'https://ipapi.co/json/',
      timeout: 8000
    },
    {
      name: 'ip-api.com',
      getUrl: (ip) => ip ? `http://ip-api.com/json/${ip}` : 'http://ip-api.com/json/',
      timeout: 8000,
      transform: (data) => ({
        ip: data.query,
        city: data.city,
        region: data.regionName,
        region_code: data.region,
        country: data.country,
        country_name: data.country,
        country_code: data.countryCode,
        latitude: data.lat,
        longitude: data.lon,
        timezone: data.timezone,
        org: data.org || data.isp,
        postal: data.zip
      })
    },
    {
      name: 'ipinfo.io',
      getUrl: (ip) => ip ? `https://ipinfo.io/${ip}/json` : 'https://ipinfo.io/json',
      timeout: 8000,
      transform: (data) => ({
        ip: data.ip,
        city: data.city,
        region: data.region,
        country: data.country,
        country_name: data.country,
        latitude: data.loc ? parseFloat(data.loc.split(',')[0]) : null,
        longitude: data.loc ? parseFloat(data.loc.split(',')[1]) : null,
        org: data.org,
        postal: data.postal,
        timezone: data.timezone
      })
    }
  ];

  // Determine if we should use auto-detection
  const useAuto = !ip || ip === '::1' || ip === '127.0.0.1' || 
                  ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.');
  
  if (useAuto) {
    console.log('Using auto IP detection for local/private IP:', ip);
  } else {
    console.log('Looking up specific IP:', ip);
  }

  // Try each service
  for (const service of services) {
    try {
      const url = service.getUrl(useAuto ? null : ip);
      console.log(`Trying ${service.name}:`, url);
      
      const res = await fetch(url, { timeout: service.timeout });
      
      if (!res.ok) {
        if (res.status === 429) {
          console.warn(`${service.name} rate limited (429), trying next service...`);
          continue;
        }
        throw new Error(`${service.name} failed: ${res.status} ${res.statusText}`);
      }
      
      const json = await res.json();
      
      // Transform data if needed
      const locationData = service.transform ? service.transform(json) : json;
      
      console.log(`✅ ${service.name} success - Keys:`, Object.keys(locationData));
      console.log('Location sample:', {
        ip: locationData.ip,
        city: locationData.city,
        country: locationData.country_name || locationData.country,
        org: locationData.org
      });
      
      // Cache the result
      ipCache.set(cacheKey, {
        data: locationData,
        timestamp: Date.now()
      });
      
      return locationData;
      
    } catch (err) {
      console.warn(`${service.name} failed:`, err.message);
      continue;
    }
  }
  
  console.warn('All IP lookup services failed');
  return {};
}

function getClientIp(req) {
  // Prefer x-forwarded-for for deployments behind proxies/load balancers
  const forwarded = req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
  if (forwarded) {
    const ip = forwarded.split(',')[0].trim();
    console.log('IP from forwarded header:', ip);
    return ip;
  }
  
  // Try various sources for the IP
  const sources = [
    req.connection?.remoteAddress,
    req.socket?.remoteAddress,
    req.ip,
    req.headers['cf-connecting-ip'], // Cloudflare
    req.headers['x-forwarded-for'],
    req.headers['x-real-ip']
  ];
  
  for (const source of sources) {
    if (source) {
      const ip = source.replace(/^::ffff:/, '').trim();
      console.log('IP detected from source:', ip);
      return ip;
    }
  }
  
  console.log('No IP detected, will use auto-detection');
  return '';
}

// ---------- API ----------
app.post('/collect', async (req, res) => {
  try {
    const body = req.body || {};
    const detectedIp = getClientIp(req);
    
    console.log('--- New device collection request ---');
    console.log('Detected IP:', detectedIp);
    console.log('Request headers:', {
      'x-forwarded-for': req.headers['x-forwarded-for'],
      'x-real-ip': req.headers['x-real-ip'],
      'cf-connecting-ip': req.headers['cf-connecting-ip'],
      'user-agent': req.headers['user-agent']?.substring(0, 100) + '...'
    });

    const location = await lookupIP(detectedIp);
    console.log('Location data received keys:', Object.keys(location));
    console.log('Location data sample:', {
      ip: location.ip,
      city: location.city,
      country: location.country_name,
      latitude: location.latitude,
      longitude: location.longitude
    });
    
    // Use the IP from location data if available (more accurate for public IP)
    const finalIp = location.ip || detectedIp;
    
    const deviceData = {
      ...body,
      ip: finalIp,
      location: Object.keys(location).length > 0 ? location : null
    };

    console.log('Saving device data with location keys:', Object.keys(deviceData.location || {}));
    
    const doc = new Device(deviceData);
    const saved = await doc.save();
    
    console.log('Device data saved successfully with IP:', finalIp);
    console.log('Saved location keys:', Object.keys(saved.location || {}));

    // Return the stored document to the frontend
    res.json({ success: true, data: saved });

  } catch (err) {
    console.error('Error in /collect:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Optional endpoint to view last N captures (admin)
app.get('/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20'), 200);
    const docs = await Device.find().sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ success: true, count: docs.length, data: docs });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Hello endpoint for keep-alive
app.get('/hello', (req, res) => {
  res.json({ message: 'Hello! Server is alive', timestamp: new Date().toISOString() });
});

// Test location lookup endpoint
app.get('/test-location/:ip?', async (req, res) => {
  try {
    const testIp = req.params.ip || getClientIp(req);
    console.log('Testing location lookup for IP:', testIp);
    
    const location = await lookupIP(testIp);
    
    res.json({ 
      success: true, 
      testedIp: testIp,
      locationData: location,
      dataKeys: Object.keys(location),
      cacheSize: ipCache.size
    });
  } catch (err) {
    console.error('Test location error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Cache management endpoint
app.get('/cache-info', (req, res) => {
  const cacheInfo = Array.from(ipCache.entries()).map(([key, value]) => ({
    key,
    age: Math.round((Date.now() - value.timestamp) / 1000 / 60), // minutes
    hasData: Object.keys(value.data).length > 0
  }));
  
  res.json({
    size: ipCache.size,
    entries: cacheInfo
  });
});

app.post('/clear-cache', (req, res) => {
  ipCache.clear();
  res.json({ success: true, message: 'Cache cleared' });
});

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Keep-alive function to prevent Render free tier from sleeping
function keepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  
  setInterval(async () => {
    try {
      console.log('🏓 Pinging server to keep alive...');
      const response = await fetch(`${url}/hello`);
      const data = await response.json();
      console.log('✅ Keep-alive ping successful:', data.message);
    } catch (error) {
      console.warn('⚠️ Keep-alive ping failed:', error.message);
    }
  }, 10 * 60 * 1000); // Ping every 10 minutes
}

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  
  // Start keep-alive only in production (not during development)
  if (process.env.NODE_ENV === 'production' || process.env.RENDER_EXTERNAL_URL) {
    console.log('🚀 Starting keep-alive mechanism...');
    keepAlive();
  }
});
