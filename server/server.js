require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const ChatLog = require('./models/ChatLog');

const app = express();
const PORT = process.env.PORT || 5000;

// ===== MIDDLEWARE =====
app.use(cors()); // Allow requests from any origin (chatbot on any domain/device)
app.use(express.json({ limit: '1mb' })); // Parse JSON bodies

// ===== MONGODB CONNECTION =====
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => {
        console.error('❌ MongoDB connection error:', err.message);
        process.exit(1);
    });

// ===== API ROUTES =====

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'online', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
});

// ---------- WRITE ROUTES (used by chatbot) ----------

// POST /api/logs — Save a single chat log
app.post('/api/logs', async (req, res) => {
    try {
        const log = new ChatLog({
            ...req.body,
            createdAt: new Date()
        });
        await log.save();
        res.status(201).json({ ok: true, id: log._id });
    } catch (err) {
        console.error('Log save error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// POST /api/logs/batch — Save multiple logs at once (for offline sync)
app.post('/api/logs/batch', async (req, res) => {
    try {
        const logs = req.body.logs;
        if (!Array.isArray(logs) || logs.length === 0) {
            return res.status(400).json({ ok: false, error: 'No logs provided' });
        }
        // Add server timestamp to each
        const withTimestamps = logs.map(l => ({ ...l, createdAt: new Date(l.d || Date.now()) }));
        const result = await ChatLog.insertMany(withTimestamps, { ordered: false });
        res.status(201).json({ ok: true, inserted: result.length });
    } catch (err) {
        console.error('Batch save error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ---------- READ ROUTES (used by dashboard) ----------

// GET /api/logs — Fetch all logs (with optional filters)
// Query params: ?date=2026-07-15&limit=5000&since=<ISO_timestamp>
app.get('/api/logs', async (req, res) => {
    try {
        const query = {};
        
        // Date filter (for dashboard date picker)
        if (req.query.date) {
            const start = new Date(req.query.date);
            const end = new Date(req.query.date);
            end.setDate(end.getDate() + 1);
            query.createdAt = { $gte: start, $lt: end };
        }

        // "Since" filter (for polling — only get new logs since last fetch)
        if (req.query.since) {
            query.createdAt = { $gt: new Date(req.query.since) };
        }

        const limit = Math.min(parseInt(req.query.limit) || 5000, 10000);
        
        const logs = await ChatLog.find(query)
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean(); // .lean() for faster reads (plain objects)

        res.json({ ok: true, count: logs.length, logs });
    } catch (err) {
        console.error('Fetch error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /api/logs/stats — Quick summary stats (for dashboard header cards)
app.get('/api/logs/stats', async (req, res) => {
    try {
        const query = {};
        if (req.query.date) {
            const start = new Date(req.query.date);
            const end = new Date(req.query.date);
            end.setDate(end.getDate() + 1);
            query.createdAt = { $gte: start, $lt: end };
        }

        const [totalEvents, sessions, devices] = await Promise.all([
            ChatLog.countDocuments(query),
            ChatLog.distinct('s', query),
            ChatLog.distinct('deviceType', query)
        ]);

        res.json({
            ok: true,
            totalEvents,
            totalSessions: sessions.length,
            deviceTypes: devices
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /api/logs/sessions — Get all unique sessions with their event counts
app.get('/api/logs/sessions', async (req, res) => {
    try {
        const pipeline = [
            { $group: {
                _id: '$s',
                count: { $sum: 1 },
                firstEvent: { $min: '$createdAt' },
                lastEvent: { $max: '$createdAt' },
                device: { $first: '$deviceType' }
            }},
            { $sort: { firstEvent: -1 } },
            { $limit: 200 }
        ];
        
        const sessions = await ChatLog.aggregate(pipeline);
        res.json({ ok: true, sessions });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ---------- MANAGEMENT ROUTES ----------

// PATCH /api/logs/:id/resolve — Mark an unanswered question as resolved
app.patch('/api/logs/:id/resolve', async (req, res) => {
    try {
        await ChatLog.findByIdAndUpdate(req.params.id, { resolved: true });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// DELETE /api/logs — Clear all logs (dashboard "Reset" button)
app.delete('/api/logs', async (req, res) => {
    try {
        const result = await ChatLog.deleteMany({});
        res.json({ ok: true, deleted: result.deletedCount });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// POST /api/logs/mock — Generate test data (dashboard "Mock Data" button)
app.post('/api/logs/mock', async (req, res) => {
    try {
        const now = Date.now();
        const sid = 'sid_demo' + Math.floor(Math.random() * 1000);
        const ts = (offset) => new Date(now - offset).toISOString();
        
        const mock = [
            { s: sid, q: "Hi", i: "greet", d: ts(120000), t: 'message', device: 'MockDevice', deviceType: 'desktop', browserName: 'Chrome', os: 'Windows', city: 'Bangalore', country: 'India' },
            { s: sid, q: "[click] Button: 💼 Placements", i: "click:Button: 💼 Placements", d: ts(108000), t: 'interaction', m: { action: 'placements', element: 'act-btn' }, device: 'MockDevice', deviceType: 'desktop', browserName: 'Chrome', os: 'Windows', city: 'Bangalore', country: 'India' },
            { s: sid, q: "CSE placements", i: "placements", d: ts(100000), t: 'message', device: 'MockDevice', deviceType: 'desktop', browserName: 'Chrome', os: 'Windows', city: 'Bangalore', country: 'India' },
            { s: sid, q: "[hover] View Placement Stats", i: "hover:View Placement Stats", d: ts(95000), t: 'interaction', m: { duration: '500ms+' }, device: 'MockDevice', deviceType: 'desktop', browserName: 'Chrome', os: 'Windows', city: 'Bangalore', country: 'India' },
            { s: sid, q: "[copy] ₹67 LPA Highest Package", i: "copy:₹67 LPA Highest Package", d: ts(75000), t: 'interaction', m: { length: 24 }, device: 'MockDevice', deviceType: 'desktop', browserName: 'Chrome', os: 'Windows', city: 'Bangalore', country: 'India' },
            { s: sid, q: "[click] Button: 🎓 Admissions", i: "click:Button: 🎓 Admissions", d: ts(65000), t: 'interaction', m: { action: 'admissions', element: 'act-btn' }, device: 'MockDevice', deviceType: 'desktop', browserName: 'Chrome', os: 'Windows', city: 'Bangalore', country: 'India' },
            { s: sid, q: "how to apply?", i: "admissions", d: ts(60000), t: 'message', device: 'MockDevice', deviceType: 'desktop', browserName: 'Chrome', os: 'Windows', city: 'Bangalore', country: 'India' },
            { s: sid, q: "hostel fees", i: "hostels", d: ts(45000), t: 'message', device: 'MockDevice', deviceType: 'desktop', browserName: 'Chrome', os: 'Windows', city: 'Bangalore', country: 'India' },
            { s: sid, q: "tell me about cse department", i: "dept_cse", d: ts(40000), t: 'message', device: 'MockDevice', deviceType: 'desktop', browserName: 'Chrome', os: 'Windows', city: 'Bangalore', country: 'India' },
            { s: sid, q: "nirf ranking?", i: "ranking", d: ts(30000), t: 'message', device: 'MockDevice', deviceType: 'desktop', browserName: 'Chrome', os: 'Windows', city: 'Bangalore', country: 'India' },
            { s: sid, q: "what is the weather in bangalore?", i: "unmatched", d: ts(20000), t: 'message', device: 'MockDevice', deviceType: 'desktop', browserName: 'Chrome', os: 'Windows', city: 'Bangalore', country: 'India' },
            { s: sid, q: "shut up", i: "moderated_abusive", d: ts(8000), t: 'message', device: 'MockDevice', deviceType: 'desktop', browserName: 'Chrome', os: 'Windows', city: 'Bangalore', country: 'India' },
            { s: sid, q: "[dwell] Chat open for 95s", i: "dwell:Chat open for 95s", d: ts(5000), t: 'interaction', m: { seconds: 95 }, device: 'MockDevice', deviceType: 'desktop', browserName: 'Chrome', os: 'Windows', city: 'Bangalore', country: 'India' },
            { s: sid, q: "[session] Page Unload", i: "session:Page Unload", d: ts(1000), t: 'interaction', device: 'MockDevice', deviceType: 'desktop', browserName: 'Chrome', os: 'Windows', city: 'Bangalore', country: 'India' },
        ];

        const withTimestamps = mock.map(l => ({ ...l, createdAt: new Date(l.d) }));
        await ChatLog.insertMany(withTimestamps);
        res.status(201).json({ ok: true, inserted: mock.length, sessionId: sid });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ===== START SERVER (Local only) =====
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`\n🚀 RVCE Chatbot API Server running on http://localhost:${PORT}`);
        console.log(`📊 Dashboard API: http://localhost:${PORT}/api/logs`);
        console.log(`❤️  Health check:  http://localhost:${PORT}/api/health\n`);
    });
}

// Export for Vercel Serverless
module.exports = app;
