# Device Collector

A Node.js application that collects device and network information from visitors and stores it in MongoDB.

## Features

- Collects browser and device information
- IP geolocation lookup
- MongoDB storage
- Real-time data display
- Keep-alive mechanism for free hosting

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file with your MongoDB URI:
   ```
   PORT=3000
   MONGODB_URI=your_mongodb_connection_string
   IPAPI_BASE=https://ipapi.co
   ```

3. Start the server:
   ```bash
   npm start
   ```

4. Open http://localhost:3000 in your browser

## Deployment to Render

1. Push your code to GitHub
2. Connect your GitHub repository to Render
3. Set the following environment variables in Render:
   - `MONGODB_URI`: Your MongoDB connection string
   - `NODE_ENV`: production
   - `RENDER_EXTERNAL_URL`: Your Render app URL (set after first deployment)

The app includes a keep-alive mechanism that pings itself every 10 minutes to prevent the free tier from sleeping.

## API Endpoints

- `GET /` - Main page with device collection interface
- `POST /collect` - Collect and store device information
- `GET /recent` - View recent device collections (limit parameter available)
- `GET /health` - Health check endpoint
- `GET /hello` - Keep-alive endpoint
