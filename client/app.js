/**
 * app.js — Multi-network Testnet Faucet Frontend
 */

'use strict';

const API_BASE = window.location.origin;

/* ─── State ─── */
let turnstileToken = null;
let isLoading      = false;
let currentNetwork = 'sepolia';
let networksConfig = {};

/* ─── DOM ─── */
const themeToggle       = document.getElementById('themeToggle');
const iconSun           = document.getElementById('iconSun');
const iconMoon          = document.getElementById('iconMoon');
const walletInput       = document.getElementById('walletAddress');
const walletError       = document.getElementById('walletError');
const claimBtn          = document.getElementById('claimBtn');
const claimBtnText      = document.getElementById('claimBtnText');
const resultPanel       = document.getElementById('resultPanel');
const refreshBtn        = document.getElementById('refreshBtn');
const statBalance       = document.getElementById('statBalance');
const statDistrib       = document.getElementById('statDistributed');
const statClaims        = document.getElementById('statClaims');
const statBalanceLabel  = document.getElementById('statBalanceLabel');
const statDistribLabel  = document.getElementById('statDistributedLabel');
const toast             = document.getElementById('toast');
const toastMsg          = document.getElementById('toastMsg');
const toastIcon         = document.getElementById('toastIcon');
const headerNetworkName = document.getElementById('headerNetworkName');
const footerExplorerLink= document.getElementById('footerExplorerLink');

// Custom dropdown elements
const customSelect  = document.getElementById('customSelect');
const selectTrigger = document.getElementById('selectTrigger');
const selectOptions = document.getElementById('selectOptions');
const selectedLogo  = document.getElementById('selectedLogo');
const selectedName  = document.getElementById('selectedName');
const selectedAmount= document.getElementById('selectedAmount');

/* ─────────────────────────────────────────
   THEME
───────────────────────────────────────── */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  iconSun.classList.toggle('hidden', theme === 'light');
  iconMoon.classList.toggle('hidden', theme === 'dark');
  localStorage.setItem('faucet-theme', theme);
}
themeToggle.addEventListener('click', () => {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});
applyTheme(
  localStorage.getItem('faucet-theme') ||
  (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
);

/* ─────────────────────────────────────────
   CUSTOM DROPDOWN
───────────────────────────────────────── */

/** Build dropdown options from networksConfig */
function buildDropdownOptions() {
  selectOptions.innerHTML = '';
  Object.entries(networksConfig).forEach(([id, net]) => {
    const li = document.createElement('li');
    li.className = 'custom-select__option' + (id === currentNetwork ? ' selected' : '');
    li.setAttribute('role', 'option');
    li.setAttribute('data-value', id);
    li.setAttribute('aria-selected', id === currentNetwork ? 'true' : 'false');
    li.innerHTML = `
      <img class="net-logo" src="${net.logo || `public/networks/${id}.svg`}"
           width="28" height="28" onerror="this.style.display='none'" />
      <div class="net-info">
        <span class="net-name">${net.name}</span>
      </div>
      <span class="net-amount">${net.claimAmount} ${net.symbol}</span>
    `;
    li.addEventListener('click', () => selectNetwork(id));
    selectOptions.appendChild(li);
  });
}

/** Open / close dropdown */
function toggleDropdown(force) {
  const isOpen = customSelect.getAttribute('aria-expanded') === 'true';
  const open   = force !== undefined ? force : !isOpen;
  customSelect.setAttribute('aria-expanded', open ? 'true' : 'false');
}

selectTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleDropdown();
});

// Keyboard nav
customSelect.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDropdown(); }
  if (e.key === 'Escape') toggleDropdown(false);
});

// Close on outside click — tapi jangan nutup kalau klik/scroll di dalam options
document.addEventListener('click', () => toggleDropdown(false));
selectOptions.addEventListener('click', (e) => e.stopPropagation());
selectOptions.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
selectOptions.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

/** Select a network */
function selectNetwork(networkId) {
  currentNetwork = networkId;
  toggleDropdown(false);

  // Update trigger display
  const net = networksConfig[networkId];
  selectedLogo.src = net.logo || `public/networks/${networkId}.svg`;
  selectedLogo.alt         = net.name;
  selectedName.textContent  = net.name;
  selectedAmount.textContent = `${net.claimAmount} ${net.symbol} per request`;

  // Mark selected in list
  selectOptions.querySelectorAll('.custom-select__option').forEach(opt => {
    const isSelected = opt.dataset.value === networkId;
    opt.classList.toggle('selected', isSelected);
    opt.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  });

  updateUIForNetwork(networkId);

  // Reset captcha
  if (window.turnstile) window.turnstile.reset();
  turnstileToken = null;
}

/* ─────────────────────────────────────────
   NETWORK UI UPDATE
───────────────────────────────────────── */
function updateUIForNetwork(networkId) {
  const net = networksConfig[networkId];
  if (!net) return;

  headerNetworkName.textContent  = net.name;
  claimBtnText.textContent       = `Request ${net.claimAmount} ${net.symbol}`;
  statBalanceLabel.textContent   = `Balance (${net.symbol})`;
  statDistribLabel.textContent   = `${net.symbol} Distributed`;
  footerExplorerLink.href        = net.explorer || '#';

  // Update address input placeholder sesuai tipe network
  const hint = getAddressHint(networkId);
  walletInput.placeholder = hint.placeholder;
  walletInput.value       = '';
  setInputState('');

  hideResult();
  fetchStats();
}

/* ─────────────────────────────────────────
   TURNSTILE
───────────────────────────────────────── */
window.onTurnstileSuccess = (token) => { turnstileToken = token; };
window.onTurnstileExpired = ()      => { turnstileToken = null; };

/* ─────────────────────────────────────────
   WALLET VALIDATION
───────────────────────────────────────── */
function isValidEthAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(addr.trim());
}

/**
 * Validasi Cosmos bech32 address dengan prefix tertentu.
 * Prefix bisa mengandung underscore (e.g. addr_safro).
 */
function isValidCosmosAddress(addr, prefix) {
  // Bech32: prefix + '1' + data
  // Prefix bisa a-z, digit, underscore (sebenarnya bech32 std hanya [a-z0-9] tapi
  // beberapa Cosmos chain pakai underscore dalam human-readable part)
  try {
    const lower = addr.toLowerCase().trim();
    if (!lower.startsWith(prefix + '1')) return false;
    // Minimal length check (prefix + '1' + 38 chars data)
    return lower.length >= prefix.length + 1 + 38;
  } catch {
    return false;
  }
}

/**
 * Validasi address sesuai tipe network.
 */
function isValidAddress(addr, networkId) {
  const net = networksConfig[networkId];
  if (net && net.cosmos && net.bech32Prefix) {
    return isValidCosmosAddress(addr, net.bech32Prefix);
  }
  return isValidEthAddress(addr);
}

/**
 * Ambil placeholder dan pesan error sesuai network.
 */
function getAddressHint(networkId) {
  const net = networksConfig[networkId];
  if (net && net.cosmos && net.bech32Prefix) {
    return {
      placeholder: `${net.bech32Prefix}1abc...`,
      errorMsg: `Must be a valid ${net.name} address (${net.bech32Prefix}1...)`,
    };
  }
  return {
    placeholder: '0x...',
    errorMsg: 'Must be a valid 0x address (42 chars)',
  };
}
function setInputState(state, message) {
  walletInput.classList.remove('valid', 'invalid');
  walletError.classList.remove('show');
  if (state === 'valid') walletInput.classList.add('valid');
  else if (state === 'invalid') {
    walletInput.classList.add('invalid');
    walletError.textContent = message;
    walletError.classList.add('show');
  }
}
walletInput.addEventListener('input', () => {
  const v    = walletInput.value.trim();
  const hint = getAddressHint(currentNetwork);
  const minLen = (networksConfig[currentNetwork]?.cosmos) ? 10 : 42;
  if (!v || v.length < minLen) { setInputState(''); return; }
  setInputState(isValidAddress(v, currentNetwork) ? 'valid' : 'invalid', hint.errorMsg);
});
walletInput.addEventListener('blur', () => {
  const v    = walletInput.value.trim();
  const hint = getAddressHint(currentNetwork);
  if (v && !isValidAddress(v, currentNetwork)) setInputState('invalid', hint.errorMsg);
});
walletInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') claimBtn.click(); });

/* ─────────────────────────────────────────
   LOADING
───────────────────────────────────────── */
function setLoading(loading) {
  isLoading = loading;
  claimBtn.disabled      = loading;
  walletInput.disabled   = loading;
  customSelect.style.pointerEvents = loading ? 'none' : '';
  claimBtn.classList.toggle('loading', loading);
}

/* ─────────────────────────────────────────
   RESULT PANEL
───────────────────────────────────────── */
function showSuccess(txHash, walletAddress, networkId) {
  const net   = networksConfig[networkId] || {};
  const short = walletAddress.slice(0, 6) + '…' + walletAddress.slice(-4);
  const explorerUrl = `${net.explorer}/tx/${txHash}`;

  resultPanel.className = 'card result-panel result-success show';
  resultPanel.innerHTML = `
    <div class="result-header">
      <div class="result-icon-wrap">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#05a87a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <div>
        <div class="result-title">Transaction Sent!</div>
        <div class="result-message">${net.claimAmount} ${net.symbol} is on its way to ${short}</div>
      </div>
    </div>
    <div class="tx-hash-block">
      <div class="tx-label">Transaction Hash</div>
      <div class="tx-hash-row">
        <span class="tx-hash-value">${txHash}</span>
        <button class="copy-btn" id="copyHashBtn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          Copy
        </button>
      </div>
    </div>
    <a class="etherscan-link" href="${explorerUrl}" target="_blank" rel="noopener">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
      View on Block Explorer
    </a>
  `;
  document.getElementById('copyHashBtn').addEventListener('click', () => copyHash(txHash));
  resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showError(message) {
  resultPanel.className = 'card result-panel result-error show';
  resultPanel.innerHTML = `
    <div class="result-header">
      <div class="result-icon-wrap">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#c0392b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </div>
      <div>
        <div class="result-title">Request Failed</div>
        <div class="result-message">${escapeHtml(message)}</div>
      </div>
    </div>
  `;
  resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideResult() {
  resultPanel.className = 'card result-panel';
  resultPanel.innerHTML = '';
}

/* ─────────────────────────────────────────
   COPY TX HASH
───────────────────────────────────────── */
async function copyHash(hash) {
  const btn = document.getElementById('copyHashBtn');
  try {
    await navigator.clipboard.writeText(hash);
    if (btn) {
      btn.classList.add('copied');
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`;
      }, 2000);
    }
    showToast('Transaction hash copied!', 'success');
  } catch { showToast('Copy failed — please copy manually', 'error'); }
}

/* ─────────────────────────────────────────
   TOAST
───────────────────────────────────────── */
let toastTimer = null;
function showToast(message, type = 'info') {
  clearTimeout(toastTimer);
  toast.className = `toast toast-${type} show`;
  const icons = {
    success: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    error:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    info:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };
  toastIcon.innerHTML = icons[type] || icons.info;
  toastMsg.textContent = message;
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4000);
}

/* ─────────────────────────────────────────
   FETCH STATS
───────────────────────────────────────── */
async function fetchStats() {
  try {
    refreshBtn.classList.add('spinning');
    const res  = await fetch(`${API_BASE}/api/stats?network=${currentNetwork}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    statBalance.textContent = parseFloat(data.balance ?? 0).toFixed(4);
    statDistrib.textContent = parseFloat(data.totalDistributed ?? 0).toFixed(2);
    statClaims.textContent  = Number(data.totalClaims ?? 0).toLocaleString();
  } catch {
    statBalance.textContent = statDistrib.textContent = statClaims.textContent = '—';
  } finally {
    setTimeout(() => refreshBtn.classList.remove('spinning'), 600);
  }
}
refreshBtn.addEventListener('click', fetchStats);

/* ─────────────────────────────────────────
   CLAIM
───────────────────────────────────────── */
claimBtn.addEventListener('click', async () => {
  if (isLoading) return;
  const address = walletInput.value.trim();
  if (!address) { setInputState('invalid', 'Please enter your wallet address'); walletInput.focus(); return; }
  const addrHint = getAddressHint(networkId);
  if (!isValidAddress(address, networkId)) { setInputState('invalid', addrHint.errorMsg); walletInput.focus(); return; }
  if (!turnstileToken) { showToast('Please complete the CAPTCHA first', 'error'); return; }

  const networkId = currentNetwork;
  const net       = networksConfig[networkId];
  hideResult();
  setLoading(true);
  showToast(`Sending ${net?.claimAmount ?? ''} ${net?.symbol ?? ''}…`, 'info');

  try {
    const response = await fetch(`${API_BASE}/api/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: address, captchaToken: turnstileToken, network: networkId }),
    });
    const data = await response.json();

    if (response.ok && data.txHash) {
      showSuccess(data.txHash, address, networkId);
      showToast(`${data.amount} ${data.symbol} sent! 🎉`, 'success');
      walletInput.value = '';
      setInputState('');
      if (window.turnstile) window.turnstile.reset();
      turnstileToken = null;
      setTimeout(fetchStats, 3000);
    } else {
      const msg = data.error || 'Something went wrong. Please try again.';
      showError(msg); showToast(msg, 'error');
      if (window.turnstile) window.turnstile.reset();
      turnstileToken = null;
    }
  } catch {
    const msg = 'Network error — please check your connection.';
    showError(msg); showToast(msg, 'error');
    if (window.turnstile) window.turnstile.reset();
    turnstileToken = null;
  } finally {
    setLoading(false);
  }
});

/* ─────────────────────────────────────────
   HELPERS
───────────────────────────────────────── */
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

/* ─────────────────────────────────────────
   INIT
───────────────────────────────────────── */
(async function init() {
  // 1. Load network list
  try {
    const res  = await fetch(`${API_BASE}/api/networks`);
    const list = await res.json();
    list.forEach(net => { networksConfig[net.id] = net; });
  } catch {
    networksConfig = {
      sepolia:   { name: 'Ethereum Sepolia', symbol: 'ETH', claimAmount: 0.1, explorer: 'https://sepolia.etherscan.io' },
      pushchain: { name: 'PushChain Donut',  symbol: 'PC',  claimAmount: 1,   explorer: 'https://donut.push.network' },
    };
  }

  // 2. Build dropdown options
  buildDropdownOptions();

  // 3. Set initial trigger display
  const firstNet = networksConfig[currentNetwork];
  if (firstNet) {
    selectedName.textContent   = firstNet.name;
    selectedAmount.textContent = `${firstNet.claimAmount} ${firstNet.symbol} per request`;
  }

  // 4. Load Turnstile site key
  try {
    const res = await fetch(`${API_BASE}/api/config`);
    const { turnstileSiteKey } = await res.json();
    if (turnstileSiteKey && window.turnstile) {
      window.turnstile.render('#turnstileWidget', {
        sitekey:            turnstileSiteKey,
        callback:           window.onTurnstileSuccess,
        'expired-callback': window.onTurnstileExpired,
        theme:              'auto',
      });
    }
  } catch (err) { console.error('Turnstile config failed:', err); }

  // 5. Apply initial UI
  updateUIForNetwork(currentNetwork);

  // 6. Stats refresh
  setInterval(fetchStats, 60_000);
})();