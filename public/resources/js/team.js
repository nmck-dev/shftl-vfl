document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('player-overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const playerList = document.getElementById('player-list');
  const closeBtn = document.getElementById('close-overlay');

  // Temporary mock data; you’ll swap to /api/players?role=... later
  const allPlayers = [
    { id: 1, ign: 'Derke',     role: 'duelist',    team: 'FNATIC',    cost: 12, avg_fp: 18.4, img: 'https://placehold.co/80x80?text=D' },
    { id: 2, ign: 'Leo',       role: 'initiator',  team: 'FNATIC',    cost: 11, avg_fp: 17.2, img: 'https://placehold.co/80x80?text=L' },
    { id: 3, ign: 'saadhak',   role: 'controller', team: 'LOUD',      cost: 10, avg_fp: 16.0, img: 'https://placehold.co/80x80?text=S' },
    { id: 4, ign: 'Less',      role: 'sentinel',   team: 'LOUD',      cost:  9, avg_fp: 15.1, img: 'https://placehold.co/80x80?text=Le' },
    { id: 5, ign: 'TenZ',      role: 'duelist',    team: 'SEN',       cost:  8, avg_fp: 14.9, img: 'https://placehold.co/80x80?text=T' },
    { id: 6, ign: 'Crashies',  role: 'initiator',  team: 'NRG',       cost:  8, avg_fp: 14.2, img: 'https://placehold.co/80x80?text=C' },
    { id: 7, ign: 'nAts',      role: 'controller', team: 'KC',        cost:  9, avg_fp: 16.7, img: 'https://placehold.co/80x80?text=n' },
    { id: 8, ign: 'Boaster',   role: 'controller', team: 'FNATIC',    cost:  7, avg_fp: 13.3, img: 'https://placehold.co/80x80?text=B' },
    { id: 9, ign: 'Chronicle', role: 'wildcard',   team: 'FNATIC',    cost: 11, avg_fp: 17.8, img: 'https://placehold.co/80x80?text=Ch' },
  ];

  // Click listeners for the six active slots
  document.querySelectorAll('.squad-grid > div').forEach(slot => {
    slot.addEventListener('click', () => {
      const role = slot.className.trim(); // 'duelist' | 'initiator' | ...
      openOverlay(role, slot);
    });
  });

  closeBtn.addEventListener('click', closeOverlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeOverlay(); // click backdrop to close
  });

  function openOverlay(role, slotEl) {
    overlayTitle.textContent = `Select ${titleCase(role)}`;
    playerList.innerHTML = '';

    // Add header row
    const header = document.createElement('div');
    header.className = 'player-list-header';
    header.innerHTML = `
      <div></div>
      <div class="hdr-ign">IGN</div>
      <div class="hdr-role">Role</div>
      <div class="hdr-team">Team</div>
      <div class="hdr-cost">Cost</div>
      <div class="hdr-avg">Avg FP/G</div>
    `;
    playerList.appendChild(header);

    // Filter: wildcard sees all; role sees matching + wildcard
    const players = role === 'wildcard'
      ? allPlayers
      : allPlayers.filter(p => p.role === role || p.role === 'wildcard');

    // Sort example (highest avg first). Tweak as you like.
    players.sort((a, b) => b.avg_fp - a.avg_fp);

    players.forEach(p => {
      const row = document.createElement('div');
      row.className = 'player-row';
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.innerHTML = `
        <img class="player-img" src="${p.img}" alt="${p.ign} portrait"
            onerror="this.src='https://placehold.co/80x80?text=?'"/>
        <div class="col-ign">${escapeHTML(p.ign)}</div>
        <div class="col-role">${titleCase(p.role)}</div>
        <div class="col-team">${escapeHTML(p.team || '-')}</div>
        <div class="col-cost">${Number(p.cost).toFixed(0)}&nbsp;VP</div>
        <div class="col-avg">${Number(p.avg_fp).toFixed(1)}</div>
      `;
      row.addEventListener('click', () => selectPlayer(p, role, slotEl));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectPlayer(p, role, slotEl); }
      });
      playerList.appendChild(row);
    });

    overlay.classList.remove('hidden');
  }

  function closeOverlay() {
    overlay.classList.add('hidden');
  }

  function selectPlayer(player, role, slotEl) {
    // TODO next step: render a compact player card in the clicked slot
    // and POST the updated roster to your backend
    console.log(`Selected: ${player.ign} for ${role}`, player);
    closeOverlay();
  }

  function titleCase(s) { return s ? (s[0].toUpperCase() + s.slice(1)) : s; }
  function escapeHTML(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
      { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
    ));
  }
});