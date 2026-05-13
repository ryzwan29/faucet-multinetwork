/**
 * faucet.js — Multi-network blockchain integration
 * Supports: Sepolia (ETH), PushChain Donut (PC), Republic AI (RAI)
 *           + Cosmos SDK networks: SafroChain (SAFRO)
 * Uses ethers.js v6 for EVM; @cosmjs/stargate for Cosmos.
 */

'use strict';

const { ethers }  = require('ethers');
const cosmos      = require('./cosmos');

/* ─── Network Registry ─── */
// Each network reads from env lazily inside functions
const NETWORKS = {
  sepolia: {
    name:       'Ethereum Sepolia',
    chainId:    11155111n,
    symbol:     'ETH',
    explorer:   process.env.SEPOLIA_EXPLORER || 'https://sepolia.etherscan.io',
    logo:       'public/networks/ethereum.png',
    getRpc:     () => process.env.RPC_URL            || 'https://ethereum-sepolia-rpc.publicnode.com',
    getAmount:  () => parseFloat(process.env.CLAIM_AMOUNT_ETH || '0.1'),
  },
  pushchain: {
    name:       'PushChain Donut',
    chainId:    42101n,
    symbol:     'PC',
    explorer:   process.env.PUSHCHAIN_EXPLORER || 'https://donut.push.network',
    logo:       'public/networks/pushchain.jpg',
    getRpc:     () => process.env.PUSHCHAIN_RPC_URL  || 'https://evm.donut.rpc.push.org/',
    getAmount:  () => parseFloat(process.env.PUSHCHAIN_CLAIM_AMOUNT || '1'),
  },
  republic: {
    name:      'Republic AI',
    chainId:   77701n,
    symbol:    'RAI',
    explorer:  process.env.REPUBLIC_EXPLORER || 'https://republicscan.rydone.xyz',
    logo:      'public/networks/republicai.jpg',
    getRpc:    () => process.env.REPUBLIC_RPC_URL    || 'https://testnet-evm-republic.rydone.xyz',
    getAmount: () => parseFloat(process.env.REPUBLIC_CLAIM_AMOUNT || '1'),
  },
  kiichain: {
    name:      'KiiChain Oro',
    chainId:   1336n,
    symbol:    'KII',
    explorer:  process.env.KIICHAIN_EXPLORER || 'https://explorer.kiichain.io',
    logo:      'public/networks/kiichain.png',
    getRpc:    () => process.env.KIICHAIN_RPC_URL    || 'https://json-rpc.uno.sentry.testnet.v3.kiivalidator.com',
    getAmount: () => parseFloat(process.env.KIICHAIN_CLAIM_AMOUNT || '1'),
  },

  // ── Cosmos SDK networks ──
  safrochain: {
    name:         'SafroChain',
    chainId:      'safro-testnet-1',
    symbol:       'SAF',
    explorer:     process.env.SAFROCHAIN_EXPLORER || 'https://explorer.safrochain.com',
    logo:         'public/networks/safrochain.jpg',
    cosmos:       true,
    bech32Prefix: 'addr_safro',
    getRpc:       () => process.env.SAFROCHAIN_RPC_URL || 'https://rpc.testnet.safrochain.com',
    getAmount:    () => cosmos.COSMOS_NETWORKS.safrochain.getAmount(),
  },
  zigchain: {
    name:         'ZigChain',
    chainId:      'zig-test-2',
    symbol:       'ZIG',
    explorer:     process.env.ZIGCHAIN_EXPLORER || 'https://testnet.zigscan.org',
    logo:         'public/networks/zigchain.jpg',
    cosmos:       true,
    bech32Prefix: 'zig',
    getRpc:       () => process.env.ZIGCHAIN_RPC_URL || 'https://testnet-rpc.zigchain.com',
    getAmount:    () => cosmos.COSMOS_NETWORKS.zigchain.getAmount(),
  },
};

function getPrivKey()    { return process.env.FAUCET_PRIVATE_KEY; }
function getFaucetAddr() { return process.env.FAUCET_ADDRESS; }

/* ─── Provider & Wallet cache per network ─── */
const _providers = {};
const _wallets   = {};

function getProvider(networkId) {
  const net = NETWORKS[networkId];
  if (!net) throw new Error(`Unknown network: ${networkId}`);
  const rpc = net.getRpc();
  if (!_providers[networkId] || _providers[networkId]._rpcUrl !== rpc) {
    const p = new ethers.JsonRpcProvider(rpc);
    p._rpcUrl = rpc;
    _providers[networkId] = p;
    delete _wallets[networkId]; // reset wallet when provider changes
  }
  return _providers[networkId];
}

function getWallet(networkId) {
  const privKey = getPrivKey();
  if (!privKey) throw new Error('FAUCET_PRIVATE_KEY is not configured');
  if (!_wallets[networkId]) {
    _wallets[networkId] = new ethers.Wallet(privKey, getProvider(networkId));
  }
  return _wallets[networkId];
}

/**
 * Get faucet balance for a given network.
 * @param {string} networkId
 * @returns {Promise<string>}
 */
async function getFaucetBalance(networkId = 'sepolia') {
  try {
    const addr = getFaucetAddr();
    if (!addr) throw new Error('FAUCET_ADDRESS is not configured');
    const balWei = await getProvider(networkId).getBalance(addr);
    return parseFloat(ethers.formatEther(balWei)).toFixed(4);
  } catch (err) {
    console.error(`[FAUCET:${networkId}] Balance check failed:`, err.message);
    return '0.0000';
  }
}

/**
 * Send tokens to recipient on the specified network.
 * @param {string} recipientAddress
 * @param {string} networkId
 * @returns {Promise<{txHash: string}>}
 */
async function sendEth(recipientAddress, networkId = 'sepolia') {
  const net       = NETWORKS[networkId];
  if (!net) throw new Error(`Unknown network: ${networkId}`);

  const wallet     = getWallet(networkId);
  const claimAmt   = net.getAmount();
  const sendWei    = ethers.parseEther(claimAmt.toString());
  const minBuffer  = ethers.parseEther('0.002');

  // Check balance
  const balWei = await getProvider(networkId).getBalance(wallet.address);
  if (balWei < sendWei + minBuffer) {
    throw new Error(`Faucet ${net.symbol} balance is too low. Please try again later.`);
  }

  const gasPrice = (await getProvider(networkId).getFeeData()).gasPrice || ethers.parseUnits('2', 'gwei');

  const tx = await wallet.sendTransaction({
    to:       recipientAddress,
    value:    sendWei,
    gasLimit: 21_000n,
    gasPrice,
  });

  console.log(`[FAUCET:${networkId}] Sent ${claimAmt} ${net.symbol} to ${recipientAddress} | tx: ${tx.hash}`);
  return { txHash: tx.hash };
}

/**
 * Verify all configured networks (EVM only; Cosmos diverifikasi terpisah).
 */
async function verifyNetworks() {
  for (const [id, net] of Object.entries(NETWORKS)) {
    if (net.cosmos) continue; // Cosmos ditangani cosmos.verifyCosmosNetworks()
    try {
      const network = await getProvider(id).getNetwork();
      if (network.chainId !== net.chainId) {
        console.warn(`[FAUCET:${id}] WARNING: chainId ${network.chainId} !== expected ${net.chainId}`);
      } else {
        console.log(`[FAUCET:${id}] Connected to ${net.name} ✓`);
      }
    } catch (err) {
      console.error(`[FAUCET:${id}] Network verification failed:`, err.message);
    }
  }
  await cosmos.verifyCosmosNetworks();
}

module.exports = {
  sendEth,
  getFaucetBalance,
  verifyNetworks,
  NETWORKS,
  getPrivKey,
  cosmos,  // re-export cosmos helpers
};