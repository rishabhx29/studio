"use client";
// Opera sound — original Web Audio synthesis, no audio files. Grammar borrowed
// from the reference (section-scoped ambience bed + a one-shot fired on the same
// frame as the visual energy burst + a header toggle), every tone composed for
// our dark-space violet world: a low breathing drone and a soft sub heartbeat.
import { useEffect, useSyncExternalStore } from "react";

const PREF_KEY = "opera-sound";
const MASTER_LEVEL = 0.9;
const BED_LEVEL = 0.16;
// beats stop as the dive commits; the bed dissolves through the ink reveal so
// the About section below the journey is always silent
const BEAT_CUTOFF = 0.985;
const FADE_START = 0.96;
const HOVER_LEVEL = 0.12;

export type SoundSnapshot = { enabled: boolean; audible: boolean };
const SERVER_SNAPSHOT: SoundSnapshot = { enabled: true, audible: false };

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

class OperaSound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bedGate: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private hoverGain: GainNode | null = null;
  private hoverFilter: BiquadFilterNode | null = null;
  private hoverQuant = 0;
  private hoverWasActive = false;
  private enabled = true;
  private unlocked = false;
  private journey = 1; // silent until the hero reports its progress
  private reduced = false;
  private attached = false;
  private listeners = new Set<() => void>();
  private snapshot: SoundSnapshot = SERVER_SNAPSHOT;

  constructor() {
    if (typeof window !== "undefined") {
      this.enabled = this.readPref();
      this.snapshot = { enabled: this.enabled, audible: false };
    }
  }

  private readPref(): boolean {
    try {
      return window.localStorage.getItem(PREF_KEY) !== "off";
    } catch {
      return true; // storage unavailable (private browsing) — default on
    }
  }

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuf) return this.noiseBuf;
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    return buf;
  }

  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = this.enabled ? MASTER_LEVEL : 0;
    master.connect(ctx.destination);
    this.master = master;

    // the bed gate owns the journey fade; everything upstream breathes freely
    const bedGate = ctx.createGain();
    bedGate.gain.value = 0;
    bedGate.connect(master);
    this.bedGate = bedGate;

    const trim = ctx.createGain();
    trim.gain.value = 0.85;
    trim.connect(bedGate);

    const voice = (type: OscillatorType, freq: number, level: number, filterHz?: number) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = level;
      if (filterHz) {
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = filterHz;
        osc.connect(lp);
        lp.connect(g);
      } else {
        osc.connect(g);
      }
      g.connect(trim);
      osc.start();
    };
    // A1 root + a slightly sharp octave (slow beating) + filtered fifth +
    // faint high shimmer — a violet drone, warm and defocused
    voice("sine", 55, 0.5);
    voice("sine", 110.4, 0.2);
    voice("triangle", 164.8, 0.09, 320);
    voice("sine", 220.7, 0.04);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.12;
    lfo.connect(lfoDepth);
    lfoDepth.connect(trim.gain);
    lfo.start();

    // space air: looped noise under a soft bandpass, barely there
    const air = ctx.createBufferSource();
    air.buffer = this.noiseBuffer(ctx);
    air.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 500;
    bp.Q.value = 0.6;
    const airGain = ctx.createGain();
    airGain.gain.value = 0.035;
    air.connect(bp);
    bp.connect(airGain);
    airGain.connect(trim);
    air.start();

    // hover shimmer: grain noise swept up in pitch as the pointer stirs the
    // particles — a persistent voice at zero gain, raised only by setHover
    const hoverSrc = ctx.createBufferSource();
    hoverSrc.buffer = this.noiseBuffer(ctx);
    hoverSrc.loop = true;
    const hoverFilter = ctx.createBiquadFilter();
    hoverFilter.type = "bandpass";
    hoverFilter.frequency.value = 1400;
    hoverFilter.Q.value = 1.1;
    const hoverGain = ctx.createGain();
    hoverGain.gain.value = 0;
    hoverSrc.connect(hoverFilter);
    hoverFilter.connect(hoverGain);
    hoverGain.connect(master);
    hoverSrc.start();
    this.hoverFilter = hoverFilter;
    this.hoverGain = hoverGain;

    ctx.addEventListener("statechange", () => this.notify());
    this.applyJourney();
    return ctx;
  }

  /** called inside a user gesture — the only place a context may start */
  private unlock() {
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") void ctx.resume();
    this.unlocked = true;
    this.notify();
  }

  attach() {
    if (this.attached || typeof window === "undefined") return;
    this.attached = true;
    const onGesture = (event: Event) => {
      // the toggle manages its own unlock so a first-click mute never blips
      if (event.target instanceof Element && event.target.closest("[data-sound-toggle]")) return;
      if (this.enabled) this.unlock();
      if (this.unlocked) {
        window.removeEventListener("pointerdown", onGesture, true);
        window.removeEventListener("keydown", onGesture, true);
      }
    };
    window.addEventListener("pointerdown", onGesture, true);
    window.addEventListener("keydown", onGesture, true);
    document.addEventListener("visibilitychange", () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else if (this.unlocked && this.enabled) void this.ctx.resume();
      this.notify();
    });
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    try {
      window.localStorage.setItem(PREF_KEY, enabled ? "on" : "off");
    } catch {
      // preference is best-effort when storage is unavailable
    }
    if (enabled) this.unlock(); // a toggle click is itself the unlock gesture
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(enabled ? MASTER_LEVEL : 0, this.ctx.currentTime, 0.05);
    }
    this.notify();
  }

  /** raw hero scroll progress 0..1 — the sound field lives only inside it */
  setJourney(raw: number) {
    this.journey = Math.min(1, Math.max(0, raw));
    this.applyJourney();
    this.notify();
  }

  leaveHero() {
    this.setJourney(1);
  }

  setReduced(reduced: boolean) {
    this.reduced = reduced;
    if (reduced) this.setHover(0);
  }

  private applyJourney() {
    if (!this.ctx || !this.bedGate) return;
    const level =
      this.journey >= 1
        ? 0
        : this.journey <= FADE_START
          ? 1
          : 1 - smooth((this.journey - FADE_START) / (1 - FADE_START));
    this.bedGate.gain.setTargetAtTime(level * BED_LEVEL, this.ctx.currentTime, 0.25);
  }

  /** fired by the scene on the exact frame the visual heartbeat kicks */
  beat() {
    const ctx = this.ctx;
    const master = this.master;
    if (
      !ctx ||
      !master ||
      ctx.state !== "running" ||
      !this.enabled ||
      this.reduced ||
      document.hidden ||
      this.journey >= BEAT_CUTOFF
    ) {
      return;
    }
    const t = ctx.currentTime;
    // soft sub thump — the visual kick is gentle (0.16), so this is a felt
    // pulse, not a drum hit: 110→42 Hz sweep, 12 ms attack, ~0.65 s tail
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.3);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 250;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.6, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
    osc.connect(lp);
    lp.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + 0.7);
    // ember exhale — the batch that leaves the surface on each beat
    const air = ctx.createBufferSource();
    air.buffer = this.noiseBuffer(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 900;
    const airGain = ctx.createGain();
    airGain.gain.setValueAtTime(0, t);
    airGain.gain.linearRampToValueAtTime(0.05, t + 0.025);
    airGain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    air.connect(hp);
    hp.connect(airGain);
    airGain.connect(master);
    air.start(t, Math.random() * 0.5);
    air.stop(t + 0.5);
  }

  /** pointer energy over the particle mark, 0..1 — fired every scene frame */
  setHover(strength: number) {
    const ctx = this.ctx;
    const gain = this.hoverGain;
    const filter = this.hoverFilter;
    if (
      !ctx ||
      !gain ||
      !filter ||
      ctx.state !== "running" ||
      !this.enabled ||
      this.reduced ||
      document.hidden ||
      this.journey >= BEAT_CUTOFF
    ) {
      if (this.hoverQuant !== 0) {
        this.hoverQuant = 0;
        this.hoverWasActive = false;
        if (ctx && gain) gain.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
      }
      return;
    }
    const q = Math.round(Math.min(1, Math.max(0, strength)) * 100) / 100;
    if (q === this.hoverQuant) return;
    this.hoverQuant = q;
    const t = ctx.currentTime;
    gain.gain.setTargetAtTime(q * HOVER_LEVEL, t, q > 0 ? 0.08 : 0.15);
    filter.frequency.setTargetAtTime(1400 + q * 2600, t, 0.08);
    // a tiny glass tick on entering the field — the visual dent's first contact
    if (q > 0 && !this.hoverWasActive && this.master) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(1900, t);
      osc.frequency.exponentialRampToValueAtTime(1200, t + 0.06);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + 0.1);
    }
    this.hoverWasActive = q > 0;
  }

  private computeAudible(): boolean {
    if (typeof document === "undefined") return false;
    return (
      this.enabled &&
      this.unlocked &&
      this.journey < 1 &&
      !!this.ctx &&
      this.ctx.state === "running" &&
      !document.hidden
    );
  }

  private notify() {
    const audible = this.computeAudible();
    if (audible === this.snapshot.audible && this.enabled === this.snapshot.enabled) return;
    this.snapshot = { enabled: this.enabled, audible };
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): SoundSnapshot => this.snapshot;
  getServerSnapshot = (): SoundSnapshot => SERVER_SNAPSHOT;
}

export const operaSound = new OperaSound();

export function useOperaSound() {
  const snapshot = useSyncExternalStore(
    operaSound.subscribe,
    operaSound.getSnapshot,
    operaSound.getServerSnapshot,
  );
  useEffect(() => {
    operaSound.attach();
  }, []);
  return {
    enabled: snapshot.enabled,
    audible: snapshot.audible,
    toggle: () => operaSound.setEnabled(!snapshot.enabled),
  };
}