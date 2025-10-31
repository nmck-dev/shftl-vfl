const express = require('express');
const path = require('path');
const cors = require('cors');
const db = require('./db');   // <--- make sure this is here

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', async (req, res) => {
  try {
    const result = await db.query('SELECT NOW() AS now');
    res.json({ ok: true, db_time: result.rows[0].now });
  } catch (err) {
    console.error('DB error in /api/health:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// Temporary Setup route to create tables
app.get('/api/setup/core-tables', async (req, res) => {
  try {
    // 1. users
    await db.query(`
      CREATE TABLE IF NOT EXISTS app_user (
        id           BIGSERIAL PRIMARY KEY,
        discord_id   TEXT UNIQUE,
        email        TEXT UNIQUE,
        display_name TEXT,
        created_at   TIMESTAMPTZ DEFAULT now()
      );
    `);

    // 2. events
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_type') THEN
          CREATE TYPE event_type AS ENUM ('TOURNAMENT', 'SPLIT');
        END IF;
      END
      $$;
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS event (
        id           BIGSERIAL PRIMARY KEY,
        slug         TEXT UNIQUE NOT NULL,
        name         TEXT NOT NULL,
        type         event_type NOT NULL DEFAULT 'TOURNAMENT',
        start_date   DATE NOT NULL,
        end_date     DATE NOT NULL,
        is_active    BOOLEAN DEFAULT TRUE
      );
    `);

    // 3. fantasy teams (user’s team for an event)
    await db.query(`
      CREATE TABLE IF NOT EXISTS fantasy_team (
        id         BIGSERIAL PRIMARY KEY,
        user_id    BIGINT REFERENCES app_user(id) ON DELETE CASCADE,
        event_id   BIGINT REFERENCES event(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE (user_id, event_id)
      );
    `);

    // 4. players (the pro player pool)
    await db.query(`
      CREATE TABLE IF NOT EXISTS player (
        id        BIGSERIAL PRIMARY KEY,
        handle    TEXT NOT NULL,
        real_name TEXT,
        country   TEXT,
        active    BOOLEAN DEFAULT TRUE
      );
    `);

    res.json({ ok: true, message: 'Core tables created (or already existed).' });
  } catch (err) {
    console.error('setup error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});



app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
