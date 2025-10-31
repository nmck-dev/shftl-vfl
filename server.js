// ======================
// IMPORTS & INITIAL SETUP
// ======================
const express = require('express');
const path = require('path');
const cors = require('cors');
const db = require('./db'); // PostgreSQL connection

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ======================
// BASIC HEALTH CHECKS
// ======================

// API health route (verifies backend + DB connection)
app.get('/api/health', async (req, res) => {
  try {
    const result = await db.query('SELECT NOW() AS now');
    res.json({ ok: true, db_time: result.rows[0].now });
  } catch (err) {
    console.error('DB error in /api/health:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ======================
// EVENT ROUTES
// ======================

// Create a new event
app.post('/api/events', async (req, res) => {
  const { slug, name, type = 'TOURNAMENT', start_date, end_date } = req.body;

  // Validate required fields
  if (!slug || !name || !start_date || !end_date) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: slug, name, start_date, end_date',
    });
  }

  try {
    const result = await db.query(
      `INSERT INTO event (slug, name, type, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [slug, name, type, start_date, end_date]
    );
    res.status(201).json({ ok: true, event: result.rows[0] });
  } catch (err) {
    console.error('Error creating event:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// List all events
app.get('/api/events', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM event ORDER BY start_date DESC`
    );
    res.json({ ok: true, events: result.rows });
  } catch (err) {
    console.error('Error listing events:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ======================
// FRONTEND FALLBACK
// ======================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ======================
// START SERVER
// ======================

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
