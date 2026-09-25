/**
 * Originkit Particle Drift (particle-drift-02 preset)
 * Interactive Canvas particle field with neighbor connection lines,
 * cursor tethering, and responsive dynamic theme styling.
 * Seamlessly repeatable across all website sections without stretching.
 */

function setupSingleCanvas(canvas) {
  if (!canvas) return () => {};
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  const isFixed = window.getComputedStyle(canvas).position === 'fixed';
  const container = isFixed
    ? window
    : (canvas.closest('.section') || canvas.closest('.hero') || canvas.closest('.panel') || canvas.parentElement || document.body);

  let width = 0;
  let height = 0;
  let dpr = 1;
  let animId = null;
  let running = false;
  let mouseX = -9999;
  let mouseY = -9999;
  let mouseOver = false;

  const isDark = () => document.documentElement.getAttribute('data-theme') !== 'light';

  const config = {
    maxDistance: 130,
    mouseRadius: 165,
    speed: 0.32,
    particleCountFactor: 16000,
    minParticles: 25,
    maxParticles: 75,
  };

  let particles = [];

  class Particle {
    constructor() {
      this.reset(true);
    }

    reset(initial = false) {
      this.x = initial ? Math.random() * width : Math.random() > 0.5 ? 0 : width;
      this.y = initial ? Math.random() * height : Math.random() * height;
      const angle = Math.random() * Math.PI * 2;
      const speed = (0.2 + Math.random() * 0.3) * config.speed;
      this.vx = Math.cos(angle) * speed;
      this.vy = Math.sin(angle) * speed;
      this.radius = 1.2 + Math.random() * 1.5;
      this.baseAlpha = 0.22 + Math.random() * 0.42;
      this.alpha = this.baseAlpha;
      this.targetAlpha = this.baseAlpha;
      this.tone = Math.random() > 0.65 ? 'cyan' : 'accent';
    }

    update() {
      let nearMouse = false;
      if (mouseOver) {
        const dx = mouseX - this.x;
        const dy = mouseY - this.y;
        const dist = Math.hypot(dx, dy);

        if (dist < config.mouseRadius && dist > 0) {
          nearMouse = true;
          this.targetAlpha = 0.9;
          const pull = ((config.mouseRadius - dist) / config.mouseRadius) * 0.015;
          this.vx += (dx / dist) * pull;
          this.vy += (dy / dist) * pull;
        }
      }

      if (!nearMouse) {
        this.targetAlpha = this.baseAlpha;
      }

      this.alpha += (this.targetAlpha - this.alpha) * 0.08;
      this.vx *= 0.985;
      this.vy *= 0.985;

      const currentSpeed = Math.hypot(this.vx, this.vy);
      if (currentSpeed < 0.15 * config.speed) {
        this.vx += (Math.random() - 0.5) * 0.05;
        this.vy += (Math.random() - 0.5) * 0.05;
      }

      this.x += this.vx;
      this.y += this.vy;

      const pad = 20;
      if (this.x < -pad) this.x = width + pad;
      else if (this.x > width + pad) this.x = -pad;
      if (this.y < -pad) this.y = height + pad;
      else if (this.y > height + pad) this.y = -pad;
    }

    draw(themeDark) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);

      let color;
      if (themeDark) {
        color = this.tone === 'cyan'
          ? `rgba(56, 189, 248, ${this.alpha})`
          : `rgba(129, 140, 248, ${this.alpha})`;
      } else {
        color = this.tone === 'cyan'
          ? `rgba(2, 132, 199, ${this.alpha * 0.8})`
          : `rgba(79, 70, 229, ${this.alpha * 0.85})`;
      }

      ctx.fillStyle = color;
      if (this.alpha > 0.6) {
        ctx.shadowColor = color;
        ctx.shadowBlur = themeDark ? 6 : 3;
      }
      ctx.fill();
      ctx.restore();
    }
  }

  function resize() {
    if (isFixed || container === window) {
      width = window.innerWidth;
      height = window.innerHeight;
    } else {
      const rect = container.getBoundingClientRect();
      width = rect.width || window.innerWidth;
      height = rect.height || container.clientHeight || 700;
    }

    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const targetCount = Math.min(
      config.maxParticles,
      Math.max(config.minParticles, Math.floor((width * height) / config.particleCountFactor))
    );

    if (particles.length === 0) {
      for (let i = 0; i < targetCount; i++) particles.push(new Particle());
    } else if (particles.length < targetCount) {
      while (particles.length < targetCount) particles.push(new Particle());
    } else if (particles.length > targetCount) {
      particles.length = targetCount;
    }
  }

  function render() {
    if (!running) return;

    ctx.clearRect(0, 0, width, height);

    const themeDark = isDark();
    const maxDist = config.maxDistance;
    const maxDistSq = maxDist * maxDist;

    const n = particles.length;
    for (let i = 0; i < n; i++) {
      const p1 = particles[i];
      p1.update();

      for (let j = i + 1; j < n; j++) {
        const p2 = particles[j];
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const distSq = dx * dx + dy * dy;

        if (distSq < maxDistSq) {
          const dist = Math.sqrt(distSq);
          const lineAlpha = (1 - dist / maxDist) * 0.22 * Math.min(p1.alpha, p2.alpha);
          if (lineAlpha > 0.01) {
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = themeDark
              ? `rgba(129, 140, 248, ${lineAlpha})`
              : `rgba(79, 70, 229, ${lineAlpha * 0.9})`;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }

      if (mouseOver) {
        const dx = mouseX - p1.x;
        const dy = mouseY - p1.y;
        const dist = Math.hypot(dx, dy);

        if (dist < config.mouseRadius) {
          const tetherAlpha = (1 - dist / config.mouseRadius) * 0.45;
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(mouseX, mouseY);
          ctx.strokeStyle = themeDark
            ? `rgba(165, 180, 252, ${tetherAlpha})`
            : `rgba(99, 102, 241, ${tetherAlpha * 0.85})`;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }

      p1.draw(themeDark);
    }

    animId = requestAnimationFrame(render);
  }

  function onPointerMove(e) {
    const rect = canvas.getBoundingClientRect();
    mouseX = e.clientX - rect.left;
    mouseY = e.clientY - rect.top;
    mouseOver = mouseX >= 0 && mouseX <= rect.width && mouseY >= 0 && mouseY <= rect.height;
  }

  function onPointerLeave() {
    mouseOver = false;
    mouseX = -9999;
    mouseY = -9999;
  }

  function start() {
    if (running) return;
    running = true;
    animId = requestAnimationFrame(render);
  }

  function stop() {
    running = false;
    if (animId) {
      cancelAnimationFrame(animId);
      animId = null;
    }
  }

  window.addEventListener('resize', resize, { passive: true });
  const eventTarget = isFixed ? window : container;
  eventTarget.addEventListener('pointermove', onPointerMove, { passive: true });
  eventTarget.addEventListener('pointerleave', onPointerLeave, { passive: true });

  const observer = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && !document.hidden) start();
    else stop();
  }, { threshold: 0.01 });
  observer.observe(canvas);

  const onVisibility = () => {
    if (document.hidden) stop();
    else start();
  };
  document.addEventListener('visibilitychange', onVisibility);

  resize();
  start();

  return () => {
    stop();
    window.removeEventListener('resize', resize);
    eventTarget.removeEventListener('pointermove', onPointerMove);
    eventTarget.removeEventListener('pointerleave', onPointerLeave);
    document.removeEventListener('visibilitychange', onVisibility);
    observer.disconnect();
  };
}

export function initParticleDrift(targets = document.querySelectorAll('[data-particle-drift]')) {
  let list = [];
  if (targets instanceof NodeList || Array.isArray(targets)) {
    list = Array.from(targets);
  } else if (targets instanceof Element) {
    list = [targets];
  } else if (typeof targets === 'string') {
    list = Array.from(document.querySelectorAll(targets));
  }

  if (list.length === 0) return () => {};
  const cleanups = list.map(setupSingleCanvas);
  return () => cleanups.forEach((c) => c && c());
}
