// Shared behaviour of the public pages: reveal on scroll with a safety net, the service worker, and page links that
// work when a page is opened as a local file. A classic script, so it loads from file:// too.
(() => {
  const root = document.body;
  root.classList.add("js");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const all = () => document.querySelectorAll(".reveal, .reveal-2, .reveal-3");
  if (reduce || !("IntersectionObserver" in window)) all().forEach((el) => el.classList.add("in"));
  else {
    const io = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    all().forEach((el) => io.observe(el));
    // what the reader has not scrolled to yet appears on its own after a moment: no blank sections in a screenshot or a slow scroll
    setTimeout(() => all().forEach((el) => el.classList.add("in")), 2500);
    new MutationObserver(() => all().forEach((el) => { if (!el.classList.contains("in")) io.observe(el); })).observe(document.body, { childList: true, subtree: true });
  }
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("/sw.js").catch(() => {});
  if (location.protocol === "file:") document.addEventListener("click", (e) => { const a = e.target.closest && e.target.closest("a[href]"); if (!a) return; const m = /^(console|login|explorer|dashboard|docs|index|privacy|app|how-it-works|verify|code)([?#].*)?$/.exec(a.getAttribute("href")); if (m) a.setAttribute("href", m[1] + ".html" + (m[2] || "")); }, true);
})();
