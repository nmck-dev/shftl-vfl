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

  if (!slug || !name || !start_date || !end_date) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: slug, name, start_date, end_date',
    });
  }

  try {
    // 1) create the event
    const eventResult = await db.query(
      `INSERT INTO event (slug, name, type, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [slug, name, type, start_date, end_date]
    );
    const event = eventResult.rows[0];

    // 2) get all users
    const usersResult = await db.query(`SELECT id, display_name FROM app_user`);
    const users = usersResult.rows;

    // 3) create fantasy team for each user for this new event
    for (const user of users) {
      const teamName = `${user.display_name} - ${event.name}`;
      await db.query(
        `INSERT INTO fantasy_team (user_id, event_id, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, event_id) DO NOTHING`,
        [user.id, event.id, teamName]
      );
    }

    res.status(201).json({ ok: true, event, auto_users: users.length });
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
// CREATE USER ROUTES
// ======================

// Create a user and auto-enroll them in ALL events
app.post('/api/users', async (req, res) => {
  const { display_name, email, discord_id } = req.body;

  if (!display_name) {
    return res.status(400).json({ ok: false, error: 'display_name is required' });
  }

  try {
    // 1) create the user
    const userResult = await db.query(
      `INSERT INTO app_user (display_name, email, discord_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [display_name, email || null, discord_id || null]
    );
    const user = userResult.rows[0];

    // 2) get all events
    const eventsResult = await db.query(`SELECT id, name FROM event`);
    const events = eventsResult.rows;

    // 3) for each event, create a fantasy_team for this user
    for (const ev of events) {
      // make a simple name like "Nick - Test Tournament"
      const teamName = `${user.display_name} - ${ev.name}`;
      await db.query(
        `INSERT INTO fantasy_team (user_id, event_id, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, event_id) DO NOTHING`,
        [user.id, ev.id, teamName]
      );
    }

    res.status(201).json({ ok: true, user, auto_events: events.length });
  } catch (err) {
    console.error('create user + auto fantasy teams error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// List all fantasy teams for a specific user
app.get('/api/users/:userId/fantasy-teams', async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await db.query(
      `SELECT
         ft.id,
         ft.name,
         ft.event_id,
         ft.created_at,
         e.name AS event_name
       FROM fantasy_team ft
       JOIN event e ON ft.event_id = e.id
       WHERE ft.user_id = $1
       ORDER BY e.start_date DESC, ft.created_at DESC`,
      [userId]
    );

    res.json({ ok: true, fantasy_teams: result.rows });
  } catch (err) {
    console.error('list user fantasy teams error:', err);
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
