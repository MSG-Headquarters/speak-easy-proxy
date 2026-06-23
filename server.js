const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3100;

// Your Anthropic API key - set this as a Railway environment variable
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY environment variable is required');
  process.exit(1);
}

// ElevenLabs text-to-speech (Luna's voice). Key is set as a Railway environment variable.
// To change Luna's voice or TTS model later, edit these two constants — one-line change each.
const ELEVENLABS_VOICE_ID = 'gJx1vCzNCD1EQHT212Ls'; // Ava
const ELEVENLABS_MODEL_ID = 'eleven_multilingual_v2'; // bidirectional es<->en, multilingual required
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// Warn but don't exit if the TTS key is missing — /api/chat must keep working without it.
if (!ELEVENLABS_API_KEY) {
  console.warn('⚠️ ELEVENLABS_API_KEY not set — /api/tts will return 500 until it is configured');
}

// CORS - allow your GitHub Pages domain
const ALLOWED_ORIGINS = [
  'https://www.umbrassi.com',
  'https://umbrassi.com',
  'https://msg-headquarters.github.io',
  'http://localhost:3000',
  'http://localhost:5173',
  'null', // for local file:// testing
];

// Any localhost/127.0.0.1 origin on any port — covers Vite landing on 5174+ in dev.
const LOCALHOST_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin || ALLOWED_ORIGINS.includes(origin) || LOCALHOST_ORIGIN.test(origin)) {
      callback(null, true);
    } else {
      console.log(`⚠️ Blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json({ limit: '1mb' }));

// Rate limiting - simple in-memory (per IP, 30 requests per minute)
const rateLimitMap = new Map();
const RATE_LIMIT = 30;
const RATE_WINDOW = 60 * 1000; // 1 minute

function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.ip;
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record || now - record.windowStart > RATE_WINDOW) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return next();
  }

  if (record.count >= RATE_LIMIT) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }

  record.count++;
  return next();
}

// Clean up rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now - record.windowStart > RATE_WINDOW * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'Speak Easy AI Proxy',
    version: '1.0.0',
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Proxy endpoint for Claude API
app.post('/api/chat', rateLimit, async (req, res) => {
  try {
    const { messages, system } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    if (!system || typeof system !== 'string') {
      return res.status(400).json({ error: 'system prompt is required' });
    }

    // Validate message format
    for (const msg of messages) {
      if (!msg.role || !msg.content) {
        return res.status(400).json({ error: 'Each message must have role and content' });
      }
      if (!['user', 'assistant'].includes(msg.role)) {
        return res.status(400).json({ error: 'Message role must be user or assistant' });
      }
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: system,
        messages: messages,
      }),
    });

    const data = await response.json();

    if (data.error) {
      console.error('Anthropic API error:', data.error);
      return res.status(response.status).json({ error: data.error.message });
    }

    res.json({
      content: data.content,
    });

  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Text-to-speech endpoint — ElevenLabs. Returns raw audio/mpeg bytes (no base64, no wrapper).
app.post('/api/tts', rateLimit, async (req, res) => {
  try {
    const { text } = req.body;

    // Mirror /api/chat's input validation: clear 400, never a crash.
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'text is required and must be a non-empty string' });
    }

    if (!ELEVENLABS_API_KEY) {
      console.error('TTS request received but ELEVENLABS_API_KEY is not configured');
      return res.status(500).json({ error: 'Text-to-speech is not configured' });
    }

    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: text,
          model_id: ELEVENLABS_MODEL_ID,
        }),
      }
    );

    if (!upstream.ok) {
      // Read the upstream body for our own logs only — it never contains the key.
      const detail = await upstream.text().catch(() => '');
      console.error(`ElevenLabs TTS error ${upstream.status}: ${detail.slice(0, 500)}`);
      return res
        .status(502)
        .json({ error: `Text-to-speech upstream error (status ${upstream.status})` });
    }

    // Stream the raw audio straight back so the client can play it directly.
    const audio = Buffer.from(await upstream.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', String(audio.length));
    return res.send(audio);

  } catch (error) {
    console.error('TTS proxy error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🗣️ Speak Easy AI Proxy running on port ${PORT}`);
  console.log(`📡 Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
