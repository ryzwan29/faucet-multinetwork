/**
 * cosmos.js — Cosmos SDK network integration
 *
 * Mendukung pengiriman token native via Cosmos RPC (Tendermint).
 * Menggunakan @cosmjs/stargate (connectWithSigner → Tendermint RPC, bukan LCD/REST).
 *
 * Env vars per-network (contoh untuk safrochain):
 *   SAFROCHAIN_RPC_URL       — Tendermint RPC endpoint (default: http://localhost:26657)
 *   SAFROCHAIN_CLAIM_AMOUNT  — jumlah token dalam denom terkecil (e.g. 1000000 = 1 SAFRO jika 6 desimal)
 *   SAFROCHAIN_DENOM         — denom token (e.g. usafro)
 *   SAFROCHAIN_DECIMALS      — jumlah desimal (default: 6)
 *   SAFROCHAIN_GAS_PRICE     — gas price string (e.g. 0.025usafro)
 *   FAUCET_MNEMONIC          — mnemonic faucet wallet (sama dengan EVM)
 */

'use strict';

const { SigningStargateClient, GasPrice } = require('@cosmjs/stargate');
const { DirectSecp256k1HdWallet, makeCosmoshubPath } = require('@cosmjs/proto-signing');
const { bech32 }                          = require('bech32');

// Standard Cosmos HD path (coin type 118, account 0, index 0)
// Same as used by Safrochain reference implementations
const COSMOS_HD_PATH = makeCosmoshubPath(0);

/* ─── Cosmos Network Registry ─── */
const COSMOS_NETWORKS = {
  safrochain: {
    name:         'SafroChain',
    chainId:      'safro-testnet-1',
    symbol:       'SAF',
    denom:        () => 'usaf',
    explorer:     () => process.env.SAFROCHAIN_EXPLORER || 'https://explorer.safrochain.com',
    logo:         'public/networks/safrochain.jpg',
    bech32Prefix: 'addr_safro',
    getRpc:       () => process.env.SAFROCHAIN_RPC_URL  || 'https://rpc.testnet.safrochain.com',
    getAmount:    () => parseFloat(process.env.SAFROCHAIN_CLAIM_AMOUNT || '1'),
    gasPrice:     () => '0.025usaf',
    decimals:     () => 6,
  },
  zigchain: {
    name:         'ZigChain',
    chainId:      'zig-test-2',
    symbol:       'ZIG',
    denom:        () => 'uzig',
    explorer:     () => process.env.ZIGCHAIN_EXPLORER || 'https://testnet.zigscan.org',
    logo:         'public/networks/zigchain.jpg',
    bech32Prefix: 'zig',
    getRpc:       () => process.env.ZIGCHAIN_RPC_URL  || 'https://testnet-rpc.zigchain.com',
    getAmount:    () => parseFloat(process.env.ZIGCHAIN_CLAIM_AMOUNT || '1'),
    gasPrice:     () => '0.025uzig',
    decimals:     () => 6,
  },

  // ── Template: tambah Cosmos network lain di sini ──
  // mycosmosnet: {
  //   name:         'My Cosmos Net',
  //   chainId:      'mychain-1',
  //   symbol:       'MCN',
  //   denom:        () => 'umcn',
  //   explorer:     () => process.env.MYCOSMOSNET_EXPLORER || '',
  //   logo:         'public/networks/mycosmosnet.png',
  //   bech32Prefix: 'cosmos',
  //   getRpc:       () => process.env.MYCOSMOSNET_RPC_URL || 'http://localhost:26657',
  //   getAmount:    () => parseFloat(process.env.MYCOSMOSNET_CLAIM_AMOUNT || '1'),
  //   gasPrice:     () => '0.025umcn',
  //   decimals:     () => 6,
  // },
};

/* ─── Client cache ─── */
const _clients = {};

function getMnemonic() {
  return process.env.FAUCET_MNEMONIC;
}

/**
 * Buat atau ambil SigningStargateClient dari cache.
 * connectWithSigner konek ke Tendermint RPC (port 26657), bukan LCD/REST.
 * @param {string} networkId
 * @returns {Promise<{client: SigningStargateClient, address: string}>}
 */
async function getClient(networkId) {
  const net = COSMOS_NETWORKS[networkId];
  if (!net) throw new Error(`Unknown Cosmos network: ${networkId}`);

  const mnemonic = getMnemonic();
  if (!mnemonic) throw new Error('FAUCET_MNEMONIC is not configured');

  const rpc = net.getRpc();

  // Invalidate cache kalau RPC URL berubah
  if (_clients[networkId] && _clients[networkId]._rpc !== rpc) {
    delete _clients[networkId];
  }

  if (!_clients[networkId]) {
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: net.bech32Prefix,
      hdPaths: [COSMOS_HD_PATH],
    });
    const [account] = await wallet.getAccounts();
    const client = await SigningStargateClient.connectWithSigner(rpc, wallet, {
      gasPrice: GasPrice.fromString(net.gasPrice()),
    });
    _clients[networkId] = { client, address: account.address, _rpc: rpc };
  }

  return _clients[networkId];
}

/* ─── Address Validation ─── */

/**
 * Validasi Cosmos bech32 address dengan prefix tertentu.
 * Menggunakan library bech32 untuk full checksum validation.
 * @param {string} address
 * @param {string} prefix  — e.g. 'addr_safro'
 * @returns {boolean}
 */
function isValidCosmosAddress(address, prefix) {
  try {
    const trimmed = address.trim().toLowerCase();

    // Quick prefix check
    if (!trimmed.startsWith(prefix + '1')) return false;

    // Full bech32 decode with checksum validation
    const decoded = bech32.decode(trimmed);

    // Verify prefix matches
    if (decoded.prefix !== prefix) return false;

    // Verify data length (20 bytes for secp256k1 addresses)
    const data = bech32.fromWords(decoded.words);
    return data.length === 20 || data.length === 32;
  } catch {
    return false;
  }
}

/* ─── Faucet Balance ─── */

/**
 * Ambil saldo faucet wallet untuk network Cosmos tertentu.
 * Dikembalikan dalam satuan utama (e.g. "10.0000") untuk ditampilkan di UI stats.
 * @param {string} networkId
 * @returns {Promise<string>}
 */
async function getCosmosFaucetBalance(networkId) {
  const net = COSMOS_NETWORKS[networkId];
  if (!net) throw new Error(`Unknown Cosmos network: ${networkId}`);

  try {
    const { client, address } = await getClient(networkId);
    const denom    = net.denom();
    const coin     = await client.getBalance(address, denom);
    const raw      = parseInt(coin.amount || '0', 10);
    const decimals = net.decimals();
    return (raw / Math.pow(10, decimals)).toFixed(4);
  } catch (err) {
    console.error(`[COSMOS:${networkId}] Balance check failed:`, err.message);
    return '0.0000';
  }
}

/* ─── Send Tokens ─── */

/**
 * Kirim token Cosmos ke recipient via Tendermint RPC.
 * @param {string} recipientAddress  — bech32 address
 * @param {string} networkId
 * @returns {Promise<{txHash: string}>}
 */
async function sendCosmos(recipientAddress, networkId) {
  const net = COSMOS_NETWORKS[networkId];
  if (!net) throw new Error(`Unknown Cosmos network: ${networkId}`);

  if (!isValidCosmosAddress(recipientAddress, net.bech32Prefix)) {
    throw new Error(`Invalid ${net.name} address. Must start with "${net.bech32Prefix}1..."`);
  }

  const { client, address: senderAddress } = await getClient(networkId);
  const denom        = net.denom();
  const claimDisplay = net.getAmount();               // satuan utama (e.g. 1 SAF)
  const decimals     = net.decimals();
  const claimMicro   = Math.round(claimDisplay * Math.pow(10, decimals)); // konvert ke micro-unit
  const minBuffer    = Math.round(Math.pow(10, decimals) * 0.1);          // 0.1 unit untuk buffer gas

  // Cek saldo (dalam micro-unit)
  const coin = await client.getBalance(senderAddress, denom);
  const bal  = parseInt(coin.amount || '0', 10);
  if (bal < claimMicro + minBuffer) {
    throw new Error(`Faucet ${net.symbol} balance is too low. Please try again later.`);
  }

  const result = await client.sendTokens(
    senderAddress,
    recipientAddress,
    [{ denom, amount: claimMicro.toString() }],
    'auto',
    'Faucet claim via faucet-multinetwork'
  );

  if (result.code !== 0) {
    throw new Error(`Transaction failed: ${result.rawLog}`);
  }

  console.log(`[COSMOS:${networkId}] Sent ${claimDisplay} ${net.symbol} (${claimMicro} ${denom}) → ${recipientAddress} | tx: ${result.transactionHash}`);
  return { txHash: result.transactionHash };
}

/* ─── Verify Networks ─── */

/**
 * Verifikasi koneksi semua Cosmos network saat startup.
 */
async function verifyCosmosNetworks() {
  for (const [id, net] of Object.entries(COSMOS_NETWORKS)) {
    if (!getMnemonic()) {
      console.warn(`[COSMOS:${id}] Skipping verification — mnemonic not configured`);
      continue;
    }
    try {
      const { client } = await getClient(id);
      const chainId    = await client.getChainId();
      if (chainId !== net.chainId) {
        console.warn(`[COSMOS:${id}] WARNING: chainId "${chainId}" !== expected "${net.chainId}"`);
      } else {
        console.log(`[COSMOS:${id}] Connected to ${net.name} (${net.chainId}) ✓`);
      }
    } catch (err) {
      console.error(`[COSMOS:${id}] Verification failed:`, err.message);
    }
  }
}

module.exports = {
  COSMOS_NETWORKS,
  isValidCosmosAddress,
  getCosmosFaucetBalance,
  sendCosmos,
  verifyCosmosNetworks,
};