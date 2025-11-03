// ======================
// IMPORTS & INITIAL SETUP
// ======================
const express = require('express');
const path = require('path');
const cors = require('cors');
const session = require('express-session'); // <--- added
const db = require('./db'); // PostgreSQL connection
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;


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

// Middleware to protect admin routes
function requireAdminKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== ADMIN_API_KEY) {
    return res.status(403).json({ ok: false, error: 'Forbidden: Invalid or missing API key.' });
  }
  next();
}


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
  const {
    slug,
    name,
    type = 'TOURNAMENT',
    start_date,
    end_date,
    active_budget_cap,
    bench_budget_cap
  } = req.body;

  if (!slug || !name || !start_date || !end_date) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: slug, name, start_date, end_date',
    });
  }

  // default budgets based on type
  const finalActiveCap =
    active_budget_cap !== undefined ? active_budget_cap : 50;
  const finalBenchCap =
    bench_budget_cap !== undefined
      ? bench_budget_cap
      : (type === 'SPLIT' ? 25 : 0);

  try {
    const eventResult = await db.query(
      `INSERT INTO event (slug, name, type, start_date, end_date, active_budget_cap, bench_budget_cap)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [slug, name, type, start_date, end_date, finalActiveCap, finalBenchCap]
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

// Get the "current" week for an event
app.get('/api/events/:eventId/current-week', async (req, res) => {
  const { eventId } = req.params;

  try {
    // get all weeks for this event
    const weeksRes = await db.query(
      `SELECT id, event_id, week_number, start_date, end_date
       FROM event_week
       WHERE event_id = $1
       ORDER BY start_date ASC`,
      [eventId]
    );

    const weeks = weeksRes.rows;
    if (weeks.length === 0) {
      return res.status(404).json({ ok: false, error: 'No weeks found for this event.' });
    }

    // Render runs UTC; this is fine for us
    const now = new Date();

    // 1) try to find a week that contains "now"
    let current = weeks.find(w => {
      const start = new Date(w.start_date);
      const end = new Date(w.end_date);
      return now >= start && now <= end;
    });

    // 2) if none active yet, pick the next future week
    if (!current) {
      current = weeks.find(w => new Date(w.start_date) > now);
    }

    // 3) if still nothing (we’re past all weeks), pick the last one
    if (!current) {
      current = weeks[weeks.length - 1];
    }

    // check if this week is locked
    const lockRes = await db.query(
      `SELECT 1 FROM week_lock WHERE event_week_id = $1`,
      [current.id]
    );
    const is_locked = lockRes.rowCount > 0;

    res.json({
      ok: true,
      event_id: Number(eventId),
      week: {
        id: current.id,
        week_number: current.week_number,
        start_date: current.start_date,
        end_date: current.end_date,
        is_locked
      }
    });
  } catch (err) {
    console.error('get current week error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUBLIC: get lock/status info for a specific week
app.get('/api/weeks/:eventWeekId/status', async (req, res) => {
  const { eventWeekId } = req.params;

  try {
    // fetch week + event info
    const weekRes = await db.query(
      `SELECT ew.id,
              ew.event_id,
              ew.week_number,
              ew.start_date,
              ew.end_date,
              e.name       AS event_name,
              e.type       AS event_type
       FROM event_week ew
       JOIN event e ON e.id = ew.event_id
       WHERE ew.id = $1`,
      [eventWeekId]
    );

    if (weekRes.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Week not found.' });
    }

    const week = weekRes.rows[0];

    // check lock
    const lockRes = await db.query(
      `SELECT 1 FROM week_lock WHERE event_week_id = $1`,
      [eventWeekId]
    );
    const is_locked = lockRes.rowCount > 0;

    // compute “is_current” and “is_upcoming” for convenience
    const now = new Date();
    const start = new Date(week.start_date);
    const end   = new Date(week.end_date);

    const is_current  = now >= start && now <= end;
    const is_upcoming = now < start;
    const is_past     = now > end;

    res.json({
      ok: true,
      week: {
        id: week.id,
        event_id: week.event_id,
        event_name: week.event_name,
        event_type: week.event_type,
        week_number: week.week_number,
        start_date: week.start_date,
        end_date: week.end_date,
        is_locked,
        is_current,
        is_upcoming,
        is_past
      }
    });
  } catch (err) {
    console.error('week status error:', err);
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


// list esports teams
app.get('/api/teams', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, short_name, region, active
       FROM pro_team
       ORDER BY name ASC`
    );
    res.json({ ok: true, teams: result.rows });
  } catch (err) {
    console.error('list teams error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// create esports team (admin/manual for now)
app.post('/api/teams', async (req, res) => {
  const { name, short_name, region, vlr_team_id } = req.body;

  if (!name) {
    return res.status(400).json({ ok: false, error: 'name is required' });
  }

  try {
    const result = await db.query(
      `INSERT INTO pro_team (name, short_name, region, vlr_team_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, short_name || null, region || null, vlr_team_id || null]
    );

    res.status(201).json({ ok: true, team: result.rows[0] });
  } catch (err) {
    console.error('create team error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// list players, optionally filtered for the popup
app.get('/api/players', async (req, res) => {
  const { role, team_id, max_cost, q } = req.query;
  const where = [];
  const params = [];
  let idx = 1;

  if (role) {
    where.push(`p.role = $${idx++}`);
    params.push(role);
  }
  if (team_id) {
    where.push(`p.pro_team_id = $${idx++}`);
    params.push(team_id);
  }
  if (max_cost) {
    where.push(`p.cost <= $${idx++}`);
    params.push(Number(max_cost));
  }
  if (q) {
    where.push(`p.handle ILIKE $${idx++}`);
    params.push(`%${q}%`);
  }

  const sql = `
    SELECT
      p.id,
      p.handle,
      p.real_name,
      p.role,
      p.cost,
      p.active,
      p.pro_team_id,
      t.name AS team_name,
      t.short_name AS team_short_name
    FROM player p
    LEFT JOIN pro_team t ON p.pro_team_id = t.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.cost DESC, p.handle ASC
  `;

  try {
    const result = await db.query(sql, params);
    res.json({ ok: true, players: result.rows });
  } catch (err) {
    console.error('list players error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// create player (manual/admin)
app.post('/api/players', async (req, res) => {
  const {
    handle,
    real_name,
    role,
    cost,
    pro_team_id,
    vlr_player_id,
    active
  } = req.body;

  if (!handle) {
    return res.status(400).json({ ok: false, error: 'handle is required' });
  }

  try {
    const result = await db.query(
      `INSERT INTO player
        (handle, real_name, role, cost, pro_team_id, vlr_player_id, active)
       VALUES
        ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE))
       RETURNING *`,
      [
        handle,
        real_name || null,
        role || null,
        cost !== undefined ? cost : 10,
        pro_team_id || null,
        vlr_player_id || null,
        active
      ]
    );

    res.status(201).json({ ok: true, player: result.rows[0] });
  } catch (err) {
    console.error('create player error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});



// Save (replace) a roster for a team for a specific week
app.post('/api/fantasy-teams/:fantasyTeamId/weeks/:eventWeekId/roster', async (req, res) => {
  const { fantasyTeamId, eventWeekId } = req.params;
  const { slots } = req.body; 
  // slots = [{ player_id, slot_type, is_bench }, ...]

  if (!Array.isArray(slots)) {
    return res.status(400).json({ ok: false, error: 'slots must be an array' });
  }

  try {
    // 1) check lock
    const locked = await db.query(
      `SELECT 1 FROM week_lock WHERE event_week_id = $1`,
      [eventWeekId]
    );
    if (locked.rowCount > 0) {
      return res.status(400).json({ ok: false, error: 'Week is locked.' });
    }

    // 2) get event info
    const weekRes = await db.query(
      `SELECT ew.event_id, e.type, e.active_budget_cap, e.bench_budget_cap
       FROM event_week ew
       JOIN event e ON ew.event_id = e.id
       WHERE ew.id = $1`,
      [eventWeekId]
    );
    if (weekRes.rowCount === 0) {
      return res.status(400).json({ ok: false, error: 'Unknown event week.' });
    }

    const {
      event_id,
      type: eventType,
      active_budget_cap,
      bench_budget_cap
    } = weekRes.rows[0];

    // 3) check slot counts
    const activeSlots = slots.filter(s => !s.is_bench);
    const benchSlots = slots.filter(s => s.is_bench);

    if (eventType === 'TOURNAMENT') {
      if (activeSlots.length !== 6) {
        return res.status(400).json({ ok: false, error: 'Tournament requires 6 active slots.' });
      }
      // tournaments: ignore bench slots completely (or disallow)
      if (benchSlots.length > 0) {
        return res.status(400).json({ ok: false, error: 'Tournament does not use bench slots.' });
      }
    } else if (eventType === 'SPLIT') {
      if (activeSlots.length !== 6) {
        return res.status(400).json({ ok: false, error: 'Split requires 6 active slots.' });
      }
      if (benchSlots.length !== 3) {
        return res.status(400).json({ ok: false, error: 'Split requires 3 bench slots.' });
      }
    }

    // 4) load players
    const playerIds = slots
      .map(s => s.player_id)
      .filter(id => id !== null && id !== undefined);

    let playersById = {};
    if (playerIds.length > 0) {
      const playerRes = await db.query(
        `SELECT id, handle, role, cost
         FROM player
         WHERE id = ANY($1)`,
        [playerIds]
      );
      playersById = Object.fromEntries(playerRes.rows.map(p => [p.id, p]));
    }

    // 5) validate roles + compute 2 totals
    let activeTotal = 0;
    let benchTotal = 0;

    for (const slot of slots) {
      if (!slot.player_id) continue;
      const player = playersById[slot.player_id];
      if (!player) {
        return res.status(400).json({ ok: false, error: `Unknown player id ${slot.player_id}` });
      }

      // role check for ACTIVE non-wildcard
      if (!slot.is_bench && slot.slot_type !== 'wildcard') {
        if (player.role !== slot.slot_type) {
          return res.status(400).json({
            ok: false,
            error: `Player ${player.handle} (${player.role}) cannot be placed in ${slot.slot_type}`
          });
        }
      }

      if (slot.is_bench) {
        benchTotal += player.cost || 0;
      } else {
        activeTotal += player.cost || 0;
      }
    }

    // 6) enforce budgets
    // active budget is always enforced
    if (active_budget_cap && activeTotal > active_budget_cap) {
      return res.status(400).json({
        ok: false,
        error: `Active budget exceeded: ${activeTotal}/${active_budget_cap}`
      });
    }

    // bench budget only for SPLIT
    if (eventType === 'SPLIT' && bench_budget_cap && benchTotal > bench_budget_cap) {
      return res.status(400).json({
        ok: false,
        error: `Bench budget exceeded: ${benchTotal}/${bench_budget_cap}`
      });
    }

    // 7) write roster (replace)
    await db.query(
      `DELETE FROM fantasy_roster_slot
       WHERE fantasy_team_id = $1 AND event_week_id = $2`,
      [fantasyTeamId, eventWeekId]
    );

    for (const slot of slots) {
      const player = slot.player_id ? playersById[slot.player_id] : null;
      const playerCost = player ? player.cost : null;

      await db.query(
        `INSERT INTO fantasy_roster_slot
         (fantasy_team_id, event_week_id, player_id, slot_type, is_bench, player_cost)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          fantasyTeamId,
          eventWeekId,
          slot.player_id || null,
          slot.slot_type,
          slot.is_bench || false,
          playerCost
        ]
      );
    }

    res.json({
      ok: true,
      message: 'Roster saved.',
      active_total: activeTotal,
      bench_total: benchTotal
    });
  } catch (err) {
    console.error('save roster error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Get roster for a team for a specific week
app.get('/api/fantasy-teams/:fantasyTeamId/weeks/:eventWeekId/roster', async (req, res) => {
  const { fantasyTeamId, eventWeekId } = req.params;

  try {
    const result = await db.query(
      `SELECT frs.*, p.handle AS player_handle, p.role AS player_role, p.cost AS player_db_cost
       FROM fantasy_roster_slot frs
       LEFT JOIN player p ON frs.player_id = p.id
       WHERE frs.fantasy_team_id = $1 AND frs.event_week_id = $2
       ORDER BY frs.is_bench ASC, frs.slot_type ASC, frs.id ASC`,
      [fantasyTeamId, eventWeekId]
    );

    res.json({ ok: true, roster: result.rows });
  } catch (err) {
    console.error('get roster error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Save (replace) a roster for a team for a specific week
app.post('/api/fantasy-teams/:fantasyTeamId/weeks/:eventWeekId/roster', async (req, res) => {
  const { fantasyTeamId, eventWeekId } = req.params;
  const { slots } = req.body; // [{ player_id, slot_type, is_bench }, ...]

  if (!Array.isArray(slots)) {
    return res.status(400).json({ ok: false, error: 'slots must be an array' });
  }

  try {
    // 1) is week locked?
    const locked = await db.query(
      `SELECT 1 FROM week_lock WHERE event_week_id = $1`,
      [eventWeekId]
    );
    if (locked.rowCount > 0) {
      return res.status(400).json({ ok: false, error: 'Week is locked.' });
    }

    // 2) get event + budgets
    const weekRes = await db.query(
      `SELECT ew.event_id, e.type, e.active_budget_cap, e.bench_budget_cap
       FROM event_week ew
       JOIN event e ON ew.id = $1 AND ew.event_id = e.id`,
      [eventWeekId]
    );

    if (weekRes.rowCount === 0) {
      return res.status(400).json({ ok: false, error: 'Unknown event week.' });
    }

    const {
      event_id,
      type: eventType,
      active_budget_cap,
      bench_budget_cap
    } = weekRes.rows[0];

    // 3) validate counts
    const activeSlots = slots.filter(s => !s.is_bench);
    const benchSlots = slots.filter(s => s.is_bench);

    if (eventType === 'TOURNAMENT') {
      if (activeSlots.length !== 6) {
        return res.status(400).json({ ok: false, error: 'Tournament requires 6 active slots.' });
      }
      if (benchSlots.length > 0) {
        return res.status(400).json({ ok: false, error: 'Tournament does not use bench slots.' });
      }
    } else if (eventType === 'SPLIT') {
      if (activeSlots.length !== 6) {
        return res.status(400).json({ ok: false, error: 'Split requires 6 active slots.' });
      }
      if (benchSlots.length !== 3) {
        return res.status(400).json({ ok: false, error: 'Split requires 3 bench slots.' });
      }
    }

    // 4) load players
    const playerIds = slots
      .map(s => s.player_id)
      .filter(id => id !== null && id !== undefined);

    let playersById = {};
    if (playerIds.length > 0) {
      const playerRes = await db.query(
        `SELECT id, handle, role, cost
         FROM player
         WHERE id = ANY($1)`,
        [playerIds]
      );
      playersById = Object.fromEntries(playerRes.rows.map(p => [p.id, p]));
    }

    // 5) compute budget totals, check roles
    let activeTotal = 0;
    let benchTotal = 0;

    for (const slot of slots) {
      if (!slot.player_id) continue;
      const player = playersById[slot.player_id];
      if (!player) {
        return res.status(400).json({ ok: false, error: `Unknown player id ${slot.player_id}` });
      }

      // role check (only for active non-wildcard)
      if (!slot.is_bench && slot.slot_type !== 'wildcard') {
        if (player.role !== slot.slot_type) {
          return res.status(400).json({
            ok: false,
            error: `Player ${player.handle} (${player.role}) cannot be placed in ${slot.slot_type}`
          });
        }
      }

      if (slot.is_bench) {
        benchTotal += player.cost || 0;
      } else {
        activeTotal += player.cost || 0;
      }
    }

    // 6) enforce budgets
    if (active_budget_cap && activeTotal > active_budget_cap) {
      return res.status(400).json({
        ok: false,
        error: `Active budget exceeded: ${activeTotal}/${active_budget_cap}`
      });
    }

    if (eventType === 'SPLIT' && bench_budget_cap && benchTotal > bench_budget_cap) {
      return res.status(400).json({
        ok: false,
        error: `Bench budget exceeded: ${benchTotal}/${bench_budget_cap}`
      });
    }

    // 7) replace roster
    await db.query(
      `DELETE FROM fantasy_roster_slot
       WHERE fantasy_team_id = $1 AND event_week_id = $2`,
      [fantasyTeamId, eventWeekId]
    );

    for (const slot of slots) {
      const player = slot.player_id ? playersById[slot.player_id] : null;
      const playerCost = player ? player.cost : null;

      await db.query(
        `INSERT INTO fantasy_roster_slot
         (fantasy_team_id, event_week_id, player_id, slot_type, is_bench, player_cost)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          fantasyTeamId,
          eventWeekId,
          slot.player_id || null,
          slot.slot_type,
          slot.is_bench || false,
          playerCost
        ]
      );
    }

    res.json({
      ok: true,
      message: 'Roster saved.',
      active_total: activeTotal,
      bench_total: benchTotal
    });
  } catch (err) {
    console.error('save roster error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});



// ======================
// ADMIN ROUTES
// ======================

// ADMIN: clear all rosters for an event (end of event)
app.post('/api/events/:eventId/reset-rosters', requireAdminKey, async (req, res) => {
  const { eventId } = req.params;

  try {
    // find all weeks for that event
    const weeksRes = await db.query(
      `SELECT id FROM event_week WHERE event_id = $1`,
      [eventId]
    );
    const weekIds = weeksRes.rows.map(r => r.id);

    if (weekIds.length === 0) {
      return res.json({ ok: true, message: 'No weeks to clear.' });
    }

    // delete roster slots for those weeks
    await db.query(
      `DELETE FROM fantasy_roster_slot
       WHERE event_week_id = ANY($1)`,
      [weekIds]
    );

    // optionally: delete week_lock rows too
    await db.query(
      `DELETE FROM week_lock
       WHERE event_week_id = ANY($1)`,
      [weekIds]
    );

    res.json({ ok: true, message: `Cleared rosters for event ${eventId}.` });
  } catch (err) {
    console.error('reset rosters error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ADMIN: lock a specific week (no roster edits allowed)
app.post('/api/weeks/:eventWeekId/lock', requireAdminKey, async (req, res) => {
  const { eventWeekId } = req.params;
  try {
    // insert if not exists (unique index prevents dupes)
    await db.query(
      `INSERT INTO week_lock (event_week_id)
       SELECT $1
       WHERE NOT EXISTS (
         SELECT 1 FROM week_lock WHERE event_week_id = $1
       )`,
      [eventWeekId]
    );
    res.json({ ok: true, message: `Week ${eventWeekId} locked.` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ADMIN: unlock a specific week (allow roster edits again)
app.post('/api/weeks/:eventWeekId/unlock', requireAdminKey, async (req, res) => {
  const { eventWeekId } = req.params;
  try {
    const result = await db.query(
      `DELETE FROM week_lock WHERE event_week_id = $1`,
      [eventWeekId]
    );
    const changed = result.rowCount > 0;
    res.json({ ok: true, message: changed ? `Week ${eventWeekId} unlocked.` : `Week ${eventWeekId} was not locked.` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// (Convenience) ADMIN: lock the current week for an event
app.post('/api/events/:eventId/lock-current-week', requireAdminKey, async (req, res) => {
  const { eventId } = req.params;
  try {
    // reuse current-week logic in a single query block
    const weeksRes = await db.query(
      `SELECT id, start_date, end_date
       FROM event_week
       WHERE event_id = $1
       ORDER BY start_date ASC`,
      [eventId]
    );
    if (weeksRes.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'No weeks found for this event.' });
    }
    const now = new Date();
    let cur = weeksRes.rows.find(w => now >= new Date(w.start_date) && now <= new Date(w.end_date))
           || weeksRes.rows.find(w => new Date(w.start_date) > now)
           || weeksRes.rows[weeksRes.rows.length - 1];

    await db.query(
      `INSERT INTO week_lock (event_week_id)
       SELECT $1
       WHERE NOT EXISTS (SELECT 1 FROM week_lock WHERE event_week_id = $1)`,
      [cur.id]
    );

    res.json({ ok: true, message: `Locked event ${eventId} week ${cur.id}.` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ADMIN: unlock the current week for an event
app.post('/api/events/:eventId/unlock-current-week', requireAdminKey, async (req, res) => {
  const { eventId } = req.params;

  try {
    // find the "current" week just like the lock-current-week route
    const weeksRes = await db.query(
      `SELECT id, start_date, end_date
       FROM event_week
       WHERE event_id = $1
       ORDER BY start_date ASC`,
      [eventId]
    );

    if (weeksRes.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'No weeks found for this event.' });
    }

    const now = new Date();
    let cur =
      weeksRes.rows.find(
        w => now >= new Date(w.start_date) && now <= new Date(w.end_date)
      ) ||
      weeksRes.rows.find(w => new Date(w.start_date) > now) ||
      weeksRes.rows[weeksRes.rows.length - 1];

    // delete the lock if it exists
    const result = await db.query(
      `DELETE FROM week_lock WHERE event_week_id = $1`,
      [cur.id]
    );

    const changed = result.rowCount > 0;
    res.json({
      ok: true,
      message: changed
        ? `Unlocked event ${eventId} week ${cur.id}.`
        : `Week ${cur.id} was not locked.`
    });
  } catch (err) {
    console.error('unlock current week error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});






// ======================
// TEMP AREA
// ======================




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
