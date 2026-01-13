document.addEventListener('DOMContentLoaded', () => {
  function scrollToHash(hash, smooth = true) {
    if (!hash) return;
    const el = document.querySelector(hash);
    if (el) {
      const nav = document.querySelector('.navbar-sec');
      const offset = nav ? nav.offsetHeight : 90;
      const top = el.getBoundingClientRect().top + window.pageYOffset - offset - 8;
      window.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
    }
  }

  // If page loads with a hash, jump to it (no smooth to avoid double animation)
  if (window.location.hash) {
    scrollToHash(window.location.hash, false);
  }

  // Intercept all same-page anchor clicks and scroll with offset
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', (e) => {
      const href = a.getAttribute('href');
      if (!href || href === '#') return;
      // Only handle anchors that refer to elements on the page
      if (href.startsWith('#')) {
        const target = document.querySelector(href);
        if (target) {
          e.preventDefault();
          scrollToHash(href, true);
          // update the URL hash without jumping
          history.pushState(null, '', href);
        }
      }
    });
  });
});
