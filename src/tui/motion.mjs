// Motion.
//
// A terminal has no compositor, so every animation here is a function of the
// wall clock rather than of the frame counter: the interface looks the same
// whether it is repainting at 8fps over SSH or not repainting at all. Nothing
// animates for decoration. Each of these exists to answer one question the
// operator would otherwise have to ask:
//
//   breathe   "is this still alive?"      — the run lamp
//   sweep     "is it working, or stuck?"  — the focused rail during a run
//   fade      "did I miss that?"          — toasts leaving
//   spinner   "which step is in flight?"  — inline tool calls
//
// Timings come from DURATION so nothing runs on a beat of its own invention.

import { DURATION } from './tokens.mjs';

/**
 * A clock. Headless renders (tests, documentation captures) freeze it, so a
 * snapshot is byte-for-byte reproducible.
 */
export class Motion {
  constructor({ now = () => Date.now(), frozen = false } = {}) {
    this.origin = now();
    this.nowFn = now;
    this.frozen = frozen;
  }

  /** Milliseconds since the interface started. */
  get elapsed() {
    return this.frozen ? 0 : this.nowFn() - this.origin;
  }

  /** Position within a repeating cycle, 0 → 1. */
  phase(period = DURATION.breath, offset = 0) {
    if (this.frozen) return offset % 1;
    return (((this.elapsed / period) + offset) % 1 + 1) % 1;
  }

  /** A 0 → 1 → 0 cycle: the shape of a pulse. */
  pulse(period = DURATION.breath, offset = 0) {
    return triangle(this.phase(period, offset));
  }
}

/** Symmetric ramp: 0 at the ends of the cycle, 1 in the middle. */
export function triangle(t) {
  const value = ((t % 1) + 1) % 1;
  return value < 0.5 ? value * 2 : (1 - value) * 2;
}

/** Smoothstep. Takes the mechanical edge off a linear ramp. */
export function smooth(t) {
  const value = Math.max(0, Math.min(1, t));
  return value * value * (3 - 2 * value);
}

/** Ease-out cubic, for anything arriving. */
export function easeOut(t) {
  const value = Math.max(0, Math.min(1, t));
  return 1 - (1 - value) ** 3;
}

/**
 * A colour breathing between `floor` and full strength against the surface it
 * sits on. Used for anything that is live but has nothing new to report.
 */
export function breathe(theme, colour, { period = DURATION.breath, floor = 0.45, on = null } = {}) {
  const surface = on || theme.roles.surface;
  const level = floor + (1 - floor) * smooth(theme.motion.pulse(period));
  return theme.mixed(surface, colour, level);
}

/**
 * Intensity of a highlight band travelling left to right across `width`
 * columns, for the column at `index`. Returns 0 outside the band.
 */
export function sweepAt(index, width, phase, band = 14) {
  if (width <= 0) return 0;
  const head = phase * (width + band * 2) - band;
  const distance = Math.abs(index - head);
  return distance > band ? 0 : smooth(1 - distance / band);
}

/**
 * Paint a run of identical characters with a travelling highlight.
 *
 * The band is emitted as a handful of styled runs rather than one escape
 * sequence per column, so a shimmering rule costs about as much output as a
 * static one.
 */
export function sweepLine(theme, character, width, {
  base, highlight, phase = 0, band = 12, steps = 5,
}) {
  if (width <= 0) return '';
  if (!theme.enabled || theme.depth < 8) return theme.paint(character.repeat(width), { fg: base });
  let out = '';
  let runStart = 0;
  let runLevel = quantise(sweepAt(0, width, phase, band), steps);
  for (let index = 1; index <= width; index += 1) {
    const level = index === width ? -1 : quantise(sweepAt(index, width, phase, band), steps);
    if (level === runLevel) continue;
    out += theme.paint(
      character.repeat(index - runStart),
      { fg: runLevel === 0 ? base : theme.mixed(base, highlight, runLevel) },
    );
    runStart = index;
    runLevel = level;
  }
  return out;
}

function quantise(value, steps) {
  return Math.round(value * steps) / steps;
}

/**
 * How present a transient thing should be, 0 → 1: it arrives quickly and
 * leaves over `fade` milliseconds so a dismissal reads as motion rather than
 * as a row vanishing between frames.
 */
export function presence(remainingMs, { fade = DURATION.toastFade, ageMs = Number.POSITIVE_INFINITY } = {}) {
  const leaving = Math.max(0, Math.min(1, remainingMs / fade));
  const arriving = easeOut(Math.max(0, Math.min(1, ageMs / DURATION.base)));
  return Math.min(arriving, smooth(leaving));
}

// Spinner families. One family per meaning, so two spinners never race each
// other at different speeds in the same frame.
export const SPINNERS = {
  // Inline, beside a named unit of work.
  dots: { frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], period: 800 },
  // The run lamp, when a run is actually in flight.
  orbit: { frames: ['◐', '◓', '◑', '◒'], period: 900 },
  // A quiet heartbeat for queued work that has not started.
  bar: { frames: ['▁', '▃', '▄', '▅', '▄', '▃'], period: 900 },
  ascii: { frames: ['|', '/', '-', '\\'], period: 640 },
};

/** Frame of a spinner family for the current instant. */
export function spin(theme, kind = 'dots') {
  const family = theme.unicode ? (SPINNERS[kind] || SPINNERS.dots) : SPINNERS.ascii;
  const index = Math.floor(theme.motion.phase(family.period) * family.frames.length);
  return family.frames[Math.min(index, family.frames.length - 1)];
}
