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


// update an event (e.g. fix dates later)
app.put('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  const { slug, name, type, start_date, end_date, is_active } = req.body;

  // Build a dynamic update so you can send only what you want to change
  const fields = [];
  const values = [];
  let idx = 1;

  if (slug !== undefined) {
    fields.push(`slug = $${idx++}`);
    values.push(slug);
  }
  if (name !== undefined) {
    fields.push(`name = $${idx++}`);
    values.push(name);
  }
  if (type !== undefined) {
    fields.push(`type = $${idx++}`);
    values.push(type);
  }
  if (start_date !== undefined) {
    fields.push(`start_date = $${idx++}`);
    values.push(start_date);
  }
  if (end_date !== undefined) {
    fields.push(`end_date = $${idx++}`);
    values.push(end_date);
  }
  if (is_active !== undefined) {
    fields.push(`is_active = $${idx++}`);
    values.push(is_active);
  }

  if (fields.length === 0) {
    return res.status(400).json({ ok: false, error: 'No fields to update.' });
  }

  try {
    const result = await db.query(
      `UPDATE event
       SET ${fields.join(', ')}
       WHERE id = $${idx}
       RETURNING *`,
      [...values, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Event not found.' });
    }

    res.json({ ok: true, event: result.rows[0] });
  } catch (err) {
    console.error('update event error:', err);
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
// EVENT WEEK ROUTES
// ======================

// Create an event week for a specific event
app.post('/api/events/:eventId/weeks', async (req, res) => {
  const { eventId } = req.params;
  const { week_number, start_date, end_date } = req.body;

  // basic validation
  if (!week_number || !start_date || !end_date) {
    return res.status(400).json({
      ok: false,
      error: 'week_number, start_date, and end_date are required'
    });
  }

  try {
    const result = await db.query(
      `INSERT INTO event_week (event_id, week_number, start_date, end_date)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [eventId, week_number, start_date, end_date]
    );

    res.status(201).json({ ok: true, week: result.rows[0] });
  } catch (err) {
    console.error('Error creating event week:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// TEMP: create the event_week table if it doesn't exist
app.get('/api/setup/event-week', async (req, res) => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS event_week (
        id          BIGSERIAL PRIMARY KEY,
        event_id    BIGINT REFERENCES event(id) ON DELETE CASCADE,
        week_number INT NOT NULL,
        start_date  DATE NOT NULL,
        end_date    DATE NOT NULL,
        UNIQUE (event_id, week_number)
      );
    `);

    res.json({ ok: true, message: 'event_week table created (or already existed).' });
  } catch (err) {
    console.error('setup event_week error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});




// List all weeks for a specific event
app.get('/api/events/:eventId/weeks', async (req, res) => {
  const { eventId } = req.params;

  try {
    const result = await db.query(
      `SELECT * FROM event_week
       WHERE event_id = $1
       ORDER BY week_number ASC`,
      [eventId]
    );

    res.json({ ok: true, weeks: result.rows });
  } catch (err) {
    console.error('Error listing event weeks:', err);
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
