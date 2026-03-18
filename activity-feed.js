/**
 * BunMoji Activity Feed
 * Floating widget showing recent sidecar picks: expressions, backgrounds,
 * conditional evaluations, and errors.
 */

const MAX_ITEMS = 20;
const STORAGE_KEY_POS = 'bm-feed-trigger-position';

/** @type {HTMLElement|null} */
let triggerEl = null;
/** @type {HTMLElement|null} */
let panelEl = null;
/** @type {HTMLElement|null} */
let bodyEl = null;

/** @type {Array<{type: string, label: string, reasoning?: string, timestamp: number}>} */
let feedItems = [];

let unseenCount = 0;
let panelOpen = false;

// ── Helpers ──

function el(tag, className) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
}

function icon(name) {
    const i = document.createElement('i');
    i.className = `fa-solid ${name}`;
    return i;
}

function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const TYPE_CONFIG = {
    expression:  { icon: 'fa-masks-theater',  color: '#e8699a' },
    background:  { icon: 'fa-image',          color: '#ec8f7a' },
    conditional: { icon: 'fa-bolt',           color: '#f0c040' },
    error:       { icon: 'fa-circle-xmark',   color: '#ef4444' },
};

// ── Public API ──

/**
 * Create DOM elements for the activity feed.
 * Safe to call multiple times -- idempotent.
 */
export function initActivityFeed() {
    if (triggerEl) return; // already initialized
    createTrigger();
    createPanel();
}

/**
 * Toggle the sidecar-active glow animation on the trigger button.
 * @param {boolean} active
 */
export function setSidecarActive(active) {
    if (!triggerEl) return;
    triggerEl.classList.toggle('bm-float-sidecar-active', active);
}

/**
 * Add a feed item.
 * @param {{type: 'expression'|'background'|'conditional'|'error', label: string, reasoning?: string, timestamp?: number}} item
 */
export function addFeedItem(item) {
    const entry = {
        type: item.type || 'expression',
        label: item.label || '(unknown)',
        reasoning: item.reasoning || '',
        timestamp: item.timestamp || Date.now(),
    };

    feedItems.unshift(entry);
    if (feedItems.length > MAX_ITEMS) feedItems.length = MAX_ITEMS;

    renderFeedItem(entry, true);

    if (!panelOpen) {
        unseenCount++;
        updateBadge();
        pulseTrigger();
    }
}

/**
 * Clear all feed items.
 */
export function clearFeed() {
    feedItems.length = 0;
    unseenCount = 0;
    updateBadge();
    if (bodyEl) {
        while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
        bodyEl.appendChild(emptyState());
    }
}

// ── Trigger Button ──

function createTrigger() {
    triggerEl = el('div', 'bm-float-trigger');
    triggerEl.setAttribute('data-bm-count', '0');
    triggerEl.title = 'BunMoji Activity Feed';
    triggerEl.appendChild(icon('fa-face-smile-beam'));

    // Restore saved position
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_POS));
        if (saved?.left && saved?.top) {
            triggerEl.style.left = saved.left;
            triggerEl.style.top = saved.top;
            triggerEl.style.bottom = 'auto';
        }
    } catch { /* use CSS defaults */ }

    // Drag support
    let dragging = false;
    let offsetX = 0, offsetY = 0;

    triggerEl.addEventListener('pointerdown', (e) => {
        dragging = false;
        offsetX = e.clientX - triggerEl.getBoundingClientRect().left;
        offsetY = e.clientY - triggerEl.getBoundingClientRect().top;
        triggerEl.setPointerCapture(e.pointerId);
    });

    triggerEl.addEventListener('pointermove', (e) => {
        if (!triggerEl.hasPointerCapture(e.pointerId)) return;
        const dx = e.clientX - triggerEl.getBoundingClientRect().left - offsetX;
        const dy = e.clientY - triggerEl.getBoundingClientRect().top - offsetY;
        if (!dragging && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
            dragging = true;
        }
        if (dragging) {
            const x = Math.max(0, Math.min(window.innerWidth - 40, e.clientX - offsetX));
            const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - offsetY));
            triggerEl.style.left = `${x}px`;
            triggerEl.style.top = `${y}px`;
            triggerEl.style.bottom = 'auto';
            triggerEl.style.right = 'auto';
        }
    });

    triggerEl.addEventListener('pointerup', (e) => {
        triggerEl.releasePointerCapture(e.pointerId);
        if (dragging) {
            localStorage.setItem(STORAGE_KEY_POS, JSON.stringify({
                left: triggerEl.style.left,
                top: triggerEl.style.top,
            }));
            dragging = false;
        } else {
            togglePanel();
        }
    });

    document.body.appendChild(triggerEl);
}

// ── Panel ──

function createPanel() {
    panelEl = el('div', 'bm-float-panel');

    // Header
    const header = el('div', 'bm-float-panel-header');
    const title = el('span');
    title.textContent = 'BunMoji Feed';
    header.appendChild(title);

    const clearBtn = el('button');
    clearBtn.title = 'Clear feed';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => clearFeed());
    header.appendChild(clearBtn);

    const closeBtn = el('button');
    closeBtn.title = 'Close';
    closeBtn.appendChild(icon('fa-xmark'));
    closeBtn.addEventListener('click', () => {
        panelEl.classList.remove('open');
        panelOpen = false;
    });
    header.appendChild(closeBtn);

    panelEl.appendChild(header);

    // Body
    bodyEl = el('div', 'bm-float-panel-body');
    bodyEl.appendChild(emptyState());
    panelEl.appendChild(bodyEl);

    document.body.appendChild(panelEl);
}

function togglePanel() {
    if (!panelEl) return;
    panelOpen = !panelOpen;
    panelEl.classList.toggle('open', panelOpen);

    if (panelOpen) {
        repositionPanel();
        unseenCount = 0;
        updateBadge();
    }
}

function repositionPanel() {
    if (!triggerEl || !panelEl) return;
    const rect = triggerEl.getBoundingClientRect();
    const panelWidth = 280;

    // Default: to the right of the trigger
    let left = rect.right + 8;
    let bottom = window.innerHeight - rect.bottom;

    // If it would overflow right, place to the left
    if (left + panelWidth > window.innerWidth) {
        left = rect.left - panelWidth - 8;
    }
    // Clamp
    left = Math.max(4, Math.min(left, window.innerWidth - panelWidth - 4));
    bottom = Math.max(4, bottom);

    panelEl.style.left = `${left}px`;
    panelEl.style.bottom = `${bottom}px`;
}

// ── Rendering ──

function renderFeedItem(entry, prepend = false) {
    if (!bodyEl) return;

    // Remove empty state if present
    const emptyEl = bodyEl.querySelector('.bm-feed-empty');
    if (emptyEl) emptyEl.remove();

    const config = TYPE_CONFIG[entry.type] || TYPE_CONFIG.expression;
    const item = el('div', 'bm-feed-item');

    // Icon
    const iconEl = el('span', 'bm-feed-icon');
    const iconI = icon(config.icon);
    iconI.style.color = config.color;
    iconEl.appendChild(iconI);
    item.appendChild(iconEl);

    // Content
    const content = el('div', 'bm-feed-content');

    const labelEl = el('div', 'bm-feed-label');
    const typeTag = el('span');
    typeTag.style.color = config.color;
    typeTag.style.marginRight = '4px';
    typeTag.style.fontWeight = '500';
    typeTag.textContent = entry.type.charAt(0).toUpperCase() + entry.type.slice(1) + ':';
    labelEl.appendChild(typeTag);
    labelEl.append(' ' + entry.label);
    content.appendChild(labelEl);

    if (entry.reasoning) {
        const reasonEl = el('div', 'bm-feed-reasoning');
        reasonEl.textContent = entry.reasoning;
        reasonEl.style.fontSize = '10px';
        reasonEl.style.opacity = '0.6';
        reasonEl.style.marginTop = '2px';
        content.appendChild(reasonEl);
    }

    const timeEl = el('div', 'bm-feed-time');
    timeEl.textContent = formatTime(entry.timestamp);
    content.appendChild(timeEl);

    item.appendChild(content);

    if (prepend) {
        bodyEl.insertBefore(item, bodyEl.firstChild);
        // Enforce max rendered items
        while (bodyEl.children.length > MAX_ITEMS) {
            bodyEl.removeChild(bodyEl.lastChild);
        }
    } else {
        bodyEl.appendChild(item);
    }
}

function emptyState() {
    const empty = el('div', 'bm-feed-empty');
    empty.textContent = 'No sidecar activity yet';
    return empty;
}

// ── Badge & Pulse ──

function updateBadge() {
    if (!triggerEl) return;
    triggerEl.setAttribute('data-bm-count', String(unseenCount));
}

function pulseTrigger() {
    if (!triggerEl) return;
    triggerEl.classList.add('bm-float-pulse');
    setTimeout(() => triggerEl?.classList.remove('bm-float-pulse'), 600);
}
