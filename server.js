// ======================
// IMPORTS & INITIAL SETUP
// ======================
const express = require('express');
const path = require('path');
const cors = require('cors');
const session = require('express-session'); // <--- added
const db = require('./db'); // PostgreSQL connection

const app = express();
const PORT = process.env.PORT || 3000;

// ======================
// MIDDLEWARE
// ======================
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// sessions (for Discord login)
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24, // 1 day
  },
}));

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
// DISCORD AUTH HELPERS
// ======================

// This will be used by /auth/discord/callback
async function findOrCreateUserFromDiscord(discordUser) {
  const discordId = discordUser.id;
  const displayName =
    discordUser.global_name ||
    discordUser.username ||
    'Discord User';

  // 1) see if user already exists
  const existing = await db.query(
    `SELECT * FROM app_user WHERE discord_id = $1`,
    [discordId]
  );

  let user;
  if (existing.rows.length > 0) {
    user = existing.rows[0];
  } else {
    // 2) create user
    const insert = await db.query(
      `INSERT INTO app_user (display_name, email, discord_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [displayName, discordUser.email || null, discordId]
    );
    user = insert.rows[0];
  }

  // 3) auto-enroll user in ALL events (your existing rule)
  const eventsResult = await db.query(`SELECT id, name FROM event`);
  const events = eventsResult.rows;

  for (const ev of events) {
    const teamName = `${user.display_name} - ${ev.name}`;
    await db.query(
      `INSERT INTO fantasy_team (user_id, event_id, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, event_id) DO NOTHING`,
      [user.id, ev.id, teamName]
    );
  }

  return user;
}

// ======================
// DISCORD AUTH ROUTES
// ======================

// 1) start OAuth (frontend will link to this)
app.get('/auth/discord', (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const redirectUri = encodeURIComponent(process.env.DISCORD_REDIRECT_URI);
  const scope = encodeURIComponent('identify email');

  const url =
    `https://discord.com/oauth2/authorize?response_type=code&client_id=${clientId}` +
    `&scope=${scope}&redirect_uri=${redirectUri}`;

  res.redirect(url);
});

// 2) Discord sends user back here
app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('Missing code from Discord');
  }

  try {
    // exchange code for token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error('Discord token error:', text);
      return res.status(500).send('Failed to get Discord token');
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // get Discord user
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const discordUser = await userRes.json();

    // create or find in our DB + auto-enroll
    const user = await findOrCreateUserFromDiscord(discordUser);

    // store in session
    req.session.userId = user.id;

    // go back to site (home for now)
    res.redirect('/');
  } catch (err) {
    console.error('Discord callback error:', err);
    res.status(500).send('Auth failed');
  }
});

// 3) who am I (used by frontend to know the logged-in user)
app.get('/api/me', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.json({ ok: true, user: null });
  }

  const userRes = await db.query(
    `SELECT id, display_name, email, discord_id, created_at
     FROM app_user
     WHERE id = $1`,
    [userId]
  );

  if (userRes.rows.length === 0) {
    return res.json({ ok: true, user: null });
  }

  res.json({ ok: true, user: userRes.rows[0] });
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
// CREATE USER ROUTES (manual/dev)
// ======================

// You can keep this for testing (bypasses Discord)
app.post('/api/users', async (req, res) => {
  const { display_name, email, discord_id } = req.body;

  if (!display_name) {
    return res.status(400).json({ ok: false, error: 'display_name is required' });
  }

  try {
    const userResult = await db.query(
      `INSERT INTO app_user (display_name, email, discord_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [display_name, email || null, discord_id || null]
    );
    const user = userResult.rows[0];

    // auto-enroll in all events
    const eventsResult = await db.query(`SELECT id, name FROM event`);
    const events = eventsResult.rows;

    for (const ev of events) {
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



// TEMP AREA
// TEMP: create esports team + player tables, and extend roster slots
app.get('/api/setup/players', async (req, res) => {
  try {
    // 1) teams table
    await db.query(`
      CREATE TABLE IF NOT EXISTS pro_team (
        id            BIGSERIAL PRIMARY KEY,
        name          TEXT NOT NULL,
        short_name    TEXT,
        region        TEXT,
        vlr_team_id   TEXT,
        active        BOOLEAN DEFAULT TRUE
      );
    `);

    // 2) players table
    await db.query(`
      CREATE TABLE IF NOT EXISTS player (
        id            BIGSERIAL PRIMARY KEY,
        handle        TEXT NOT NULL,
        real_name     TEXT,
        role          TEXT,    -- 'duelist','initiator','controller','sentinel','flex','wildcard'
        cost          INT DEFAULT 10,
        pro_team_id   BIGINT REFERENCES pro_team(id) ON DELETE SET NULL,
        vlr_player_id TEXT,
        active        BOOLEAN DEFAULT TRUE
      );
    `);

    // 3) make sure fantasy_roster_slot can remember cost at time of pick
    await db.query(`
      ALTER TABLE fantasy_roster_slot
      ADD COLUMN IF NOT EXISTS player_cost INT;
    `);

    res.json({ ok: true, message: 'pro_team, player, and fantasy_roster_slot.player_cost ready.' });
  } catch (err) {
    console.error('setup players error:', err);
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
