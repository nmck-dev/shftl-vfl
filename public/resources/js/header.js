fetch('/partials/header.html')
  .then(res => res.text())
  .then(html => {
    document.getElementById('site-header').innerHTML = html;

    // Active link detection
    (function markActiveNav() {
      function norm(href) {
        const u = new URL(href, window.location.href);
        let p = u.pathname.replace(/index\.html$/i, "");
        p = p.replace(/\/+$/, "/");
        if (p === "") p = "/";
        return p;
      }

      const current = norm(window.location.href);
      let best = null;
      document.querySelectorAll(".main-nav a[href]").forEach(a => {
        const target = norm(a.href);
        const isExact = current === target;
        const isSection = target !== "/" && current.startsWith(target);
        if (isExact || isSection) {
          if (!best || target.length > best.len) best = { el: a, len: target.length };
        }
      });

      if (!best && current.endsWith("/")) {
        document.querySelectorAll(".main-nav a[href]").forEach(a => {
          const target = norm(a.href);
          if (target === current) best = { el: a, len: target.length };
        });
      }

      if (best) best.el.classList.add("active");
    })();
  });

  fetch('http://localhost:3000/api/me', { credentials: 'include' })
  .then(r => r.json())
  .then(({ user }) => {
    if (user) {
      // render avatar/username in your header
      console.log('Logged in as', user.username);
    }
  });
