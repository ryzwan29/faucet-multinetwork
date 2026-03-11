# 🚰 Sepolia ETH Faucet

A professional, production-ready Web3 faucet for the **Ethereum Sepolia testnet**.  
Sends **0.1 ETH** to developers for free — once every 24 hours per wallet + IP.

---

## ✨ Features

- **Modern Web3 UI** — Light & Dark mode with animated transitions
- **Anti-abuse protection** — Per-wallet + per-IP 24h cooldowns
- **Bot protection** — Cloudflare Turnstile CAPTCHA
- **Real-time stats** — Live faucet balance, total ETH distributed, total claims
- **Transaction feedback** — Copy hash button + direct Etherscan link
- **Responsive** — Works on mobile and desktop
- **Secure** — Helmet headers, rate limiting, input validation

---

## 🗂 Project Structure

```
/
├── client/
│   ├── index.html          # Main UI
│   ├── styles.css          # Styles (light + dark mode)
│   ├── app.js              # Frontend logic
│   └── assets/
│       └── logo.svg        # Faucet logo
│
├── server/
│   ├── server.js           # Express API server
│   ├── database.js         # SQLite (claims storage)
│   ├── faucet.js           # ethers.js blockchain integration
│   └── .env                # Environment config (see below)
│
└── package.json
```

---

## 🚀 Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env` from `server/.env` and fill in your values:

```env
RPC_URL=https://rpc.sepolia.org
FAUCET_PRIVATE_KEY=0xYOUR_PRIVATE_KEY
FAUCET_ADDRESS=0xYOUR_FAUCET_ADDRESS
TURNSTILE_SECRET_KEY=your_turnstile_secret
TURNSTILE_SITE_KEY=your_turnstile_sitekey
PORT=3000
```

> ⚠️ **Never commit your private key to version control!**

### 3. Set up Cloudflare Turnstile

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Turnstile**
2. Create a new site (choose "Managed" challenge type)
3. Copy **Site Key** → paste into `client/index.html` (`data-sitekey`)
4. Copy **Secret Key** → paste into `server/.env` (`TURNSTILE_SECRET_KEY`)

### 4. Fund the faucet wallet

Send some Sepolia ETH to your `FAUCET_ADDRESS`.  
Get free Sepolia ETH from: https://sepoliafaucet.com

### 5. Run the server

```bash
# Production
npm start

# Development (auto-restart)
npm run dev
```

Visit: http://localhost:3000

---

## 🔌 API Reference

### `POST /api/claim`

Request 0.1 ETH from the faucet.

**Request body:**
```json
{
  "walletAddress": "0xYourWalletAddress",
  "captchaToken":  "turnstile_token_from_frontend"
}
```

**Success response (200):**
```json
{
  "success": true,
  "txHash":  "0xabc123...",
  "amount":  0.1,
  "wallet":  "0x...",
  "message": "0.1 ETH sent to 0x..."
}
```

**Error responses:**
- `400` — Invalid wallet address or missing fields
- `403` — CAPTCHA verification failed
- `429` — Cooldown active (includes `waitSeconds`)
- `503` — Transaction failed (low balance, RPC error)

---

### `GET /api/stats`

Returns current faucet stats.

**Response:**
```json
{
  "balance":          "4.2837",
  "totalClaims":      142,
  "totalDistributed": 14.2,
  "claimAmount":      0.1,
  "network":          "Sepolia",
  "chainId":          11155111
}
```

---

## 🔒 Security

| Layer | Mechanism |
|-------|-----------|
| Bot prevention | Cloudflare Turnstile CAPTCHA |
| Wallet cooldown | SQLite — 1 claim/24h per address |
| IP cooldown | SQLite — 1 claim/24h per IP |
| Burst protection | express-rate-limit (5 req/15 min) |
| Headers | Helmet.js (CSP, HSTS, etc.) |
| Input validation | Regex + length checks |

---

## 🌐 Deployment

### Nginx reverse proxy (recommended)

```nginx
server {
    listen 80;
    server_name faucet.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Host $host;
    }
}
```

Enable SSL with Certbot for HTTPS.

### Environment tips

- Use a dedicated faucet wallet with only Sepolia ETH
- Monitor faucet balance and top up regularly
- Consider using Infura/Alchemy for reliable RPC (not public endpoints)

---

## 📦 Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server |
| `ethers` v6 | Ethereum transactions |
| `better-sqlite3` | Fast SQLite database |
| `helmet` | Security headers |
| `express-rate-limit` | Rate limiting |
| `cors` | CORS headers |
| `dotenv` | Environment config |

---

## 📄 License

MIT — free to use, modify, and deploy.
