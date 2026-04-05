/**
 * CardScope — content.js
 * Injected on voggt.com pages.
 * Finds the <video> element, captures frames every 3s,
 * sends them to the background service worker for card detection + price lookup,
 * and renders the overlay badge on top of the video.
 */

const CAPTURE_INTERVAL_MS = 3000;
const JPEG_QUALITY = 0.6;
const MAX_FRAME_WIDTH = 640; // resize before sending to reduce payload

let overlayEl = null;
let videoEl = null;
let captureInterval = null;
let lastCardName = null;
let isEnabled = true;
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

// ─── Settings ────────────────────────────────────────────────────────────────

async function getSettings() {
    return new Promise((resolve) => {
        chrome.storage.sync.get(
            {
                serverUrl: 'http://localhost:3000',
                secret: '',
                condition: 'NM',
                nidThresholdPct: 90,
                enabled: true,
            },
            resolve
        );
    });
}

// ─── Overlay ─────────────────────────────────────────────────────────────────

function createOverlay() {
    const el = document.createElement('div');
    el.id = 'cardscope-overlay';
    el.innerHTML = `
        <div class="cardscope-header">
            <span class="cardscope-logo">CardScope</span>
            <span class="cardscope-condition" id="cs-condition">NM</span>
        </div>
        <div id="cs-body">
            <div class="cardscope-idle">🃏 En attente d'une carte…</div>
        </div>
    `;
    makeDraggable(el);
    return el;
}

function attachOverlayToVideo(video) {
    const container = video.parentElement;
    if (!container) return;
    const style = window.getComputedStyle(container);
    if (style.position === 'static') {
        container.style.position = 'relative';
    }
    if (overlayEl && overlayEl.parentElement) {
        overlayEl.parentElement.removeChild(overlayEl);
    }
    container.appendChild(overlayEl);
}

function renderLoading(condition) {
    document.getElementById('cs-condition').textContent = condition;
    document.getElementById('cs-body').innerHTML = `
        <div class="cardscope-loading">
            <div class="cardscope-spinner"></div>
            Analyse en cours…
        </div>
    `;
}

function renderIdle(condition) {
    document.getElementById('cs-condition').textContent = condition;
    document.getElementById('cs-body').innerHTML = `
        <div class="cardscope-idle">🃏 En attente d'une carte…</div>
    `;
}

function renderResult(data, condition, nidThresholdPct) {
    document.getElementById('cs-condition').textContent = condition;

    if (!data || !data.detected) {
        renderIdle(condition);
        return;
    }

    const { cardName, set, cardNumber, trendPrice, lowPrice, currency, cardmarketUrl } = data;
    const symbol = currency === 'EUR' ? '€' : currency;
    const metaParts = [set, cardNumber ? `#${cardNumber}` : null].filter(Boolean);

    let verdictHtml = '';
    if (trendPrice != null) {
        verdictHtml = `
            <div class="cardscope-verdict unknown" id="cs-verdict">
                Renseigne le prix live pour le verdict
            </div>
        `;
    }

    document.getElementById('cs-body').innerHTML = `
        <div class="cardscope-card-name">${escapeHtml(cardName)}</div>
        ${metaParts.length ? `<div class="cardscope-card-meta">${escapeHtml(metaParts.join(' • '))}</div>` : ''}
        ${trendPrice != null ? `
        <div class="cardscope-prices">
            <div class="cardscope-price-block">
                <div class="cardscope-price-label">Tendance</div>
                <div class="cardscope-price-value">${trendPrice.toFixed(2)} ${symbol}</div>
            </div>
            <div class="cardscope-price-block">
                <div class="cardscope-price-label">Prix bas</div>
                <div class="cardscope-price-value">${lowPrice != null ? lowPrice.toFixed(2) + ' ' + symbol : '—'}</div>
            </div>
        </div>
        ${verdictHtml}
        ${cardmarketUrl ? `<a class="cardscope-link" href="${cardmarketUrl}" target="_blank">Voir sur Cardmarket ↗</a>` : ''}
        ` : `<div class="cardscope-idle">Prix non disponible</div>`}
    `;
}

function renderError(msg) {
    if (!document.getElementById('cs-body')) return;
    document.getElementById('cs-body').innerHTML = `
        <div class="cardscope-idle">⚠️ ${escapeHtml(msg)}</div>
    `;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ─── Drag & Drop ─────────────────────────────────────────────────────────────

function makeDraggable(el) {
    el.addEventListener('mousedown', (e) => {
        isDragging = true;
        const rect = el.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const parent = el.parentElement;
        if (!parent) return;
        const parentRect = parent.getBoundingClientRect();
        const x = e.clientX - parentRect.left - dragOffsetX;
        const y = e.clientY - parentRect.top - dragOffsetY;
        el.style.right = 'auto';
        el.style.left = `${Math.max(0, x)}px`;
        el.style.top = `${Math.max(0, y)}px`;
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
    });
}

// ─── Video frame capture ──────────────────────────────────────────────────────

function captureFrame(video) {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // Return base64 JPEG without the data: prefix
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1];
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function runCaptureLoop() {
    const settings = await getSettings();
    if (!settings.enabled) return;

    if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) return;

    let frameBase64;
    try {
        frameBase64 = captureFrame(videoEl);
    } catch (e) {
        return; // cross-origin or video not ready
    }

    renderLoading(settings.condition);

    chrome.runtime.sendMessage(
        {
            type: 'CARDSCOPE_IDENTIFY',
            image: frameBase64,
            condition: settings.condition,
            serverUrl: settings.serverUrl,
            secret: settings.secret,
        },
        (response) => {
            if (chrome.runtime.lastError) {
                renderError('Erreur de connexion au serveur');
                return;
            }
            if (!response || response.error) {
                renderError(response?.error || 'Erreur inconnue');
                return;
            }
            // Avoid re-fetching price if same card
            if (response.cardName && response.cardName === lastCardName && response.cached) {
                return;
            }
            lastCardName = response.cardName || null;
            renderResult(response, settings.condition, settings.nidThresholdPct);
        }
    );
}

// ─── Video element discovery ──────────────────────────────────────────────────

function findVideoElement() {
    // Direct video element on the page
    const videos = Array.from(document.querySelectorAll('video'));
    // Prefer the one that is playing and visible
    const playing = videos.find(
        (v) => !v.paused && v.videoWidth > 0 && v.offsetParent !== null
    );
    return playing || videos[0] || null;
}

function startCapture() {
    videoEl = findVideoElement();
    if (!videoEl) return false;

    if (!overlayEl) {
        overlayEl = createOverlay();
    }
    attachOverlayToVideo(videoEl);

    if (captureInterval) clearInterval(captureInterval);
    captureInterval = setInterval(runCaptureLoop, CAPTURE_INTERVAL_MS);
    return true;
}

// ─── Observe DOM for video appearing (SPA navigation) ─────────────────────────

const observer = new MutationObserver(() => {
    if (!videoEl || !document.contains(videoEl)) {
        videoEl = null;
        if (captureInterval) {
            clearInterval(captureInterval);
            captureInterval = null;
        }
        startCapture();
    }
});

observer.observe(document.body, { childList: true, subtree: true });

// Initial attempt
startCapture();

// Retry a few times in case the video loads after the script
let retries = 0;
const retryInterval = setInterval(() => {
    if (videoEl || retries >= 10) {
        clearInterval(retryInterval);
        return;
    }
    startCapture();
    retries++;
}, 2000);

// Listen to settings changes (e.g. toggle enabled from popup)
chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled && !changes.enabled.newValue) {
        if (captureInterval) clearInterval(captureInterval);
        captureInterval = null;
        if (overlayEl) overlayEl.classList.add('cardscope-hidden');
    } else if (changes.enabled && changes.enabled.newValue) {
        if (overlayEl) overlayEl.classList.remove('cardscope-hidden');
        startCapture();
    }
    if (changes.condition) {
        renderIdle(changes.condition.newValue);
    }
});
