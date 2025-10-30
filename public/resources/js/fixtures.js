document.addEventListener('DOMContentLoaded', () => {
  // ---------- Config ----------
  const DATA_URL = '/data/events.json';
  const DATE_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

  // ---------- State ----------
  const tabsWrap = document.querySelector('.event-tabs');
  const panel = document.getElementById('fixtures-panel');
  let events = [];
  let matches = [];
  let activeEventId = null;

  // ---------- Helpers ----------
  const isUpcoming = (m) => new Date(m.datetime) >= new Date();
  const byDateTimeAsc = (a, b) => new Date(a.datetime) - new Date(b.datetime);

  function a11yId(suffix) { return `id-${suffix}-${Math.random().toString(36).slice(2, 8)}`; }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function gameCard(m) {
    const dt = new Date(m.datetime);
    const card = document.createElement('article');
    card.className = 'game-card';
    card.innerHTML = `
      <div class="gc-head">
        <time class="gc-time" datetime="${m.datetime}">
          ${DATE_FMT.format(dt)} • ${TIME_FMT.format(dt)}
        </time>
        ${m.bo ? `<span class="gc-bo">${m.bo}</span>` : ''}
      </div>
      <div class="gc-body">
        <div class="team team1">${m.team1}</div>
        <div class="vs">vs</div>
        <div class="team team2">${m.team2}</div>
      </div>
      <div class="gc-foot">
        ${m.stage ? `<span class="gc-stage">${m.stage}</span>` : ''}
        ${m.stream ? `<a class="gc-stream" href="${m.stream}" target="_blank" rel="noopener">Watch</a>` : ''}
      </div>
    `;
    return card;
  }

  // ---------- Layout renderers ----------
  function renderTournamentLayout(eventId) {
    const list = matches
      .filter(m => m.eventId === eventId)
      .filter(isUpcoming)
      .sort(byDateTimeAsc);

    if (!list.length) {
      panel.innerHTML = `<p>No upcoming matches for this event.</p>`;
      return;
    }

    const wrap = document.createElement('section');
    wrap.className = 'tournament-grid'; // style as grid in CSS
    list.forEach(m => wrap.appendChild(gameCard(m)));

    clear(panel);
    panel.appendChild(wrap);
  }

  function renderSplitLayout(eventId) {
    const list = matches
      .filter(m => m.eventId === eventId)
      .filter(isUpcoming)
      .sort((a, b) => (a.week ?? 0) - (b.week ?? 0) || byDateTimeAsc(a, b));

    if (!list.length) {
      panel.innerHTML = `<p>No upcoming matches for this split.</p>`;
      return;
    }

    // group by week
    const weeks = new Map();
    list.forEach(m => {
      const wk = m.week ?? 0;
      if (!weeks.has(wk)) weeks.set(wk, []);
      weeks.get(wk).push(m);
    });

    const frag = document.createDocumentFragment();

    Array.from(weeks.keys()).sort((a, b) => a - b).forEach(weekNum => {
      const row = document.createElement('section');
      row.className = 'split-week';

      const header = document.createElement('div');
      header.className = 'split-week-header';
      header.textContent = `Week ${weekNum}`;
      row.appendChild(header);

      const rail = document.createElement('div');
      rail.className = 'split-week-rail'; // flex row of cards
      weeks.get(weekNum).forEach(m => rail.appendChild(gameCard(m)));

      row.appendChild(rail);
      frag.appendChild(row);
    });

    clear(panel);
    panel.appendChild(frag);
  }

  // ---------- Tabs ----------
  function renderTabs() {
    clear(tabsWrap);
    events.forEach((ev, idx) => {
      const btn = document.createElement('button');
      btn.className = 'event-tab';
      btn.type = 'button';
      btn.id = `tab-${ev.id}`;
      btn.role = 'tab';
      btn.setAttribute('aria-controls', `panel-${ev.id}`);
      btn.setAttribute('aria-selected', ev.id === activeEventId ? 'true' : 'false');
      btn.tabIndex = ev.id === activeEventId ? 0 : -1;
      btn.textContent = ev.name;

      btn.addEventListener('click', () => activateEvent(ev.id));
      btn.addEventListener('keydown', (e) => handleTabKeys(e));

      tabsWrap.appendChild(btn);

      if (idx === 0) {
        panel.id = `panel-${ev.id}`;
        panel.setAttribute('aria-labelledby', `tab-${ev.id}`);
      }
    });
  }

  function handleTabKeys(e) {
    const tabs = Array.from(tabsWrap.querySelectorAll('.event-tab'));
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;

    let j = i;
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
    if (e.key === 'ArrowLeft')  j = (i - 1 + tabs.length) % tabs.length;
    if (e.key === 'Home')       j = 0;
    if (e.key === 'End')        j = tabs.length - 1;

    if (j !== i) { e.preventDefault(); tabs[j].focus(); }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateEvent(events[j].id); }
  }

  function activateEvent(eventId) {
    if (!eventId || eventId === activeEventId) return;
    activeEventId = eventId;

    tabsWrap.querySelectorAll('.event-tab').forEach(tab => {
      const sel = tab.id === `tab-${eventId}`;
      tab.setAttribute('aria-selected', sel ? 'true' : 'false');
      tab.tabIndex = sel ? 0 : -1;
    });

    panel.id = `panel-${eventId}`;
    panel.setAttribute('aria-labelledby', `tab-${eventId}`);

    const ev = events.find(e => e.id === eventId);
    if (!ev) return;

    if (ev.layout === 'split') {
      renderSplitLayout(eventId);
    } else {
      renderTournamentLayout(eventId);
    }

    history.replaceState(null, '', `#${eventId}`);
  }

  // ---------- Init ----------
  (async function init() {
    try {
      const res = await fetch(DATA_URL, { cache: 'no-store' });
      const data = await res.json();
      events = data.events ?? [];
      matches = data.matches ?? [];

      if (!events.length) {
        panel.textContent = 'No events available.';
        return;
      }

      // choose initial event: hash -> first with upcoming -> first
      const hashId = (location.hash || '').replace(/^#/, '');
      const firstWithUpcoming = events.find(ev => matches.some(m => m.eventId === ev.id && isUpcoming(m)));
      activeEventId = events.some(e => e.id === hashId) ? hashId : (firstWithUpcoming?.id || events[0].id);

      renderTabs();
      activateEvent(activeEventId);
    } catch (err) {
      console.error(err);
      panel.textContent = 'Failed to load fixtures.';
    }
  })();
});
