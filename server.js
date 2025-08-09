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
async function lookupIP(ip) {
  // Use ipapi.co as example. For production get an API key / paid tier.
  const base = process.env.IPAPI_BASE || 'https://ipapi.co';
  try {
    // ipapi supports /json/ for auto; using specific ip for clarity
    const url = `${base}/${ip}/json/`;
    const res = await fetch(url, { timeout: 5000 });
    if (!res.ok) throw new Error(`Geo lookup failed: ${res.status}`);
    const json = await res.json();
    return json;
  } catch (err) {
    console.warn('IP lookup failed:', err.message || err);
    return {};
  }
}

function getClientIp(req) {
  // Prefer x-forwarded-for for deployments behind proxies/load balancers
  const forwarded = req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
  if (forwarded) return forwarded.split(',')[0].trim();
  if (req.connection && req.connection.remoteAddress) return req.connection.remoteAddress;
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  if (req.ip) return req.ip;
  return '';
}

// ---------- API ----------
app.post('/collect', async (req, res) => {
  try {
    const body = req.body || {};
    const ip = getClientIp(req).replace(/^::ffff:/, '') || '';

    const location = await lookupIP(ip || ''); // if ip empty, ipapi will use caller IP (server IP), so handle accordingly

    const doc = new Device({
      ...body,
      ip,
      location
    });

    const saved = await doc.save();

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
