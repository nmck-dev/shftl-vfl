fetch('/SHFTL-VFL/partials/footer.html')
  .then(res => res.text())
  .then(html => {
    document.getElementById('site-footer').innerHTML = html;
  })