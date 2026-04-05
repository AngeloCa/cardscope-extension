/**
 * CardScope — popup.js
 * Settings management for the extension popup.
 */

const defaults = {
    serverUrl: 'http://localhost:3000',
    secret: '',
    condition: 'NM',
    nidThresholdPct: 90,
    enabled: true,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const enabledEl = document.getElementById('enabled');
const serverUrlEl = document.getElementById('serverUrl');
const secretEl = document.getElementById('secret');
const nidThresholdEl = document.getElementById('nidThresholdPct');
const thresholdDisplayEl = document.getElementById('thresholdDisplay');
const saveBtn = document.getElementById('save');
const statusEl = document.getElementById('status');
const conditionBtns = document.querySelectorAll('.condition-btn');

let selectedCondition = 'NM';

// ─── Load saved settings ──────────────────────────────────────────────────────

chrome.storage.sync.get(defaults, (settings) => {
    enabledEl.checked = settings.enabled;
    serverUrlEl.value = settings.serverUrl;
    secretEl.value = settings.secret;
    nidThresholdEl.value = settings.nidThresholdPct;
    thresholdDisplayEl.textContent = settings.nidThresholdPct;
    selectedCondition = settings.condition;
    updateConditionButtons();
});

// ─── Condition buttons ────────────────────────────────────────────────────────

conditionBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
        selectedCondition = btn.dataset.value;
        updateConditionButtons();
    });
});

function updateConditionButtons() {
    conditionBtns.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.value === selectedCondition);
    });
}

// ─── Threshold display ────────────────────────────────────────────────────────

nidThresholdEl.addEventListener('input', () => {
    thresholdDisplayEl.textContent = nidThresholdEl.value;
});

// ─── Save ─────────────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', () => {
    const settings = {
        serverUrl: serverUrlEl.value.trim().replace(/\/$/, ''),
        secret: secretEl.value.trim(),
        condition: selectedCondition,
        nidThresholdPct: parseInt(nidThresholdEl.value, 10) || 90,
        enabled: enabledEl.checked,
    };

    chrome.storage.sync.set(settings, () => {
        statusEl.textContent = '✓ Sauvegardé';
        statusEl.className = 'status';
        setTimeout(() => {
            statusEl.textContent = '';
        }, 2000);
    });
});
