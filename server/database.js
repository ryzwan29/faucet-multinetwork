/**
 * database.js — SQLite persistence layer (multi-network)
 */

'use strict';

const Database = require('better-sqlite3');
const path     = require('path');

const _rawDbPath = process.env.DB_PATH || './faucet.db';
const DB_PATH    = path.isAbsolute(_rawDbPath)
  ? _rawDbPath
  : path.join(__dirname, path.basename(_rawDbPath));

let db;

function init() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS claims (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address  TEXT    NOT NULL,
      ip_address      TEXT    NOT NULL,
      tx_hash         TEXT    NOT NULL,
      amount_eth      REAL    NOT NULL DEFAULT 0.1,
      network         TEXT    NOT NULL DEFAULT 'sepolia',
      claimed_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_wallet  ON claims(wallet_address, network, claimed_at);
    CREATE INDEX IF NOT EXISTS idx_ip      ON claims(ip_address, network, claimed_at);
  `);

  console.log(`[DB] Initialized: ${DB_PATH}`);
  return db;
}

function getLastClaimByWallet(wallet, network, cooldownSeconds) {
  const cutoff = Math.floor(Date.now() / 1000) - cooldownSeconds;
  return db.prepare(`
    SELECT * FROM claims
    WHERE wallet_address = ? AND network = ? AND claimed_at > ?
    ORDER BY claimed_at DESC LIMIT 1
  `).get(wallet.toLowerCase(), network, cutoff);
}

function getLastClaimByIP(ip, network, cooldownSeconds) {
  const cutoff = Math.floor(Date.now() / 1000) - cooldownSeconds;
  return db.prepare(`
    SELECT * FROM claims
    WHERE ip_address = ? AND network = ? AND claimed_at > ?
    ORDER BY claimed_at DESC LIMIT 1
  `).get(ip, network, cutoff);
}

function recordClaim({ walletAddress, ipAddress, txHash, amountEth, network = 'sepolia' }) {
  return db.prepare(`
    INSERT INTO claims (wallet_address, ip_address, tx_hash, amount_eth, network)
    VALUES (?, ?, ?, ?, ?)
  `).run(walletAddress.toLowerCase(), ipAddress, txHash, amountEth, network);
}

function getStats(network = null) {
  const row = network
    ? db.prepare(`SELECT COUNT(*) AS total_claims, SUM(amount_eth) AS total_distributed FROM claims WHERE network = ?`).get(network)
    : db.prepare(`SELECT COUNT(*) AS total_claims, SUM(amount_eth) AS total_distributed FROM claims`).get();
  return {
    totalClaims:      row.total_claims       || 0,
    totalDistributed: row.total_distributed  || 0,
  };
}

function secondsUntilEligible(wallet, ip, network, cooldownSeconds) {
  const now  = Math.floor(Date.now() / 1000);
  const lastW = getLastClaimByWallet(wallet, network, cooldownSeconds);
  const lastI = getLastClaimByIP(ip, network, cooldownSeconds);

  let nextAllowed = 0;
  if (lastW) nextAllowed = Math.max(nextAllowed, lastW.claimed_at + cooldownSeconds);
  if (lastI) nextAllowed = Math.max(nextAllowed, lastI.claimed_at + cooldownSeconds);

  return Math.max(0, nextAllowed - now);
}

module.exports = { init, recordClaim, getStats, secondsUntilEligible };
