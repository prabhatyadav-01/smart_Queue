/* Motion: smooth scroll (Lenis), reveals, magnetic buttons, pointer tilt, parallax, page transitions. */
import { $$, reducedMotion } from './ui.js';

let lenis = null;
const NAV_OFFSET = -96;

export function initSmoothScroll() {
  if (reducedMotion() || typeof window.Lenis !== 'function') return null;
  lenis = new window.Lenis({ duration: 1.15, easing: (t) => Math.min(1, 1.001 - 2 ** (-10 * t)), smoothWheel: true });
  const raf = (time) => {
    lenis.raf(time);
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  return lenis;
}

export function scrollToTarget(target) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) return;
  if (lenis) lenis.scrollTo(el, { offset: NAV_OFFSET });
  else el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

export function initAnchorLinks() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const hash = a.getAttribute('href');
    if (hash.length < 2) return;
    const el = document.getElementById(hash.slice(1));
    if (!el) return;
    e.preventDefault();
    document.querySelector('.nav')?.classList.remove('menu-open');
    scrollToTarget(el);
    history.replaceState(null, '', hash);
  });
}

export function initReveal(root = document) {
  const items = $$('.reveal', root);
  $$('[data-stagger]', root).forEach((group) => {
    [...group.children].forEach((child, i) => child.style.setProperty('--d', `${i * 70}ms`));
  });
  if (reducedMotion() || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.1 });
  items.forEach((el) => io.observe(el));
}

export function initMagnetic(root = document) {
  if (reducedMotion() || window.matchMedia('(hover: none)').matches) return;
  $$('[data-magnetic]', root).forEach((el) => {
    if (el.dataset.magneticBound) return;
    el.dataset.magneticBound = '1';
    const strength = Number(el.dataset.magnetic) || 0.28;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - (r.left + r.width / 2)) * strength;
      const y = (e.clientY - (r.top + r.height / 2)) * strength;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    });
    el.addEventListener('pointerleave', () => {
      el.style.transform = '';
    });
  });
}

/**
 * Gentle pointer-driven 3D tilt + light position for `el`.
 * Writes --rx/--ry (deg) and --lx/--ly (%) with damping.
 */
export function initTilt(el, { max = 7 } = {}) {
  if (!el || reducedMotion() || window.matchMedia('(hover: none)').matches) return;
  let tx = 0;
  let ty = 0;
  let cx = 0;
  let cy = 0;
  let running = false;
  const frame = () => {
    cx += (tx - cx) * 0.08;
    cy += (ty - cy) * 0.08;
    el.style.setProperty('--rx', `${(-cy * max).toFixed(2)}deg`);
    el.style.setProperty('--ry', `${(cx * max).toFixed(2)}deg`);
    el.style.setProperty('--lx', `${(50 + cx * 40).toFixed(1)}%`);
    el.style.setProperty('--ly', `${(30 + cy * 40).toFixed(1)}%`);
    if (Math.abs(tx - cx) > 0.001 || Math.abs(ty - cy) > 0.001) requestAnimationFrame(frame);
    else running = false;
  };
  window.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    tx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (window.innerWidth / 2)));
    ty = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (window.innerHeight / 2)));
    if (!running) {
      running = true;
      requestAnimationFrame(frame);
    }
  }, { passive: true });
}

export function initHover3D(root = document) {
  if (reducedMotion() || window.matchMedia('(hover: none)').matches) return;
  const items = $$('.card, .btn', root).filter(el => 
    !el.classList.contains('btn-ghost') && 
    !el.classList.contains('btn-icon') &&
    !el.classList.contains('booker') &&
    !el.classList.contains('book-panel') &&
    !el.classList.contains('slot') &&
    !el.classList.contains('date-btn') &&
    !el.closest('.booker') &&
    !el.closest('.book-panel') &&
    !el.closest('.modal') &&
    !el.closest('.slot-grid')
  );
  items.forEach(el => {
    if (el.dataset.hover3dBound) return;
    el.dataset.hover3dBound = '1';
    
    el.style.transformStyle = 'preserve-3d';
    
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      const y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const max = el.classList.contains('btn') ? 12 : 5;
      
      el.style.transform = `perspective(1000px) rotateX(${(-y * max).toFixed(2)}deg) rotateY(${(x * max).toFixed(2)}deg) translateZ(4px)`;
      el.style.transition = 'none';
    });
    
    el.addEventListener('pointerleave', () => {
      el.style.transform = '';
      el.style.transition = 'transform 0.4s ease-out';
      setTimeout(() => el.style.transition = '', 400);
    });
  });
}

/** Elements with data-parallax="0.1" drift relative to scroll (via --py). */
export function initParallax() {
  const items = $$('[data-parallax]');
  if (!items.length || reducedMotion()) return;
  let queued = false;
  const update = () => {
    queued = false;
    const vh = window.innerHeight;
    for (const el of items) {
      const r = el.getBoundingClientRect();
      if (r.bottom < -200 || r.top > vh + 200) continue;
      const offset = (r.top + r.height / 2 - vh / 2) * Number(el.dataset.parallax);
      el.style.setProperty('--py', `${offset.toFixed(1)}px`);
    }
  };
  const onScroll = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(update);
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  update();
}

/** Fade-out before same-origin navigation where cross-document View Transitions aren't supported. */
export function initPageTransitions() {
  if ('PageRevealEvent' in window || reducedMotion()) return;
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || (url.pathname === location.pathname && url.hash)) return;
    e.preventDefault();
    document.documentElement.classList.add('is-leaving');
    setTimeout(() => {
      location.href = url.href;
    }, 200);
  });
  window.addEventListener('pageshow', () => document.documentElement.classList.remove('is-leaving'));
}

export function initMotion() {
  initSmoothScroll();
  initAnchorLinks();
  initReveal();
  initMagnetic();
  initHover3D();
  initParallax();
  initPageTransitions();
}
