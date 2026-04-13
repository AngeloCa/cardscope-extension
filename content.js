/**
 * CardScope — content.js
 * Injected on voggt.com pages.
 * Finds the <video> element, captures frames when the scene changes,
 * sends them to the background service worker for card detection + price lookup,
 * and renders the overlay badge on top of the video.
 */

const CAPTURE_INTERVAL_MS = 2000;   // how often we CHECK for visual change
const MIN_API_INTERVAL_MS = 12000;  // min time between actual API calls
const JPEG_QUALITY = 0.6;
const MAX_FRAME_WIDTH = 640;
const DIFF_SAMPLE_SIZE = 32;        // 32×32 sample grid = 1024 points
const DIFF_THRESHOLD = 0.08;        // 8% of pixels must change to trigger API call

let overlayEl = null;
let videoEl = null;
let captureInterval = null;
let lastCardName = null;
let isEnabled = true;
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let lastFramePixels = null;
let lastApiCallAt = 0;
let hasCurrentResult = false;   // true once we have at least one result showing
let forceNextScan = false;      // set by "Pas ma carte" button
let blacklistedCard = null;     // card name to ignore after "Pas ma carte"
let blacklistUntil = 0;         // timestamp until blacklist expires
let apiCallInProgress = false;  // prevent concurrent requests
let currentCardData = null; // stores last detected card for re-pricing

// ─── Settings ────────────────────────────────────────────────────────────────

async function getSettings() {
    return new Promise((resolve) => {
        chrome.storage.sync.get(
            {
                serverUrl: 'https://cardscope-server-production.up.railway.app',
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
            <div class="cardscope-header-right">
                <span class="cardscope-scan-dot" id="cs-scan-dot" title="Scan en cours…"></span>
                <span class="cardscope-condition" id="cs-condition">NM</span>
            </div>
        </div>
        <div id="cs-body">
            <div class="cardscope-idle">🃏 En attente d'une carte…</div>
        </div>
        <div class="cardscope-actions">
            <button class="cardscope-btn cardscope-btn-quote" id="cs-quote" title="Obtenir la cote maintenant">
                💰 Cotation
            </button>
            <button class="cardscope-btn cardscope-btn-rescan" id="cs-rescan" title="Ignorer cette carte">
                🔄 Pas ma carte
            </button>
        </div>
    `;

    // "Cotation" button — immediate scan, bypass all throttling
    el.querySelector('#cs-quote').addEventListener('mousedown', (e) => e.stopPropagation());
    el.querySelector('#cs-quote').addEventListener('click', (e) => {
        e.stopPropagation();
        triggerManualScan(false); // force scan, keep blacklist
    });

    // "Pas ma carte" button — blacklist + force new scan
    el.querySelector('#cs-rescan').addEventListener('mousedown', (e) => e.stopPropagation());
    el.querySelector('#cs-rescan').addEventListener('click', (e) => {
        e.stopPropagation();
        if (lastCardName) {
            blacklistedCard = lastCardName;
            blacklistUntil = Date.now() + 60_000;
        }
        lastCardName = null;
        hasCurrentResult = false;
        renderIdle(null);
        triggerManualScan(true); // force scan + bypass blacklist
    });

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

function showScanDot(visible) {
    const dot = document.getElementById('cs-scan-dot');
    if (dot) dot.classList.toggle('active', visible);
}

// Full loading — only used when no result is currently shown
function renderLoading(condition) {
    if (!document.getElementById('cs-condition')) return;
    document.getElementById('cs-condition').textContent = condition;
    document.getElementById('cs-body').innerHTML = `
        <div class="cardscope-loading">
            <div class="cardscope-spinner"></div>
            Analyse en cours…
        </div>
    `;
    showScanDot(true);
}

function renderIdle(condition) {
    if (!document.getElementById('cs-condition')) return;
    document.getElementById('cs-condition').textContent = condition;
    document.getElementById('cs-body').innerHTML = `
        <div class="cardscope-idle">🃏 En attente d'une carte…</div>
    `;
    hasCurrentResult = false;
    currentCardData = null;
    showScanDot(false);
}

function renderResult(data, condition) {
    if (!document.getElementById('cs-condition')) return;
    document.getElementById('cs-condition').textContent = condition;
    showScanDot(false);

    if (!data || !data.detected) {
        renderIdle(condition);
        return;
    }

    const { cardName, set, cardNumber, trendPrice, lowPrice, currency, justtcgUrl, language } = data;
    const symbol = currency === 'EUR' ? '€' : (currency || '€');
    const metaParts = [set, cardNumber ? `#${cardNumber}` : null].filter(Boolean);
    const langBadge = language && language !== 'EN'
        ? `<span class="cardscope-lang-badge">${escapeHtml(language)}</span>` : '';

    const LANG_OPTIONS = ['EN', 'JP', 'FR', 'KR', 'DE'];
    const activeLang = language || 'EN';

    currentCardData = data; // save for re-pricing

    document.getElementById('cs-body').innerHTML = `
        <div class="cardscope-card-name">${escapeHtml(cardName)}${langBadge}</div>
        ${metaParts.length ? `<div class="cardscope-card-meta">${escapeHtml(metaParts.join(' • '))}</div>` : ''}
        <div class="cardscope-lang-selector">
            ${LANG_OPTIONS.map(l => `<button class="cardscope-lang-btn${l === activeLang ? ' active' : ''}" data-lang="${l}">${l}</button>`).join('')}
        </div>
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
        ${justtcgUrl ? `<a class="cardscope-link" href="${justtcgUrl}" target="_blank">Voir sur JustTCG ↗</a>` : ''}
        <a class="cardscope-link cardscope-psa-link" href="https://www.ebay.fr/sch/i.html?_nkw=${encodeURIComponent('PSA 10 ' + cardName)}&LH_Complete=1&LH_Sold=1&_sop=13" target="_blank">📊 Prix PSA 10 ↗</a>
        ` : `<div class="cardscope-idle">Prix non disponible pour ce jeu</div>`}
    `;
    hasCurrentResult = true;

    // Language button click handlers
    document.querySelectorAll('.cardscope-lang-btn').forEach(btn => {
        btn.addEventListener('mousedown', e => e.stopPropagation());
        btn.addEventListener('click', async e => {
            e.stopPropagation();
            const newLang = btn.dataset.lang;
            if (!currentCardData || newLang === activeLang) return;
            const settings = await getSettings();
            showScanDot(true);
            chrome.runtime.sendMessage({
                type: 'CARDSCOPE_REPRICE',
                cardName: currentCardData.cardName,
                game: currentCardData.game,
                set: currentCardData.set,
                cardNumber: currentCardData.cardNumber,
                language: newLang,
                condition: settings.condition,
                serverUrl: settings.serverUrl,
                secret: settings.secret,
            }, response => {
                showScanDot(false);
                if (!response || response.error) return;
                renderResult({ ...currentCardData, ...response, language: newLang }, settings.condition);
            });
        });
    });
}

function renderError(msg) {
    if (!document.getElementById('cs-body')) return;
    document.getElementById('cs-body').innerHTML = `
        <div class="cardscope-idle">⚠️ ${escapeHtml(msg)}</div>
    `;
    showScanDot(false);
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

// ─── Voggt DOM listing extraction ─────────────────────────────────────────────
// NOTE: disabled — Voggt UI text (navigation, headers) caused false positives.
// OCR via Claude Vision is more reliable. Re-enable once Voggt's exact selectors
// are confirmed by inspecting a live page.
function extractVoggtListing() {
    return null;
}

// ─── Video frame capture ──────────────────────────────────────────────────────

function captureFrame(video) {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return { canvas, ctx, base64: canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1] };
}

function samplePixels(ctx, w, h) {
    const pixels = [];
    for (let i = 0; i < DIFF_SAMPLE_SIZE; i++) {
        for (let j = 0; j < DIFF_SAMPLE_SIZE; j++) {
            const x = Math.floor((i / DIFF_SAMPLE_SIZE) * w);
            const y = Math.floor((j / DIFF_SAMPLE_SIZE) * h);
            const d = ctx.getImageData(x, y, 1, 1).data;
            pixels.push(d[0], d[1], d[2]);
        }
    }
    return pixels;
}

function frameDiff(prev, curr) {
    if (!prev || prev.length !== curr.length) return 1;
    let changed = 0;
    const total = curr.length / 3;
    for (let i = 0; i < curr.length; i += 3) {
        const dr = Math.abs(curr[i] - prev[i]);
        const dg = Math.abs(curr[i + 1] - prev[i + 1]);
        const db = Math.abs(curr[i + 2] - prev[i + 2]);
        if (dr + dg + db > 30) changed++;
    }
    return changed / total;
}

// ─── Manual scan trigger ──────────────────────────────────────────────────────

// bypassBlacklist=true for "Pas ma carte" (fresh start), false for "Cotation" (same card ok)
async function triggerManualScan(bypassBlacklist = false) {
    if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) return;

    const settings = await getSettings();
    if (!settings.enabled) return;

    // Reset throttling flags
    lastApiCallAt = 0;
    lastFramePixels = null;
    forceNextScan = true;
    if (bypassBlacklist) {
        blacklistedCard = null;
        blacklistUntil = 0;
    }

    if (apiCallInProgress) return;

    showScanDot(true);
    if (!hasCurrentResult) renderLoading(settings.condition);

    let frame;
    try {
        frame = captureFrame(videoEl);
    } catch (e) {
        renderError('Impossible de capturer la vidéo');
        return;
    }

    lastFramePixels = samplePixels(frame.ctx, frame.canvas.width, frame.canvas.height);
    lastApiCallAt = Date.now();
    forceNextScan = false;
    apiCallInProgress = true;

    chrome.runtime.sendMessage(
        {
            type: 'CARDSCOPE_IDENTIFY',
            image: frame.base64,
            condition: settings.condition,
            serverUrl: settings.serverUrl,
            secret: settings.secret,
            force: true,
        },
        (response) => {
            apiCallInProgress = false;
            if (chrome.runtime.lastError || !response || response.error) {
                renderError(response?.error || 'Erreur serveur');
                return;
            }
            if (!response.detected) {
                renderIdle(settings.condition);
                return;
            }
            lastCardName = response.cardName || null;
            renderResult(response, settings.condition);
        }
    );
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function runCaptureLoop() {
    const settings = await getSettings();
    if (!settings.enabled) return;
    if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) return;
    if (apiCallInProgress) return; // already waiting for a response

    const now = Date.now();
    const cooldownOk = forceNextScan || (now - lastApiCallAt >= MIN_API_INTERVAL_MS);
    if (!cooldownOk) return;

    let frame;
    try {
        frame = captureFrame(videoEl);
    } catch (e) {
        return;
    }

    // Visual diff check (skip if same scene, unless forced)
    const currentPixels = samplePixels(frame.ctx, frame.canvas.width, frame.canvas.height);
    const diff = frameDiff(lastFramePixels, currentPixels);
    if (!forceNextScan && diff < DIFF_THRESHOLD) return;

    lastFramePixels = currentPixels;
    lastApiCallAt = now;
    forceNextScan = false;

    // Show full loading only if nothing is displayed yet; otherwise scan silently
    if (!hasCurrentResult) {
        renderLoading(settings.condition);
    } else {
        showScanDot(true);
    }

    // ── Strategy 1: DOM listing extraction (no OCR cost) ──────────────────────
    const listing = extractVoggtListing();
    if (listing?.cardName && listing.cardName !== lastCardName) {
        chrome.runtime.sendMessage(
            {
                type: 'CARDSCOPE_PRICE_ONLY',
                cardName: listing.cardName,
                condition: settings.condition,
                serverUrl: settings.serverUrl,
                secret: settings.secret,
            },
            (response) => {
                if (chrome.runtime.lastError || !response || response.error) {
                    // DOM extraction failed — fall through to OCR (will happen next tick)
                    lastApiCallAt = 0;
                    return;
                }
                lastCardName = listing.cardName;
                renderResult({ detected: true, cardName: listing.cardName, ...response }, settings.condition);
            }
        );
        return;
    }

    // ── Strategy 2: OCR via Claude Vision ────────────────────────────────────
    const isForced = forceNextScan;
    apiCallInProgress = true;
    chrome.runtime.sendMessage(
        {
            type: 'CARDSCOPE_IDENTIFY',
            image: frame.base64,
            condition: settings.condition,
            serverUrl: settings.serverUrl,
            secret: settings.secret,
            force: isForced,
        },
        (response) => {
            apiCallInProgress = false;
            if (chrome.runtime.lastError) {
                renderError('Erreur connexion serveur');
                return;
            }
            if (!response || response.error) {
                if (hasCurrentResult) showScanDot(false);
                else renderError(response?.error || 'Erreur inconnue');
                return;
            }
            if (!response.detected) {
                if (!hasCurrentResult) renderIdle(settings.condition);
                else showScanDot(false);
                return;
            }
            // Ignore blacklisted card for 60s after "Pas ma carte"
            if (response.cardName === blacklistedCard && Date.now() < blacklistUntil) {
                showScanDot(false);
                return;
            }
            if (response.cardName === lastCardName && response.cached) {
                showScanDot(false);
                return;
            }
            lastCardName = response.cardName || null;
            renderResult(response, settings.condition);
        }
    );
}


// ─── Video element discovery ──────────────────────────────────────────────────

function findVideoElement() {
    const videos = Array.from(document.querySelectorAll('video'));
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

let spaDebounce = null;
const observer = new MutationObserver(() => {
    if (videoEl && document.contains(videoEl)) return; // video still present, nothing to do
    // Debounce: wait 1s of DOM stability before attempting to find the video
    clearTimeout(spaDebounce);
    spaDebounce = setTimeout(() => {
        if (videoEl && document.contains(videoEl)) return;
        videoEl = null;
        if (captureInterval) {
            clearInterval(captureInterval);
            captureInterval = null;
        }
        startCapture();
    }, 1000);
});

observer.observe(document.body, { childList: true, subtree: true });

// Clear stale cache from previous lives on every page load
chrome.runtime.sendMessage({ type: 'CARDSCOPE_CLEAR_CACHE' });

// Initial attempt + periodic retry until video is found (max 30s)
startCapture();
const retryInterval = setInterval(() => {
    if (videoEl) { clearInterval(retryInterval); return; }
    startCapture();
}, 3000);
setTimeout(() => clearInterval(retryInterval), 30_000);

// Listen to settings changes
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
