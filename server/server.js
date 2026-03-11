/**
 * server.js — Multi-network ETH Faucet Backend
 *
 * Endpoints:
 *   POST /api/claim        — Validate & send tokens
 *   GET  /api/stats        — Balance + claim totals (optional ?network=)
 *   GET  /api/networks     — List supported networks
 *   GET  /api/config       — Public config (turnstile site key)
 *   GET  /api/health       — Health check
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const https     = require('https');

const db     = require('./database');
const faucet = require('./faucet');

/* ─── Config ─── */
const PORT             = parseInt(process.env.PORT || '3000', 10);
const COOLDOWN_HOURS   = parseInt(process.env.CLAIM_COOLDOWN_HOURS || '24', 10);
const COOLDOWN_SECONDS = COOLDOWN_HOURS * 3600;
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';

/* ─── App ─── */
const app = express();
app.set('trust proxy', 1);

/* ─── Middleware ─── */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://challenges.cloudflare.com"],
      frameSrc:   ["https://challenges.cloudflare.com"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:"],
      connectSrc: ["'self'"],
    },
  },
}));

app.use(cors({ origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '8kb' }));
app.use(express.urlencoded({ extended: false }));

/* ─── Rate Limiters ─── */
const claimLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please wait 15 minutes before trying again.' },
});
app.use('/api', rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Please slow down.' },
}));

/* ─── Static ─── */
app.use(express.static(path.join(__dirname, '..', 'client')));

/* ─── Helpers ─── */
function getClientIp(req) {
  return req.headers['cf-connecting-ip']
    || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.ip || '0.0.0.0';
}

function formatCooldown(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function isValidEthAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

/* ─── Turnstile CAPTCHA ─── */
async function verifyTurnstile(token, remoteIp) {
  if (!TURNSTILE_SECRET) {
    console.warn('[CAPTCHA] Skipping — no secret key (dev mode)');
    return { success: true };
  }
  return new Promise((resolve) => {
    const body = JSON.stringify({ secret: TURNSTILE_SECRET, response: token, remoteip: remoteIp });
    const req  = https.request({
      hostname: 'challenges.cloudflare.com',
      path:     '/turnstile/v0/siteverify',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ success: false }); } });
    });
    req.on('error', () => resolve({ success: false }));
    req.write(body);
    req.end();
  });
}

/* ═══════════════════════════════════════════════
   GET /api/networks — list all supported networks
═══════════════════════════════════════════════ */
app.get('/api/networks', (req, res) => {
  const list = Object.entries(faucet.NETWORKS).map(([id, net]) => ({
    id,
    name:        net.name,
    symbol:      net.symbol,
    chainId:     Number(net.chainId),
    explorer:    net.explorer,
    logo:        net.logo || `public/networks/${id}.svg`,  // ← tambah ini
    claimAmount: net.getAmount(),
  }));
  res.json(list);
});

/* ═══════════════════════════════════════════════
   GET /api/config — public frontend config
═══════════════════════════════════════════════ */
app.get('/api/config', (req, res) => {
  res.json({ turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || '' });
});

/* ═══════════════════════════════════════════════
   POST /api/claim
═══════════════════════════════════════════════ */
app.post('/api/claim', claimLimiter, async (req, res) => {
  const ip = getClientIp(req);
  const { walletAddress, captchaToken, network: rawNetwork } = req.body;

  /* 1. Validate network */
  const networkId = rawNetwork || 'sepolia';
  if (!faucet.NETWORKS[networkId]) {
    return res.status(400).json({ error: `Unsupported network: ${networkId}` });
  }
  const net = faucet.NETWORKS[networkId];

  /* 2. Validate wallet address */
  if (!walletAddress || typeof walletAddress !== 'string') {
    return res.status(400).json({ error: 'walletAddress is required.' });
  }
  const wallet = walletAddress.trim();
  if (!isValidEthAddress(wallet)) {
    return res.status(400).json({ error: 'Invalid Ethereum address. Must be 0x followed by 40 hex characters.' });
  }

  /* 3. Validate CAPTCHA */
  if (!captchaToken || typeof captchaToken !== 'string') {
    return res.status(400).json({ error: 'CAPTCHA token is required.' });
  }
  const captchaResult = await verifyTurnstile(captchaToken, ip);
  if (!captchaResult.success) {
    return res.status(403).json({ error: 'CAPTCHA verification failed. Please try again.' });
  }

  /* 4. Check cooldown (per network) */
  const waitSeconds = db.secondsUntilEligible(wallet, ip, networkId, COOLDOWN_SECONDS);
  if (waitSeconds > 0) {
    return res.status(429).json({
      error: `Already claimed on ${net.name} recently. Wait ${formatCooldown(waitSeconds)} before claiming again.`,
      waitSeconds,
    });
  }

  /* 5. Send tokens */
  let txHash;
  try {
    const result = await faucet.sendEth(wallet, networkId);
    txHash = result.txHash;
  } catch (err) {
    console.error(`[CLAIM:${networkId}] Transaction failed:`, err.message);
    return res.status(503).json({
      error: err.message.includes('balance') ? err.message : 'Transaction failed. Please try again in a moment.',
    });
  }

  /* 6. Record claim */
  try {
    db.recordClaim({ walletAddress: wallet, ipAddress: ip, txHash, amountEth: net.getAmount(), network: networkId });
  } catch (err) {
    console.error(`[CLAIM:${networkId}] DB record failed:`, err.message);
  }

  console.log(`[CLAIM] ✓ ${net.getAmount()} ${net.symbol} → ${wallet} | net=${networkId} | ip=${ip} | tx=${txHash}`);

  return res.status(200).json({
    success: true,
    txHash,
    amount:  net.getAmount(),
    symbol:  net.symbol,
    network: networkId,
    wallet,
    explorerUrl: `${net.explorer}/tx/${txHash}`,
  });
});

/* ═══════════════════════════════════════════════
   GET /api/stats?network=sepolia
═══════════════════════════════════════════════ */
app.get('/api/stats', async (req, res) => {
  const networkId = req.query.network || 'sepolia';
  if (!faucet.NETWORKS[networkId]) {
    return res.status(400).json({ error: `Unsupported network: ${networkId}` });
  }
  const net = faucet.NETWORKS[networkId];
  try {
    const [balance, stats] = await Promise.all([
      faucet.getFaucetBalance(networkId),
      Promise.resolve(db.getStats(networkId)),
    ]);
    return res.json({
      balance,
      totalClaims:      stats.totalClaims,
      totalDistributed: parseFloat(stats.totalDistributed.toFixed(4)),
      claimAmount:      net.getAmount(),
      symbol:           net.symbol,
      network:          networkId,
      chainId:          Number(net.chainId),
    });
  } catch (err) {
    console.error('[STATS]', err.message);
    return res.status(500).json({ error: 'Failed to fetch stats.' });
  }
});

/* ─── Health ─── */
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

/* ─── SPA fallback ─── */
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'client', 'index.html')));

/* ═══════════════════════════════════════════════
   STARTUP
═══════════════════════════════════════════════ */
async function start() {
  db.init();
  await faucet.verifyNetworks();

  app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════╗`);
    console.log(`║  Multi-Network Faucet Server          ║`);
    console.log(`║  http://localhost:${PORT}                 ║`);
    console.log(`╚══════════════════════════════════════╝\n`);
    console.log(`  Cooldown  : ${COOLDOWN_HOURS}h`);
    console.log(`  Faucet    : ${process.env.FAUCET_ADDRESS || 'NOT SET'}`);
    console.log(`  CAPTCHA   : ${TURNSTILE_SECRET ? 'enabled' : 'DISABLED (dev mode)'}`);
    console.log(`  Networks  : ${Object.keys(faucet.NETWORKS).join(', ')}\n`);
  });
}

start().catch(err => { console.error('[FATAL]', err); process.exit(1); });
