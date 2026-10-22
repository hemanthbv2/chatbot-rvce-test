/**
 * RVCE Telemetry Engine - Dual Write Architecture
 *
 * Transmits real-time analytics & interaction telemetry to two endpoints simultaneously:
 *  1. WordPress REST API  -> MySQL DB -> In-Plugin WP Admin Dashboard (/wp-json/rvce/v1/logs)
 *  2. Central Node.js API  -> MongoDB  -> External Multi-Institute Dashboard (/api/logs)
 */

(function () {
    const SESSION_ID = 'sess_rvce_' + Math.random().toString(36).substr(2, 9);
    const PAGE_LOAD_TIME = Date.now();
    let telemetryQueue = [];

    // Helper to retrieve WordPress localized endpoints
    function getEndpoints() {
        const wpRestUrl = (window.rvceChatbotSettings && window.rvceChatbotSettings.restUrl)
            ? window.rvceChatbotSettings.restUrl.replace(/\/$/, '')
            : '';
        const vercelUrl = (window.rvceChatbotSettings && window.rvceChatbotSettings.vercelUrl)
            ? window.rvceChatbotSettings.vercelUrl.replace(/\/$/, '')
            : '';
        return { wpRestUrl, vercelUrl };
    }

    // Core event tracking dispatcher
    function trackEvent(eventType, eventData = {}) {
        const logEntry = {
            sessionId: SESSION_ID,
            timestamp: new Date().toISOString(),
            eventType: eventType,
            url: window.location.href,
            data: eventData
        };
        telemetryQueue.push(logEntry);
        if (window.rvceChatbotDebug) {
            console.log(`[RVCE Telemetry] ${eventType}`, logEntry);
        }
    }

    // Expose globally for Chatbot Engine (script.js)
    window.rvceTrackEvent = trackEvent;

    // Intercept form submissions & lead inquiries (e.g. Admission contact forms, Web3Forms, Google Sheets)
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        if (typeof args[0] === 'string' && (args[0].includes('api.web3forms.com/submit') || args[0].includes('rvce_send_lead') || args[0].includes('macros/s/'))) {
            try {
                if (args[1] && args[1].body) {
                    let payload = {};
                    if (args[1].body instanceof FormData) {
                        args[1].body.forEach((v, k) => { payload[k] = v; });
                    } else if (typeof args[1].body === 'string') {
                        try { payload = JSON.parse(args[1].body); } catch(e) { payload = { raw: args[1].body }; }
                    }
                    delete payload.access_key;
                    trackEvent('form_submit', { leadData: payload });
                }
            } catch(e) {
                console.error('[RVCE Telemetry] Lead interception note:', e);
            }
        }
        return originalFetch.apply(this, args);
    };

    // Track Button & Link Clicks
    document.addEventListener('click', (e) => {
        const target = e.target;
        if (target.tagName === 'BUTTON' || target.tagName === 'A' || target.closest('button') || target.closest('a')) {
            const btn = target.closest('button') || target;
            const a = target.closest('a') || target;
            const elementId = target.id || btn?.id || a?.id || 'action_button';
            const elementText = target.innerText || btn?.innerText || a?.innerText || 'action';
            trackEvent('click', { elementId, elementText: (elementText || '').substring(0, 40).trim() });
        }
    });

    // Track Content Hovers (>500ms)
    let hoverTimers = {};
    document.addEventListener('mouseover', (e) => {
        const target = e.target;
        if (target.tagName === 'BUTTON' || target.tagName === 'A' || target.closest('.suggestion-chip') || target.closest('.dept-card')) {
            const id = target.id || target.className || 'elem';
            hoverTimers[id] = Date.now();
        }
    });
    document.addEventListener('mouseout', (e) => {
        const target = e.target;
        if (target.tagName === 'BUTTON' || target.tagName === 'A' || target.closest('.suggestion-chip') || target.closest('.dept-card')) {
            const id = target.id || target.className || 'elem';
            if (hoverTimers[id]) {
                const duration = Date.now() - hoverTimers[id];
                if (duration > 500) trackEvent('hover', { elementId: id, durationMs: duration });
                delete hoverTimers[id];
            }
        }
    });

    // Track Copied Text
    document.addEventListener('copy', () => {
        const text = document.getSelection().toString();
        if (text) trackEvent('copy', { length: text.length, snippet: text.substring(0, 60) });
    });

    // Track Maximum Scroll Depth
    let maxScroll = 0;
    document.addEventListener('scroll', () => {
        const docH = document.body.scrollHeight - window.innerHeight;
        if (docH > 0) {
            const pct = Math.round((window.scrollY / docH) * 100);
            if (pct > maxScroll) maxScroll = pct;
        }
    });

    // Periodic Heartbeat every 15s to measure session dwell time
    setInterval(() => {
        const dwell = Math.round((Date.now() - PAGE_LOAD_TIME) / 1000);
        trackEvent('heartbeat', { dwellTimeSeconds: dwell, maxScrollPercent: maxScroll });
    }, 15000);

    // DUAL WRITE: Transmit batch to WordPress REST API and Central Node/MongoDB Dashboard
    async function sendBatch(batch) {
        const { wpRestUrl, vercelUrl } = getEndpoints();

        const payload = JSON.stringify({
            institute_id: 'rvce',
            instituteId: 'rvce',
            api_key: 'rvce_key_12345',
            apiKey: 'rvce_key_12345',
            sessionId: SESSION_ID,
            events: batch
        });

        const requests = [];

        // 1. WordPress REST API (Local WP MySQL database)
        if (wpRestUrl) {
            requests.push(
                fetch(wpRestUrl + '/logs', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: payload
                })
                .then(r => { if (!r.ok) throw new Error('WP status ' + r.status); })
                .catch(e => { /* graceful local failover */ })
            );
        }

        // 2. Central Backend API (Node.js Express / MongoDB Atlas)
        const centralBase = vercelUrl || (
            (window.location.hostname === 'localhost' || window.location.protocol === 'file:')
                ? 'http://localhost:3000'
                : ''
        );

        if (centralBase) {
            requests.push(
                fetch(centralBase.replace(/\/+$/, '') + '/api/logs', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: payload
                })
                .then(r => { if (!r.ok) throw new Error('Central status ' + r.status); })
                .catch(e => { /* graceful central failover */ })
            );
        }

        await Promise.allSettled(requests);
    }

    // Flush batch every 5 seconds
    setInterval(async () => {
        if (telemetryQueue.length === 0) return;
        const batch = [...telemetryQueue];
        telemetryQueue = [];
        await sendBatch(batch);
    }, 5000);

    // Final flush on window beforeunload
    window.addEventListener('beforeunload', () => {
        if (telemetryQueue.length === 0) return;
        const batch = [...telemetryQueue];
        telemetryQueue = [];
        const { vercelUrl } = getEndpoints();
        const centralBase = vercelUrl || (
            (window.location.hostname === 'localhost' || window.location.protocol === 'file:')
                ? 'http://localhost:3000'
                : ''
        );
        const payload = JSON.stringify({
            institute_id: 'rvce',
            api_key: 'rvce_key_12345',
            sessionId: SESSION_ID,
            events: batch
        });
        if (navigator.sendBeacon && centralBase) {
            navigator.sendBeacon(centralBase.replace(/\/+$/, '') + '/api/logs', payload);
        }
    });

    // Record initial visitor arrival
    trackEvent('page_load', {
        title: document.title,
        referrer: document.referrer || 'direct',
        screen: `${window.innerWidth}x${window.innerHeight}`
    });
})();
