"use client";
// HeroWorld — the pinned particle journey: sticky canvas + 600vh virtual scroll,
// five statement scenes with the wireframe-glitch swap (Emotion motion grammar, Opera copy).
import { useEffect, useRef, useState } from "react";
import { registerGsap, prefersReducedMotion } from "@/lib/gsap";
import { initLenis, jumpTo } from "@/lib/lenis";
import { createHeroScene, type HeroSceneHandle } from "@/lib/heroScene";
import { HERO_VH, journeyProgress } from "@/lib/journey";
import { operaSound } from "@/lib/sound";
import { HERO_SCENES, HERO_CTA, SITE } from "@/content/opera";

// progress windows per scene (equal fifths, overlap-free swaps)
const SCENE_COUNT = HERO_SCENES.length;

/** glowing orb cursor — reference signature (pointer:fine only) */
function OrbCursor() {
  const dotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!window.matchMedia("(pointer: fine)").matches) return;
    const dot = dotRef.current!;
    const ring = ringRef.current!;
    let tx = -100, ty = -100, dx = -100, dy = -100, rx = -100, ry = -100;
    const move = (e: PointerEvent) => { tx = e.clientX; ty = e.clientY; };
    window.addEventListener("pointermove", move);
    let raf = 0;
    const tick = () => {
      dx += (tx - dx) * 0.55;
      dy += (ty - dy) * 0.55;
      rx += (tx - rx) * 0.16;
      ry += (ty - ry) * 0.16;
      dot.style.transform = `translate(${dx - 5}px, ${dy - 5}px)`;
      ring.style.transform = `translate(${rx - 19}px, ${ry - 19}px)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("pointermove", move);
      cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-50 hidden [@media(pointer:fine)]:block">
      <div
        ref={dotRef}
        className="absolute left-0 top-0 h-2.5 w-2.5 rounded-full bg-[color:var(--paper)] shadow-[0_0_0_3px_rgba(181,123,255,0.30),0_0_16px_rgba(181,123,255,0.75)]"
      />
      <div ref={ringRef} className="absolute left-0 top-0 h-[38px] w-[38px] rounded-full border border-[color:var(--violet-2)]/50" />
    </div>
  );
}

/** per-character noise-decode reveal (reference decodeProgress grammar):
 *  characters start as scramble glyphs and resolve left-to-right over ~750ms */
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ#$%&/=?*+<>@0123456789";
function ScrambleText({ text, active, delay = 0 }: { text: string; active: boolean; delay?: number }) {
  const [out, setOut] = useState(() => text);
  const rafRef = useRef(0);
  useEffect(() => {
    if (!active) {
      setOut(text);
      return;
    }
    // scramble immediately (the block is still off-screen during the handoff
    // delay) so the first visible frame is never the resolved line
    setOut(
      Array.from(text, (c) =>
        c === "\n" || c === " " ? c : GLYPHS[Math.floor(Math.random() * GLYPHS.length)],
      ).join(""),
    );
    let start = 0;
    const DURATION = 750;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION);
      const resolved = Math.floor(t * text.length);
      let acc = "";
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === "\n" || c === " ") {
          acc += c;
          continue;
        }
        acc +=
          i < resolved
            ? c
            : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
      setOut(acc);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else setOut(text);
    };
    const begin = () => {
      start = performance.now();
      rafRef.current = requestAnimationFrame(tick);
    };
    const timer = setTimeout(begin, delay);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(rafRef.current);
    };
  }, [active, text, delay]);
  return <span className="statement-solid">{out}</span>;
}

/* scroll stations — the reference's five hero screens sit at different parts of
   the frame (bottom, left, bottom, right, bottom) and hand off with a diagonal
   slide. Our order: bottom → right → bottom → left → bottom. The alternates
   unlock at the same aspect ratio where heroScene switches to its wide mark
   framing, so portrait tablets keep the stacked bottom layout. Class names stay
   literal so the Tailwind scanner sees them. */
const SCENE_LAYOUT = [
  "left-6 bottom-[22vh] max-w-[86vw] [@media(min-aspect-ratio:9/10)]:left-12 [@media(min-aspect-ratio:9/10)]:bottom-[16vh] [@media(min-aspect-ratio:9/10)]:max-w-[62vw]",
  "left-6 bottom-[22vh] max-w-[86vw] [@media(min-aspect-ratio:9/10)]:left-auto [@media(min-aspect-ratio:9/10)]:right-12 [@media(min-aspect-ratio:9/10)]:top-[24vh] [@media(min-aspect-ratio:9/10)]:bottom-auto [@media(min-aspect-ratio:9/10)]:max-w-[40vw]",
  "left-6 bottom-[22vh] max-w-[86vw] [@media(min-aspect-ratio:9/10)]:left-12 [@media(min-aspect-ratio:9/10)]:bottom-[14vh] [@media(min-aspect-ratio:9/10)]:max-w-[62vw]",
  "left-6 bottom-[22vh] max-w-[86vw] [@media(min-aspect-ratio:9/10)]:left-12 [@media(min-aspect-ratio:9/10)]:top-[30vh] [@media(min-aspect-ratio:9/10)]:bottom-auto [@media(min-aspect-ratio:9/10)]:max-w-[48vw]",
  "left-6 bottom-[22vh] max-w-[86vw] [@media(min-aspect-ratio:9/10)]:left-12 [@media(min-aspect-ratio:9/10)]:bottom-[14vh] [@media(min-aspect-ratio:9/10)]:max-w-[62vw]",
] as const;
const SCENE_CAPS_SIZE = [
  "",
  "[@media(min-aspect-ratio:9/10)]:text-[clamp(2.2rem,4.6vw,4.2rem)]",
  "",
  "",
  "",
] as const;
/* reference transition constants (HeroScreenManager): 2.5s base, outgoing
   0.4×, incoming delayed 0.12×, diagonal travel 120×80 px. */
const SLIDE_X = 120;
const SLIDE_Y = 80;

export default function HeroWorld() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<HeroSceneHandle | null>(null);
  const [active, setActive] = useState(0);
  const activeRef = useRef(0);
  const blockRefs = useRef<Array<HTMLDivElement | null>>([]);
  const dirRef = useRef(1);
  const lastProgRef = useRef(0);
  const prevActiveRef = useRef(0);
  const [bursting, setBursting] = useState(false);

  useEffect(() => {
    // station handoff — reference timeline: outgoing slides 120×80 px away over
    // 1.0 s (sine.out), incoming starts 0.3 s later offset the other way and
    // settles over 1.25 s (power2.out). Direction follows the scroll.
    const reduced = prefersReducedMotion();
    const { gsap } = registerGsap();
    const blocks = blockRefs.current.filter(Boolean) as HTMLDivElement[];
    gsap.set(blocks, { opacity: 0 });
    gsap.set(blocks[0], { opacity: 1 });
    return () => gsap.killTweensOf(blocks);
  }, []);
  useEffect(() => {
    const prev = prevActiveRef.current;
    if (active === prev) return;
    const { gsap } = registerGsap();
    const reduced = prefersReducedMotion();
    const dir = dirRef.current;
    const outEl = blockRefs.current[prev];
    const inEl = blockRefs.current[active];
    if (inEl) {
      gsap.killTweensOf(inEl);
      if (reduced) {
        gsap.set(inEl, { x: 0, y: 0, opacity: 1 });
      } else {
        gsap.set(inEl, { x: dir * SLIDE_X, y: dir * SLIDE_Y, opacity: 0 });
        gsap.to(inEl, { x: 0, y: 0, duration: 1.25, delay: 0.3, ease: "power2.out" });
        gsap.to(inEl, { opacity: 1, duration: 0.45, delay: 0.3, ease: "power2.out" });
        const pill = inEl.querySelector(".scene-pill");
        if (pill) {
          gsap.fromTo(
            pill,
            { scale: 0.8, opacity: 0, transformOrigin: "left center" },
            { scale: 1, opacity: 1, duration: 1.25, delay: 0.55, ease: "power2.out" },
          );
        }
        const lead = inEl.querySelector(".scene-lead");
        if (lead) {
          gsap.fromTo(lead, { opacity: 0 }, { opacity: 1, duration: 0.6, delay: 0.45, ease: "none" });
        }
      }
    }
    if (outEl && outEl !== inEl) {
      gsap.killTweensOf(outEl);
      if (reduced) {
        gsap.set(outEl, { x: 0, y: 0, opacity: 0 });
      } else {
        gsap.to(outEl, { x: -dir * SLIDE_X, y: -dir * SLIDE_Y, opacity: 0, duration: 1.0, ease: "sine.out" });
      }
    }
    prevActiveRef.current = active;
  }, [active]);
  useEffect(() => {
    // flash overlay tracks scene changes (covers the morph crossing)
    if (activeRef.current === 0) return;
    setBursting(true);
    const t = setTimeout(() => setBursting(false), 480);
    return () => clearTimeout(t);
  }, [active]);
  useEffect(() => {
    // statement + CTAs stay through the centred hold and the dive, then clear
    // as the ring opens. The fade is scrubbed, not a class toggle, so it stays
    // locked to the same journey progress as the canvas. The nav dips out of
    // the dive and returns as the About materialises inside the reveal.
    const reduced = prefersReducedMotion();
    const smoothstep = (v: number, a: number, b: number) => {
      const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const root = document.documentElement;
    const onScroll = () => {
      const el = document.getElementById("hero");
      if (!el) return;
      const range = el.offsetHeight - window.innerHeight;
      const raw = range > 0 ? window.scrollY / range : 0;
      operaSound.setJourney(raw);
      if (reduced) {
        root.style.setProperty("--chrome-fade", "1");
        root.style.setProperty("--nav-opacity", "1");
        root.removeAttribute("data-nav-off");
        return;
      }
      const q = journeyProgress(raw);
      root.style.setProperty("--chrome-fade", String(1 - smoothstep(q, 0.885, 0.93)));
      const navOut = smoothstep(q, 0.94, 0.965);
      const navBack = smoothstep(q, 0.97, 0.99);
      const navOpacity = Math.max(1 - navOut, navBack);
      // CSS vars survive React re-renders (the nav clock re-renders every
      // second, and an inline style set from here would be wiped by it)
      root.style.setProperty("--nav-opacity", String(navOpacity));
      root.toggleAttribute("data-nav-off", navOpacity < 0.05);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    // deterministic start: never restore a mid-journey scroll position
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    const reduced = prefersReducedMotion();
    const { gsap, ScrollTrigger } = registerGsap();
    const stopLenis = initLenis();

    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    let scene: HeroSceneHandle | null = null;
    let heroTrigger: { kill: () => void } | null = null;
    let disposed = false;

    const boot = () => {
      if (disposed) return;
      const tier = (navigator.hardwareConcurrency || 4) >= 8 ? 16000 : 9000;
      const isMobile = window.innerWidth < 768;
      operaSound.setReduced(reduced);
      scene = createHeroScene(canvas, {
        reducedMotion: reduced,
        onBeat: () => operaSound.beat(),
        onHover: (strength) => operaSound.setHover(strength),
      });
      sceneRef.current = scene;

      const onResize = () =>
        scene?.resize(canvas.clientWidth, canvas.clientHeight);
      onResize();
      window.addEventListener("resize", onResize);

      const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
      const onPointer = (e: PointerEvent) => {
        const nx = (e.clientX / window.innerWidth) * 2 - 1;
        const ny = -((e.clientY / window.innerHeight) * 2 - 1);
        scene?.setPointer(nx, ny);
      };
      if (!reduced && finePointer) window.addEventListener("pointermove", onPointer);

      if (!reduced) {
        heroTrigger = ScrollTrigger.create({
          trigger: wrap,
          start: "top top",
          end: "bottom bottom",
          scrub: true,
          onUpdate: (self) => {
            const delta = self.progress - lastProgRef.current;
            if (Math.abs(delta) > 1e-5) dirRef.current = delta > 0 ? 1 : -1;
            lastProgRef.current = self.progress;
            // the first four stations keep their old scroll distances; the
            // finale stretches across the extra hero height (lib/journey.ts)
            const q = journeyProgress(self.progress);
            // reference breakpoints: the torus owns the last quarter so it can
            // arrive, centre and hold before the dive [0.18, 0.4, 0.65, 0.76]
            const BREAKS = [0.18, 0.4, 0.65, 0.76];
            let idx = 0;
            for (let i = BREAKS.length - 1; i >= 0; i--) {
              if (q > BREAKS[i]) { idx = i + 1; break; }
            }
            // spring-based morph: shape swap + burst; physics does the travel.
            // Direction gates the ember burst so reverse crossings stay clean.
            scene?.setScene(idx, dirRef.current);
            scene?.setProgress(q);
            if (idx !== activeRef.current) {
              activeRef.current = idx;
              setActive(idx);
            }
          },
        });
      }
      return () => {
        window.removeEventListener("resize", onResize);
        window.removeEventListener("pointermove", onPointer);
      };
    };

    const cleanupBoot = boot();
    // the sections below mount before this dynamic chunk inserts the hero,
    // so their triggers measured a short page — re-measure now
    ScrollTrigger.refresh();

    // cross-route deep links ("/#work" from a case page) land on the target
    const hash = window.location.hash;
    const deep = hash.length > 1 && hash !== "#hero" ? document.getElementById(hash.slice(1)) : null;
    if (deep) {
      const y = deep.getBoundingClientRect().top + window.scrollY;
      requestAnimationFrame(() => jumpTo(y));
    } else {
      window.scrollTo(0, 0);
    }

    return () => {
      disposed = true;
      cleanupBoot?.();
      scene?.dispose();
      sceneRef.current = null;
      operaSound.leaveHero();
      stopLenis();
      heroTrigger?.kill();
    };
  }, []);

  const scene = HERO_SCENES[active];

  return (
    <div ref={wrapRef} id="hero" className="relative" style={{ height: `${HERO_VH}vh` }}>
      <OrbCursor />
      <div className="sticky top-0 h-screen overflow-hidden">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          aria-hidden="true"
        />

        {/* lens vignette — photographic edge falloff over the world, under the type */}
        <div aria-hidden="true" className="hero-vignette pointer-events-none absolute inset-0 z-[5]" />

        {/* white-violet implosion flash on scene change */}
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 z-20 transition-opacity duration-300 ${
            bursting ? "opacity-100" : "opacity-0"
          }`}
          style={{
            background:
              "radial-gradient(circle at 62% 42%, rgba(245,239,255,0.95) 0%, rgba(181,123,255,0.55) 28%, rgba(15,13,26,0) 62%)",
          }}
        />

        {/* chrome — kicker (scene 1 only) */}
        <div
          className={`absolute bottom-[41vh] left-6 z-10 transition-opacity duration-500 md:left-12 md:bottom-[38vh] ${
            active === 0 ? "opacity-100" : "opacity-0"
          }`}
        >
          <p className="mono-label flex items-center gap-2 text-[color:var(--violet-2)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--ok)]" />
            {SITE.kicker}
          </p>
        </div>

        {/* statement stations — each scene owns a fixed anchor in the frame
            (bottom → right → bottom → left → bottom) and hands off with the
            reference diagonal slide; fades during the finale dive */}
        <div
          className="absolute inset-0 z-10"
          style={{ opacity: "var(--chrome-fade, 1)" }}
        >
          {HERO_SCENES.map((s, i) => {
            const isActive = i === active;
            return (
              <div
                key={s.id}
                ref={(el) => {
                  blockRefs.current[i] = el;
                }}
                aria-hidden={!isActive}
                className={`pointer-events-none absolute z-10 opacity-0 ${SCENE_LAYOUT[i]}`}
              >
                {s.mono ? (
                  <p className="scene-pill mono-label mb-4 text-[color:var(--violet-2)]">
                    {s.mono}
                  </p>
                ) : null}
                {s.lead ? (
                  <p className="scene-lead display text-[clamp(1.4rem,3vw,2.6rem)] italic text-[color:var(--paper)]">
                    {s.lead}
                  </p>
                ) : null}
                <h1
                  className={`display mt-2 whitespace-pre-line text-[clamp(2.6rem,7.2vw,6.4rem)] uppercase text-[color:var(--paper)] ${SCENE_CAPS_SIZE[i]} ${
                    isActive ? "statement-live" : ""
                  }`}
                >
                  {/* solid + wireframe layers for the glitch swap; decode on activation */}
                  <span className="relative inline-block">
                    <ScrambleText text={s.caps} active={isActive} delay={300} />
                    <span
                      aria-hidden="true"
                      className="statement-wire pointer-events-none absolute inset-0"
                    >
                      {s.caps}
                    </span>
                  </span>
                </h1>
              </div>
            );
          })}
        </div>

        {/* CTAs — fade during the finale dive */}
        <div
          className="absolute bottom-[4vh] left-6 right-6 z-10 flex flex-col gap-3 sm:left-12 sm:right-auto sm:flex-row md:left-12"
          style={{ opacity: "var(--chrome-fade, 1)" }}
        >
          {HERO_CTA.map((c) => (
            <a
              key={c.href + c.label}
              href={c.href}
              className={`mono-label rounded-full px-5 py-2.5 transition-colors duration-200 ${
                c.label.startsWith("See")
                  ? "bg-[color:var(--paper)] text-[color:var(--ink)] hover:bg-white"
                  : "border border-[color:var(--hairline)] text-[color:var(--paper)] hover:border-[color:var(--violet-2)]"
              }`}
            >
              {c.label}
            </a>
          ))}
        </div>

        {/* scroll cue */}
        <div
          className="absolute bottom-0 left-1/2 z-10 hidden -translate-x-1/2 sm:block"
          style={{ opacity: "var(--chrome-fade, 1)" }}
        >
          <div className="flex flex-col items-center gap-2 pb-4">
            <span className="mono-label text-[color:var(--muted)]">Scroll</span>
            <span className="block h-10 w-px animate-pulse bg-[color:var(--hairline)]" />
          </div>
        </div>

        {/* est strip */}
        <div
          className="absolute bottom-6 right-6 z-10 hidden md:right-12 sm:block"
          style={{ opacity: "var(--chrome-fade, 1)" }}
        >
          <p className="mono-label text-[color:var(--muted)]">{SITE.est}</p>
        </div>

        {/* subline under the nav — scene 1 only, keeps the bottom-left
            station clear for the statement */}
        <p className={`mono-label absolute left-6 top-[14vh] z-10 hidden max-w-[22rem] leading-relaxed transition-opacity duration-500 md:left-12 md:block ${active === 0 ? "opacity-100" : "opacity-0"}`} aria-hidden={active !== 0}>
          {SITE.name} builds client products end-to-end — and ships its own. Live,
          linkable, running.
        </p>
      </div>
    </div>
  );
}
