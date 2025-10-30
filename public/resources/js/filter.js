document.addEventListener('DOMContentLoaded', () => {
    function initPlayerFilters() {
        const form = document.getElementById('player-filters');
        const tbody = document.querySelector('#players-table tbody');
        if (!form || !tbody) return;

        const qInput = form.querySelector('input[name="q"]');
        const minSel = form.querySelector('#cost_min');
        const maxSel = form.querySelector('#cost_max');
        const teamSel = form.querySelector('#team');
        const roleSel = form.querySelector('#role');
        const resetBtn = document.getElementById('filters-reset');

        // Helpers
        const parseVP = (v) => {
            if (!v) return null;
            const match = String(v).match(/\d+/);
            return match ? parseInt(match[0], 10) : null;
        };


        // Ensures min <= max
        function normalizeRange(minVal, maxVal) {
            if (minVal != null && maxVal != null && minVal > maxVal) {
                const tmp = minVal;
                minVal = maxVal;
                maxVal = tmp;
            }
            return [minVal, maxVal];
        }

        function applyFilters() {
            const rows = Array.from(document.querySelectorAll('.player-row'));

            const q = (qInput.value || '').trim().toLowerCase();
            let minVal = parseVP(cost_min.value);
            let maxVal = parseVP(cost_max.value);
            [minVal, maxVal] = normalizeRange(minVal, maxVal);

            const team = (teamSel.value || '').toLowerCase();
            const role = (roleSel.value || '').toLowerCase();

            let visibleCount = 0;

            rows.forEach(row => {
                const nameVal = (row.dataset.name || '').toLowerCase();
                const teamVal = (row.dataset.team || '').toLowerCase();
                const roleVal = (row.dataset.role || '').toLowerCase();
                const costVal = parseVP(row.dataset.cost);

                let ok = true;

                if(q && !nameVal.includes(q)) ok = false;
                if(team && team !== teamVal) ok = false;
                if(role && role !== roleVal) ok = false;
                if(minVal != null && costVal < minVal) ok = false;
                if(maxVal != null && costVal > maxVal) ok = false;

                row.style.display = ok ? '' : 'none';
                if (ok) visibleCount ++;
            });

            let empty = document.querySelector('.empty-state');
            if (!empty) {
                empty = document.createElement('div');
                empty.className = 'empty-state';
                empty.style.cssText = 'color:#ffffff;opacity:.7;text-align:center;padding:16px;';
                empty.textContent = 'No players match your filters.';
                empty.hidden = true;

                const table = document.getElementById('players-table');
                (table?.parentElement || tbody.parentElement).appendChild (empty);
            }
            empty.hidden = visibleCount > 0;
        }

        // Events
        qInput.addEventListener('input', applyFilters);
        minSel.addEventListener('change', applyFilters);
        maxSel.addEventListener('change', applyFilters);
        teamSel.addEventListener('change', applyFilters);
        roleSel.addEventListener('change', applyFilters);

        resetBtn.addEventListener('click', () => {
            form.reset();
            applyFilters();
        });

        applyFilters();
    }


        // Initial Run
        document.addEventListener('players-ready', initPlayerFilters);

        initPlayerFilters();
    });