// server.js - Main application file
const express = require('express');
const SpotifyWebApi = require('spotify-web-api-node');
const axios = require('axios');
const cors = require('cors');
const session = require('express-session');
const Vibrant = require('node-vibrant');
const WebSocket = require('ws');
const { createServer } = require('http');
const path = require('path');
require('dotenv').config();

// Initialize Express app
const app = express();
const httpServer = createServer(app);
const wss = new WebSocket.Server({ server: httpServer });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'spotify-wled-sync-secret',
  resave: false,
  saveUninitialized: true
}));

// Spotify API configuration
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.REDIRECT_URI || 'http://localhost:3000/callback'
});

// WLED configuration
const wledIp = process.env.WLED_IP || '192.168.1.100';
const wledApiUrl = `http://${wledIp}/json`;

// Store for active websocket connections
const clients = new Set();

// Websocket connection handler
wss.on('connection', (ws) => {
  clients.add(ws);
  
  ws.on('close', () => {
    clients.delete(ws);
  });
});

// Broadcast updates to all connected clients
function broadcastUpdate(data) {
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Auth routes
app.get('/login', (req, res) => {
  const scopes = ['user-read-private', 'user-read-email', 'user-read-currently-playing', 'user-read-playback-state'];
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes);
  res.redirect(authorizeURL);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  
  try {
    const data = await spotifyApi.authorizationCodeGrant(code);
    
    // Save tokens to session
    req.session.accessToken = data.body.access_token;
    req.session.refreshToken = data.body.refresh_token;
    req.session.expiresIn = data.body.expires_in;
    
    spotifyApi.setAccessToken(data.body.access_token);
    spotifyApi.setRefreshToken(data.body.refresh_token);
    
    res.redirect('/');
  } catch (error) {
    console.error('Error getting tokens:', error);
    res.redirect('/?error=auth_failed');
  }
});

// API routes
app.get('/api/current-track', async (req, res) => {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  spotifyApi.setAccessToken(req.session.accessToken);
  
  try {
    const data = await spotifyApi.getMyCurrentPlaybackState();
    
    if (!data.body || !data.body.item) {
      await setWledToDefault();
      return res.json({ 
        isPlaying: false, 
        defaultModeActive: true 
      });
    }
    
    const track = data.body.item;
    const albumArt = track.album.images[0].url;
    
    // Extract colors from album art
    const palette = await Vibrant.from(albumArt).getPalette();
    
    // Prepare color data
    const colors = {
      vibrant: palette.Vibrant ? palette.Vibrant.hex : '#FFFFFF',
      darkVibrant: palette.DarkVibrant ? palette.DarkVibrant.hex : '#000000',
      lightVibrant: palette.LightVibrant ? palette.LightVibrant.hex : '#FFFFFF',
      muted: palette.Muted ? palette.Muted.hex : '#888888',
      darkMuted: palette.DarkMuted ? palette.DarkMuted.hex : '#444444',
      lightMuted: palette.LightMuted ? palette.LightMuted.hex : '#BBBBBB'
    };
    
    // Update WLED with extracted colors
    const isPlaying = data.body.is_playing;
    if (isPlaying) {
      await updateWledColors(colors);
    } else {
      await setWledToDefault();
    }
    
    // Broadcast track update to all clients
    broadcastUpdate({
      isPlaying,
      trackInfo: {
        name: track.name,
        artist: track.artists.map(a => a.name).join(', '),
        album: track.album.name,
        albumArt,
        colors
      }
    });
    
    res.json({
      isPlaying,
      name: track.name,
      artist: track.artists.map(a => a.name).join(', '),
      album: track.album.name,
      albumArt,
      colors
    });
  } catch (error) {
    console.error('Error fetching current track:', error);
    
    // Token might be expired, try refreshing
    if (req.session.refreshToken) {
      try {
        const refreshData = await spotifyApi.refreshAccessToken();
        req.session.accessToken = refreshData.body.access_token;
        spotifyApi.setAccessToken(refreshData.body.access_token);
        
        // Retry after refresh
        return res.redirect('/api/current-track');
      } catch (refreshError) {
        console.error('Error refreshing token:', refreshError);
        return res.status(401).json({ error: 'Authentication expired' });
      }
    }
    
    res.status(500).json({ error: 'Failed to fetch track data' });
  }
});

app.get('/api/user', async (req, res) => {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  spotifyApi.setAccessToken(req.session.accessToken);
  
  try {
    const userData = await spotifyApi.getMe();
    res.json(userData.body);
  } catch (error) {
    console.error('Error fetching user data:', error);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

app.get('/api/wled/status', async (req, res) => {
  try {
    const response = await axios.get(wledApiUrl);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching WLED status:', error);
    res.status(500).json({ error: 'Failed to fetch WLED status' });
  }
});

app.post('/api/wled/toggle-audio-reactive', async (req, res) => {
  const { enabled, colors } = req.body;
  
  try {
    if (enabled) {
      await enableAudioReactive(colors);
      res.json({ success: true, mode: 'audio-reactive' });
    } else {
      // Return to standard color mode with current colors
      await updateWledColors(colors);
      res.json({ success: true, mode: 'standard' });
    }
  } catch (error) {
    console.error('Error toggling audio reactive mode:', error);
    res.status(500).json({ error: 'Failed to toggle audio reactive mode' });
  }
});

// WLED control functions
async function updateWledColors(colors) {
  try {
    // Create a dynamic palette from the album colors
    const colorData = [
      parseInt(colors.vibrant.substring(1), 16),
      parseInt(colors.darkVibrant.substring(1), 16),
      parseInt(colors.lightVibrant.substring(1), 16)
    ];
    
    // Configure a gentle animation based on the colors
    const wledConfig = {
      on: true,
      bri: 255,
      seg: [
        {
          id: 0,
          col: [
            [
              parseInt(colors.vibrant.substring(1, 3), 16),
              parseInt(colors.vibrant.substring(3, 5), 16),
              parseInt(colors.vibrant.substring(5, 7), 16)
            ],
            [
              parseInt(colors.darkVibrant.substring(1, 3), 16),
              parseInt(colors.darkVibrant.substring(3, 5), 16),
              parseInt(colors.darkVibrant.substring(5, 7), 16)
            ],
            [
              parseInt(colors.lightVibrant.substring(1, 3), 16),
              parseInt(colors.lightVibrant.substring(3, 5), 16),
              parseInt(colors.lightVibrant.substring(5, 7), 16)
            ]
          ],
          fx: 16, // Breathing effect that pulses gently with the music
          sx: 128, // Medium speed
          ix: 128, // Medium intensity
          pal: 0
        }
      ]
    };
    
    await axios.post(wledApiUrl, wledConfig);
    return true;
  } catch (error) {
    console.error('Error updating WLED colors:', error);
    return false;
  }
}

async function setWledToDefault() {
  try {
    // Default gentle breathing animation with soft white
    const defaultConfig = {
      on: true,
      bri: 128,
      seg: [
        {
          id: 0,
          col: [[255, 240, 230]], // Warm white
          fx: 2, // Gentle breathing
          sx: 100, // Slow speed
          ix: 90, // Low intensity
          pal: 0
        }
      ]
    };
    
    await axios.post(wledApiUrl, defaultConfig);
    
    // Broadcast default mode to clients
    broadcastUpdate({
      isPlaying: false,
      defaultModeActive: true
    });
    
    return true;
  } catch (error) {
    console.error('Error setting WLED to default:', error);
    return false;
  }
}

async function enableAudioReactive(colors) {
  try {
    // Extract RGB values from hex colors
    const vibrantRGB = [
      parseInt(colors.vibrant.substring(1, 3), 16),
      parseInt(colors.vibrant.substring(3, 5), 16),
      parseInt(colors.vibrant.substring(5, 7), 16)
    ];
    
    const darkVibrantRGB = [
      parseInt(colors.darkVibrant.substring(1, 3), 16),
      parseInt(colors.darkVibrant.substring(3, 5), 16),
      parseInt(colors.darkVibrant.substring(5, 7), 16)
    ];
    
    // Configure sound reactive mode with album colors
    const soundReactiveConfig = {
      on: true,
      bri: 255,
      seg: [
        {
          id: 0,
          col: [vibrantRGB, darkVibrantRGB],
          fx: 32, // Sound reactive mode - visualize audio (if WLED has Sound Reactive firmware)
          sx: 160, // Higher sensitivity
          ix: 190, // Higher intensity
          pal: 0
        }
      ]
    };
    
    await axios.post(wledApiUrl, soundReactiveConfig);
    return true;
  } catch (error) {
    console.error('Error enabling audio reactive mode:', error);
    return false;
  }
}

// Start polling for track changes
let pollingInterval;

function startPolling() {
  if (pollingInterval) clearInterval(pollingInterval);
  
  pollingInterval = setInterval(async () => {
    try {
      // This will hit our own API endpoint which handles all the logic
      await axios.get(`http://localhost:${port}/api/current-track`);
    } catch (error) {
      console.error('Polling error:', error);
    }
  }, 3000); // Check every 3 seconds
}

// Serve the frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`Server running on port ${port}`);
  startPolling();
});