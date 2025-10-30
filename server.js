const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// allow JSON & CORS
app.use(cors());
app.use(express.json());

// serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// test route to prove backend works
app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Backend is running' });
});

// fallback: serve index.html for /
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
