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
  // Basic info
  userAgent: String,
  language: String,
  languages: [String],
  platform: String,
  vendor: String,
  online: Boolean,
  cookieEnabled: Boolean,
  timezone: String,
  referrer: String,
  pageURL: String,
  collectionTimestamp: Date,
  
  // Screen and display
  screen: {
    width: Number,
    height: Number,
    availWidth: Number,
    availHeight: Number,
    colorDepth: Number,
    pixelDepth: Number,
    pixelRatio: Number,
    orientation: mongoose.Schema.Types.Mixed
  },
  
  // Viewport
  viewport: {
    width: Number,
    height: Number,
    outerWidth: Number,
    outerHeight: Number
  },
  
  // Hardware capabilities
  hardware: {
    hardwareConcurrency: Number,
    deviceMemory: Number,
    maxTouchPoints: Number,
    webdriver: Boolean
  },
  
  // Network information
  network: {
    connection: mongoose.Schema.Types.Mixed,
    onLine: Boolean
  },
  
  // Browser capabilities
  browserCapabilities: {
    javaEnabled: Boolean,
    plugins: [mongoose.Schema.Types.Mixed],
    mimeTypes: [String],
    doNotTrack: String,
    globalPrivacyControl: Boolean
  },
  
  // Storage capabilities
  storage: {
    localStorage: Boolean,
    sessionStorage: Boolean,
    indexedDB: Boolean,
    webSQL: Boolean
  },
  
  // Performance info
  performance: {
    timing: mongoose.Schema.Types.Mixed,
    memory: mongoose.Schema.Types.Mixed
  },
  
  // Graphics and WebGL
  graphics: mongoose.Schema.Types.Mixed,
  
  // Audio context
  audio: mongoose.Schema.Types.Mixed,
  
  // Canvas info
  canvas: mongoose.Schema.Types.Mixed,
  
  // Feature detection
  features: mongoose.Schema.Types.Mixed,
  
  // Server-detected info
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

  // Try each service
  for (const service of services) {
    try {
      const url = service.getUrl(useAuto ? null : ip);
      const res = await fetch(url, { timeout: service.timeout });
      
      if (!res.ok) {
        if (res.status === 429) {
          console.warn(`${service.name} rate limited, trying next service...`);
          continue;
        }
        throw new Error(`${service.name} failed: ${res.status}`);
      }
      
      const json = await res.json();
      const locationData = service.transform ? service.transform(json) : json;
      
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
    return forwarded.split(',')[0].trim();
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
      return source.replace(/^::ffff:/, '').trim();
    }
  }
  
  return '';
}

// ---------- API ----------
app.post('/collect', async (req, res) => {
  try {
    const body = req.body || {};
    const detectedIp = getClientIp(req);
    
    const location = await lookupIP(detectedIp);
    
    // Use the IP from location data if available (more accurate for public IP)
    const finalIp = location.ip || detectedIp;
    
    const deviceData = {
      ...body,
      ip: finalIp,
      location: Object.keys(location).length > 0 ? location : null
    };
    
    const doc = new Device(deviceData);
    const saved = await doc.save();
    
    console.log(`Device collected: ${finalIp} from ${location.city || 'Unknown'}, ${location.country_name || 'Unknown'}`);

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

// Analytics endpoint for device statistics
app.get('/analytics', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '1000'), 5000);
    const docs = await Device.find().sort({ createdAt: -1 }).limit(limit).lean();
    
    const analytics = {
      totalDevices: docs.length,
      timeRange: {
        from: docs[docs.length - 1]?.createdAt,
        to: docs[0]?.createdAt
      },
      platforms: {},
      browsers: {},
      countries: {},
      cities: {},
      screenResolutions: {},
      operatingSystems: {},
      languages: {},
      connectionTypes: {},
      features: {
        webRTC: 0,
        webAssembly: 0,
        serviceWorker: 0,
        webGL: 0,
        touchDevice: 0
      },
      hardware: {
        totalMemory: [],
        cpuCores: {},
        pixelRatios: {}
      }
    };
    
    docs.forEach(doc => {
      // Platform analysis
      if (doc.platform) {
        analytics.platforms[doc.platform] = (analytics.platforms[doc.platform] || 0) + 1;
      }
      
      // Browser analysis from user agent
      if (doc.userAgent) {
        let browser = 'Unknown';
        if (doc.userAgent.includes('Chrome')) browser = 'Chrome';
        else if (doc.userAgent.includes('Firefox')) browser = 'Firefox';
        else if (doc.userAgent.includes('Safari')) browser = 'Safari';
        else if (doc.userAgent.includes('Edge')) browser = 'Edge';
        analytics.browsers[browser] = (analytics.browsers[browser] || 0) + 1;
        
        // OS detection
        let os = 'Unknown';
        if (doc.userAgent.includes('Windows')) os = 'Windows';
        else if (doc.userAgent.includes('Mac')) os = 'macOS';
        else if (doc.userAgent.includes('Linux')) os = 'Linux';
        else if (doc.userAgent.includes('Android')) os = 'Android';
        else if (doc.userAgent.includes('iOS')) os = 'iOS';
        analytics.operatingSystems[os] = (analytics.operatingSystems[os] || 0) + 1;
      }
      
      // Location analysis
      if (doc.location) {
        const country = doc.location.country_name || doc.location.country;
        const city = doc.location.city;
        if (country) {
          analytics.countries[country] = (analytics.countries[country] || 0) + 1;
        }
        if (city) {
          analytics.cities[city] = (analytics.cities[city] || 0) + 1;
        }
      }
      
      // Screen resolution analysis
      if (doc.screen?.width && doc.screen?.height) {
        const resolution = `${doc.screen.width}x${doc.screen.height}`;
        analytics.screenResolutions[resolution] = (analytics.screenResolutions[resolution] || 0) + 1;
      }
      
      // Language analysis
      if (doc.language) {
        analytics.languages[doc.language] = (analytics.languages[doc.language] || 0) + 1;
      }
      
      // Connection type analysis
      if (doc.network?.connection?.effectiveType) {
        const connType = doc.network.connection.effectiveType;
        analytics.connectionTypes[connType] = (analytics.connectionTypes[connType] || 0) + 1;
      }
      
      // Feature analysis
      if (doc.features) {
        if (doc.features.webRTC) analytics.features.webRTC++;
        if (doc.features.webAssembly) analytics.features.webAssembly++;
        if (doc.features.serviceWorker) analytics.features.serviceWorker++;
        if (doc.graphics) analytics.features.webGL++;
        if (doc.hardware?.maxTouchPoints > 0) analytics.features.touchDevice++;
      }
      
      // Hardware analysis
      if (doc.hardware?.deviceMemory) {
        analytics.hardware.totalMemory.push(doc.hardware.deviceMemory);
      }
      if (doc.hardware?.hardwareConcurrency) {
        const cores = doc.hardware.hardwareConcurrency;
        analytics.hardware.cpuCores[cores] = (analytics.hardware.cpuCores[cores] || 0) + 1;
      }
      if (doc.screen?.pixelRatio) {
        const ratio = doc.screen.pixelRatio;
        analytics.hardware.pixelRatios[ratio] = (analytics.hardware.pixelRatios[ratio] || 0) + 1;
      }
    });
    
    // Sort and limit top results
    const sortAndLimit = (obj, limit = 10) => {
      return Object.entries(obj)
        .sort(([,a], [,b]) => b - a)
        .slice(0, limit)
        .reduce((r, [k, v]) => ({ ...r, [k]: v }), {});
    };
    
    analytics.platforms = sortAndLimit(analytics.platforms);
    analytics.browsers = sortAndLimit(analytics.browsers);
    analytics.countries = sortAndLimit(analytics.countries);
    analytics.cities = sortAndLimit(analytics.cities);
    analytics.screenResolutions = sortAndLimit(analytics.screenResolutions);
    analytics.operatingSystems = sortAndLimit(analytics.operatingSystems);
    analytics.languages = sortAndLimit(analytics.languages);
    analytics.connectionTypes = sortAndLimit(analytics.connectionTypes);
    
    res.json({ success: true, analytics });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
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
      const response = await fetch(`${url}/hello`);
      const data = await response.json();
      console.log('✅ Keep-alive successful');
    } catch (error) {
      console.warn('⚠️ Keep-alive failed:', error.message);
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
