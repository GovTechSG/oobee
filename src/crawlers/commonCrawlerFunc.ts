import { Dataset, RequestQueue, log, playwrightUtils, CrawlingContext, PlaywrightGotoOptions, Request } from 'crawlee';
import axe, { AxeResults, ImpactValue, NodeResult, Result, resultGroups, TagValue } from 'axe-core';
import { BrowserContext, ElementHandle, Page } from 'playwright';
import {
  axeScript,
  disallowedListOfPatterns,
  guiInfoStatusTypes,
  RuleFlags,
  saflyIconSelector,
} from '../constants/constants.js';
import { consoleLogger, guiInfoLog, silentLogger } from '../logs.js';
import { enrichColorContrastDOMContext, takeScreenshotForHTMLElements } from '../screenshotFunc/htmlScreenshotFunc.js';
import { isFilePath } from '../constants/common.js';
import { extractAndGradeText } from './custom/extractAndGradeText.js';
import { ItemsInfo } from '../mergeAxeResults.js';
import { evaluateAltText } from './custom/evaluateAltText.js';
import { escapeCssSelector } from './custom/escapeCssSelector.js';
import { framesCheck } from './custom/framesCheck.js';
import { findElementByCssSelector } from './custom/findElementByCssSelector.js';
import { getAxeConfiguration } from './custom/getAxeConfiguration.js';
import { flagUnlabelledClickableElements } from './custom/flagUnlabelledClickableElements.js';
import xPathToCss from './custom/xPathToCss.js';
import type { Response as PlaywrightResponse } from 'playwright';
import fs from 'fs';
import { getStoragePath } from '../utils.js';
import path from 'path';

// types
interface AxeResultsWithScreenshot extends AxeResults {
  passes: ResultWithScreenshot[];
  incomplete: ResultWithScreenshot[];
  violations: ResultWithScreenshot[];
}

export interface ResultWithScreenshot extends Result {
  nodes: NodeResultWithScreenshot[];
}

export type ContrastDOMContext = {
  /** Raw computed background-image value on the element itself (empty string if none). */
  backgroundImage: string;
  /** True when the element's own background-image contains a CSS gradient. */
  hasGradient: boolean;
  /** True when the element's own background-image is a url() image (not a gradient). */
  hasBackgroundImage: boolean;
  /** True when any ancestor up to <body> has a gradient background. */
  ancestorHasGradient: boolean;
  /** True when any ancestor up to <body> has a url() image background. */
  ancestorHasBackgroundImage: boolean;
  /** True when the element or any ancestor has computed opacity < 1. */
  hasReducedOpacity: boolean;
  /** Non-null when the element's mix-blend-mode is not 'normal'. */
  mixBlendMode: string | null;
  /** Non-null when a backdrop-filter is applied to the element. */
  backdropFilter: string | null;
  /** Non-null when a CSS filter (e.g. brightness, contrast) is applied to the element. */
  filter: string | null;
};

export interface NodeResultWithScreenshot extends NodeResult {
  screenshotPath?: string;
  contrastDOMContext?: ContrastDOMContext;
}

type RuleDetails = {
  description: string;
  axeImpact: ImpactValue;
  helpUrl: string;
  conformance: TagValue[];
  totalItems: number;
  items: ItemsInfo[];
};

type ResultCategory = {
  totalItems: number;
  rules: Record<string, RuleDetails>;
};

type CustomFlowDetails = {
  pageIndex?: any;
  metadata?: any;
  pageImagePath?: any;
};

type ContrastCheckData = {
  fgColor?: string;
  bgColor?: string;
  contrastRatio?: string | number;
  fontSize?: string;
  fontWeight?: string;
  expectedContrastRatio?: string;
};

type ContrastExample = {
  fgColor: string;
  bgColor: string;
  contrastRatio: string;
  fontSize: string;
  fontWeight: string;
  expectedContrastRatio: string;
};

type FilteredResults = {
  url: string;
  pageTitle: string;
  pageIndex?: any;
  metadata?: any;
  pageImagePath?: any;
  totalItems: number;
  mustFix: ResultCategory;
  goodToFix: ResultCategory;
  needsReview: ResultCategory;
  passed: ResultCategory;
  actualUrl?: string;
};

const truncateHtml = (html: string, maxBytes = 1024, suffix = '…'): string => {
  const encoder = new TextEncoder();
  if (encoder.encode(html).length <= maxBytes) return html;

  let left = 0;
  let right = html.length;
  let result = '';

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const truncated = html.slice(0, mid) + suffix;
    const bytes = encoder.encode(truncated).length;

    if (bytes <= maxBytes) {
      result = truncated;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return result;
};

const formatContrastFontSize = (fontSize?: string) => {
  if (!fontSize) return 'unknown size';

  const pxMatch = fontSize.match(/\(([\d.]+px)\)/i);
  return pxMatch ? pxMatch[1] : fontSize;
};

/**
 * Parses a CSS color string into an [R, G, B] tuple (values 0–255).
 *
 * axe-core serialises colours via its internal `Color.toHexString()`, which
 * always produces lowercase 6-digit hex (#rrggbb).  The parser also accepts
 * 3-digit hex (#rgb) and functional rgb() notation for robustness.
 *
 * Returns null if the string does not match any supported format.
 */
const parseColor = (color: string): [number, number, number] | null => {
  const hex6 = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex6) return [parseInt(hex6[1], 16), parseInt(hex6[2], 16), parseInt(hex6[3], 16)];

  const hex3 = color.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (hex3)
    return [
      parseInt(hex3[1] + hex3[1], 16),
      parseInt(hex3[2] + hex3[2], 16),
      parseInt(hex3[3] + hex3[3], 16),
    ];

  const rgb = color.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (rgb) return [parseInt(rgb[1]), parseInt(rgb[2]), parseInt(rgb[3])];

  return null;
};

/**
 * Computes the WCAG 2.x relative luminance of an sRGB colour.
 *
 * Algorithm (WCAG 2.1 §1.4.3 / IEC 61966-2-1 sRGB standard):
 *   1. Normalise each 8-bit channel to [0, 1] by dividing by 255.
 *   2. Gamma-expand (linearise) each normalised channel:
 *        if sRGB ≤ 0.04045  →  linear = sRGB / 12.92
 *        else               →  linear = ((sRGB + 0.055) / 1.055) ^ 2.4
 *      The threshold 0.04045 and the slope 1/12.92 describe the near-black
 *      linear segment of the sRGB electro-optical transfer function (EOTF).
 *      The power 2.4 (≈ gamma 2.2) and the offset 0.055 handle the rest.
 *   3. Weight the linear channels by the CIE 1931 XYZ D65 Y-row coefficients
 *      projected onto the sRGB primaries:
 *        L = 0.2126 R_lin + 0.7152 G_lin + 0.0722 B_lin
 *      These weights reflect human eye sensitivity: the eye is most sensitive
 *      to green, moderately to red, and least to blue.
 *
 * Returns a value in [0, 1]: 0 = absolute black, 1 = perfect white.
 */
const relativeLuminance = (r: number, g: number, b: number): number => {
  const linearise = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
};

/**
 * Computes the WCAG 2.x contrast ratio between two relative luminances.
 *
 * Formula: (L_lighter + 0.05) / (L_darker + 0.05)
 *
 * The additive offset 0.05 models the luminance of ambient flare (reflected
 * light) assumed in a reference viewing environment.  It prevents the ratio
 * from reaching infinity for pure black and anchors the scale so that
 * white-on-black yields exactly 21:1.  The lighter luminance is always placed
 * in the numerator so the result is always ≥ 1.
 *
 * WCAG thresholds:
 *   AA  normal text  ≥ 4.5:1   |  large text ≥ 3:1
 *   AAA normal text  ≥ 7:1     |  large text ≥ 4.5:1
 */
const wcagContrastRatio = (l1: number, l2: number): number => {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
};

/**
 * Converts an sRGB colour to HSL cylindrical coordinates.
 *   H (hue)        ∈ [0°, 360°)
 *   S (saturation) ∈ [0, 1]
 *   L (lightness)  ∈ [0, 1]
 *
 * We work in HSL because adjusting L alone changes perceived brightness while
 * preserving the hue and saturation of the original brand colour — the
 * smallest perceptible change needed to satisfy the contrast requirement.
 * Achromatic colours (R = G = B) return H = 0, S = 0.
 */
const rgbToHsl = (r: number, g: number, b: number): [number, number, number] => {
  const R = r / 255,
    G = g / 255,
    B = b / 255;
  const max = Math.max(R, G, B),
    min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === R) h = ((G - B) / d + (G < B ? 6 : 0)) / 6;
  else if (max === G) h = ((B - R) / d + 2) / 6;
  else h = ((R - G) / d + 4) / 6;
  return [h * 360, s, l];
};

/**
 * Converts HSL back to sRGB (inverse of rgbToHsl).
 *
 * Uses the standard two-step piecewise-linear hue reconstruction:
 *   q = L < 0.5 ? L(1+S) : L+S−L·S   (upper chroma boundary)
 *   p = 2L − q                         (lower chroma boundary)
 * Each R, G, B channel is obtained by evaluating a piecewise hue function
 * with offsets of +1/3 (120°) and −1/3 (−120°) for R and B respectively.
 */
const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  h = h / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
};

/** Converts an [R, G, B] tuple (0–255) to a lowercase 6-digit hex string. */
const rgbToHex = (r: number, g: number, b: number): string =>
  '#' +
  [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');

/**
 * Finds the lightness-adjusted version of `adjustRgb` that is as close as
 * possible to the original colour while achieving at least `requiredRatio`
 * contrast against `fixedRgb`.
 *
 * Strategy — binary search on HSL lightness L ∈ [0, 1]:
 *   direction = 'darker':  searches L ∈ [0, original_L] for the MAXIMUM L
 *     (least dark, closest to original) at which contrast ≥ required.
 *   direction = 'lighter': searches L ∈ [original_L, 1] for the MINIMUM L
 *     (least light, closest to original) at which contrast ≥ required.
 *
 * Hue (H) and saturation (S) are held constant so the result stays as close
 * to the original brand/design colour as possible.
 *
 * 30 iterations yield a lightness precision of 1/2^30 ≈ 10⁻⁹, well below
 * the 1/255 ≈ 0.004 resolution of 8-bit channels, so the result is
 * effectively exact at 8-bit depth.
 *
 * Returns null if even the extreme value for this direction (pure black at
 * L = 0 or pure white at L = 1 for the given H and S) cannot achieve the
 * required ratio — an edge case that only arises for very low required ratios
 * or highly chromatic near-neutral colours.
 */
const findCompliantColorByLightness = (
  adjustRgb: [number, number, number],
  fixedRgb: [number, number, number],
  requiredRatio: number,
  direction: 'darker' | 'lighter',
): [number, number, number] | null => {
  const fixedLum = relativeLuminance(...fixedRgb);
  const [h, s, origHslL] = rgbToHsl(...adjustRgb);

  // Verify the extreme value in this direction is sufficient at all.
  const extremeHslL = direction === 'darker' ? 0 : 1;
  const extremeRgb = hslToRgb(h, s, extremeHslL);
  if (wcagContrastRatio(fixedLum, relativeLuminance(...extremeRgb)) < requiredRatio) {
    return null;
  }

  let lo = direction === 'darker' ? 0 : origHslL;
  let hi = direction === 'darker' ? origHslL : 1;
  let best = extremeHslL; // guaranteed-passing extreme

  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const midRgb = hslToRgb(h, s, mid);
    const passes = wcagContrastRatio(fixedLum, relativeLuminance(...midRgb)) >= requiredRatio;

    if (passes) {
      best = mid; // This midpoint works; try to get even closer to the original.
      if (direction === 'darker') lo = mid; // Can we raise L further (less dark)?
      else hi = mid; // Can we lower L further (less light)?
    } else {
      if (direction === 'darker') hi = mid; // Too light; go darker.
      else lo = mid; // Too dark; go lighter.
    }
  }

  return hslToRgb(h, s, best);
};

/**
 * Builds a human-readable recommendation for a single failing contrast pair.
 *
 * WCAG 1.4.3 "Contrast (Minimum)" defines two situations based on font size
 * and weight (1 pt = 1.333 px at 96 dpi):
 *
 *   Situation A — normal text (< 18 pt non-bold  /  < 14 pt bold,
 *                               i.e. < ~24 px    /  < ~18.5 px):
 *     Required contrast ≥ 4.5:1  (G18)
 *
 *   Situation B — large text  (≥ 18 pt non-bold  /  ≥ 14 pt bold,
 *                               i.e. ≥ ~24 px    /  ≥ ~18.5 px):
 *     Required contrast ≥ 3:1    (G145)
 *
 * axe-core applies this rule upstream using:
 *   ptSize      = Math.ceil(fontSize_px × 72) / 96          // px → pt
 *   isSmallFont = (bold && ptSize < boldTextPt)              // default 14 pt
 *              || (!bold && ptSize < largeTextPt)            // default 18 pt
 *   bold        = fontWeight ≥ 700 || fontWeight === 'bold'  // boldValue = 700
 * and stores the result as `expectedContrastRatio: "4.5:1"` (Situation A) or
 * `"3:1"` (Situation B).  The `required` value used here is derived from that
 * field via `parseFloat("4.5:1") → 4.5` or `parseFloat("3:1") → 3`, so the
 * binary search automatically targets the correct threshold for each
 * combination's font size and weight — no re-classification is needed here.
 *
 * WCAG 1.4.3 exceptions (no contrast requirement — filtered by axe-core
 * before the data ever reaches this function):
 *   • Pure decoration (no informational purpose, rearrangeable/substitutable)
 *   • Inactive / disabled user-interface components
 *   • Logotypes and brand names
 *   • Text inside photographs or images with significant other visual content
 *
 * Algorithm for each failing pair:
 *   1. Parse both colours to [R, G, B] (axe-core supplies #rrggbb hex).
 *   2. Convert each colour to HSL.  Search for the nearest compliant
 *      foreground by binary-searching HSL lightness L in both the 'darker'
 *      and 'lighter' directions while keeping H and S constant (preserves
 *      hue/saturation of the original brand colour).
 *   3. Repeat step 2 for the background (holding the foreground fixed).
 *   4. For each colour role, pick whichever direction (darker/lighter)
 *      requires the smaller change in L — i.e. the least visually
 *      disruptive compliant alternative.
 *   5. Report both the adjusted foreground and the adjusted background
 *      (hex + rgb) so developers can choose whichever fits their design
 *      system.  The target ratio is included so the output is unambiguous
 *      when a page contains a mix of normal-text (4.5:1) and large-text
 *      (3:1) failures.
 *
 * Returns null if the colours cannot be parsed or no compliant alternative
 * can be found (extremely rare; only arises when the colour is already at
 * the luminance extreme for its hue/saturation).
 */
const buildContrastRecommendation = (example: ContrastExample): string | null => {
  const fgRgb = parseColor(example.fgColor);
  const bgRgb = parseColor(example.bgColor);
  if (!fgRgb || !bgRgb) return null;

  // parseFloat handles "4.5:1" → 4.5 because it stops at the non-numeric ':'.
  // The value is either 4.5 (Situation A, normal text) or 3 (Situation B,
  // large text), as determined by axe-core from the element's font metrics.
  const CONTRAST_BUFFER = 1.05;
  const required = parseFloat(example.expectedContrastRatio) * CONTRAST_BUFFER;
  if (isNaN(required)) return null;

  // Find the nearest compliant foreground (try both directions, pick closest).
  const fgDarker = findCompliantColorByLightness(fgRgb, bgRgb, required, 'darker');
  const fgLighter = findCompliantColorByLightness(fgRgb, bgRgb, required, 'lighter');
  const [, , origFgHslL] = rgbToHsl(...fgRgb);
  let recFg: [number, number, number] | null = null;
  if (fgDarker && fgLighter) {
    const [, , dL] = rgbToHsl(...fgDarker);
    const [, , lL] = rgbToHsl(...fgLighter);
    recFg = Math.abs(dL - origFgHslL) <= Math.abs(lL - origFgHslL) ? fgDarker : fgLighter;
  } else {
    recFg = fgDarker ?? fgLighter;
  }

  // Find the nearest compliant background (try both directions, pick closest).
  const bgDarker = findCompliantColorByLightness(bgRgb, fgRgb, required, 'darker');
  const bgLighter = findCompliantColorByLightness(bgRgb, fgRgb, required, 'lighter');
  const [, , origBgHslL] = rgbToHsl(...bgRgb);
  let recBg: [number, number, number] | null = null;
  if (bgDarker && bgLighter) {
    const [, , dL] = rgbToHsl(...bgDarker);
    const [, , lL] = rgbToHsl(...bgLighter);
    recBg = Math.abs(dL - origBgHslL) <= Math.abs(lL - origBgHslL) ? bgDarker : bgLighter;
  } else {
    recBg = bgDarker ?? bgLighter;
  }

  if (!recFg && !recBg) return null;

  const parts: string[] = [];
  if (recFg) {
    const [rr, gg, bb] = recFg;
    parts.push(`foreground text color to ${rgbToHex(rr, gg, bb)} (rgb(${rr}, ${gg}, ${bb}))`);
  }
  if (recBg) {
    const [rr, gg, bb] = recBg;
    parts.push(`background to ${rgbToHex(rr, gg, bb)} (rgb(${rr}, ${gg}, ${bb}))`);
  }

  // Include the target ratio in the string so the message is unambiguous when
  // a single element has a mix of normal-text (4.5:1) and large-text (3:1)
  // failing combinations with different required thresholds.
  return `${parts.join(' or ')}`;
};

/**
 * Builds the augmented issue description for a single axe-core color-contrast
 * violation node.
 *
 * ─── WCAG rules applied ──────────────────────────────────────────────────────
 *
 * WCAG 1.4.3 "Contrast (Minimum)" distinguishes two situations:
 *
 *   Situation A — normal text (< 18 pt non-bold / < 14 pt bold,
 *                               i.e. < ~24 px   / < ~18.5 px at 96 dpi):
 *     Required contrast ratio ≥ 4.5:1
 *
 *   Situation B — large text  (≥ 18 pt non-bold / ≥ 14 pt bold,
 *                               i.e. ≥ ~24 px   / ≥ ~18.5 px at 96 dpi):
 *     Required contrast ratio ≥ 3:1
 *
 * axe-core classifies each element before this function runs:
 *   ptSize      = Math.ceil(fontSize_px × 72) / 96          // px → pt
 *   isSmallFont = (bold  && ptSize < 14)                     // Situation A bold
 *              || (!bold && ptSize < 18)                     // Situation A normal
 *   bold        = fontWeight ≥ 700 || fontWeight === 'bold'
 * …and stores the result in check.data.expectedContrastRatio as "4.5:1" or "3:1".
 *
 * Exceptions (no contrast requirement — already excluded by axe-core upstream):
 *   • Pure decoration (no informational purpose)
 *   • Inactive / disabled UI components
 *   • Logotypes and brand names
 *   • Text inside photographs with significant other visual content
 *
 * ─── Function flow ───────────────────────────────────────────────────────────
 *
 *  1. Collect checks — flatten node.any, node.all, node.none into one array.
 *     Each entry may carry a ContrastCheckData payload with fgColor, bgColor,
 *     contrastRatio, fontSize, fontWeight, and expectedContrastRatio.
 *
 *  2. Deduplicate — key each combination on
 *     [fgColor, bgColor, fontSize, fontWeight, expectedContrastRatio].
 *     A single DOM node can generate multiple identical checks; the Map ensures
 *     each distinct failing pair is reported once.
 *
 *  3. Build the base message — lists every unique failing combination with its
 *     current contrast ratio and the required ratio, and instructs the developer
 *     to fix all failing text in the component, not just the first element.
 *
 *  4. Build per-combo recommendations (via buildContrastRecommendation) —
 *     for each failing pair, binary-search HSL lightness to find the nearest
 *     compliant foreground (background fixed) and the nearest compliant
 *     background (foreground fixed), both expressed as hex + rgb().  The binary
 *     search targets the combination's own expectedContrastRatio (4.5 or 3),
 *     so large-text recommendations are correctly held to the 3:1 threshold
 *     and normal-text recommendations to 4.5:1.
 *
 *  5. Concatenate — append "Recommendation: …" after the base message so the
 *     existing description is never modified, only extended.
 *
 * Returns null when no check carries usable contrast data (axe-core may omit
 * it for pseudo-element or out-of-viewport cases).
 */
const buildColorContrastMessage = (node: NodeResultWithScreenshot): string | null => {
  const checks = [...(node.any || []), ...(node.all || []), ...(node.none || [])] as Array<{
    data?: ContrastCheckData;
  }>;

  const uniqueCombos = new Map<string, ContrastExample>();

  checks.forEach(check => {
    const data = check.data || {};
    const hasContrastData =
      data.fgColor ||
      data.bgColor ||
      data.contrastRatio !== undefined ||
      data.expectedContrastRatio;

    if (!hasContrastData) return;

    if (!data.fgColor || !data.bgColor) return;

    const fgColor = data.fgColor;
    const bgColor = data.bgColor;
    const contrastRatio = String(data.contrastRatio ?? 'unknown');
    const fontSize = formatContrastFontSize(data.fontSize);
    const fontWeight = data.fontWeight || 'normal';
    const expectedContrastRatio = data.expectedContrastRatio || '4.5:1';

    const key = [fgColor, bgColor, fontSize, fontWeight, expectedContrastRatio].join('|');

    if (!uniqueCombos.has(key)) {
      uniqueCombos.set(key, {
        fgColor,
        bgColor,
        contrastRatio,
        fontSize,
        fontWeight,
        expectedContrastRatio,
      });
    }
  });

  if (!uniqueCombos.size) return null;

  const combos = [...uniqueCombos.values()];

  const examples = combos
    .map(
      example =>
        `foreground ${example.fgColor} on ${example.bgColor} at ${example.fontSize} ${example.fontWeight === 'bold' ? 'bold' : 'regular'} text`,
    )
    .join(', and ');

  const targetRatio = combos[0]?.expectedContrastRatio || '4.5:1';
  const currentRatio = combos[0]?.contrastRatio || 'unknown';

  const base = `Multiple text elements in this component fail WCAG 1.4.3 Color Contrast Minimum.\n  Normal text should meet or exceed ${targetRatio} contrast ratio against its actual background.\n  The current text contrast ratio of ${currentRatio} does not meet requirements. Failing combinations in this snippet include ${examples}.`;

  const recommendations = combos
    .map(buildContrastRecommendation)
    .filter((r): r is string => r !== null);

  const recSection =
    recommendations.length > 0
      ? `\n  Recommendation: Adjust ${recommendations.join('; ')}.`
      : '';

  const ctx = node.contrastDOMContext;
  if (!ctx) return `${base}${recSection}`;

  const notes: string[] = [];

  if (ctx.hasGradient) {
    notes.push(
      `gradient background detected (${ctx.backgroundImage}): the sampled background color represents a single point — verify contrast at every gradient stop and position where text appears, then adjust the gradient stops or add a solid color fallback behind the text`,
    );
  } else if (ctx.ancestorHasGradient) {
    notes.push(
      `an ancestor provides a gradient background: the sampled background color may not match what is visually beneath the text — verify contrast against the actual rendered gradient`,
    );
  }

  if (ctx.hasBackgroundImage) {
    notes.push(
      `background image detected: contrast cannot be fully determined from a sampled color alone — ensure text remains readable across all image content and states`,
    );
  } else if (ctx.ancestorHasBackgroundImage) {
    notes.push(
      `an ancestor has a background image: the effective background under this text may differ from the sampled value`,
    );
  }

  if (ctx.hasReducedOpacity) {
    notes.push(
      `opacity less than 1 detected on this element or an ancestor: the rendered contrast is lower than the computed color values indicate`,
    );
  }

  if (ctx.mixBlendMode) {
    notes.push(
      `mix-blend-mode: ${ctx.mixBlendMode} is applied: actual rendered colors depend on the underlying layers`,
    );
  }

  if (ctx.backdropFilter) {
    notes.push(`backdrop-filter: ${ctx.backdropFilter} is applied: the effective background appearance is modified`);
  }

  if (ctx.filter) {
    notes.push(
      `CSS filter: ${ctx.filter} is applied to this element: rendered colors may differ from computed values`,
    );
  }

  const ctxSection =
    notes.length > 0
      ? `\n  Rendering complexity: ${notes.join('; ')}.\n  The color fix recommendations above may not be accurate for this element — manual verification of the actual rendered contrast is strongly advised.`
      : '';

  return `${base}${recSection}${ctxSection}`;
};

// Enriches axe violation failureSummaries with additional DOM context gathered via Playwright,
// providing LLMs with the specific details they need to apply correct fixes.
export const enrichViolationMessages = async (results: AxeResults, page: Page): Promise<void> => {
  for (const violation of results.violations) {
    if (violation.id !== 'target-size' && violation.id !== 'valid-lang') continue;

    for (const node of violation.nodes) {
      const cssSelector =
        node.target.length === 1 && typeof node.target[0] === 'string' ? node.target[0] : null;
      if (!cssSelector) continue;

      if (violation.id === 'target-size') {
        const ctx = await page
          .evaluate((sel: string) => {
            try {
              const el = document.querySelector(sel) as HTMLElement | null;
              if (!el) return null;
              const rect = el.getBoundingClientRect();
              const computed = window.getComputedStyle(el);
              return {
                renderedWidth: Math.round(rect.width),
                renderedHeight: Math.round(rect.height),
                boxSizing: computed.boxSizing,
                inlineWidth: el.style.width || null,
                inlineHeight: el.style.height || null,
                tagName: el.tagName.toLowerCase(),
              };
            } catch {
              return null;
            }
          }, cssSelector)
          .catch(() => null);

        if (ctx) {
          const spacingMatch = node.failureSummary?.match(/diameter of (\d+)px/);
          const spacing = spacingMatch ? spacingMatch[1] : null;

          let message = `Insufficient target size: ${ctx.renderedWidth}px by ${ctx.renderedHeight}px (box-sizing: ${ctx.boxSizing}).\n  Ensure it is at least 24px by 24px.`;

          if (spacing) {
            message += `\n  Target has insufficient space to its adjacent element of ${spacing}px. Ensure it has a safe clickable space of at least 24px.`;
          }

          if (
            ctx.boxSizing === 'border-box' &&
            (ctx.inlineWidth !== null || ctx.inlineHeight !== null)
          ) {
            message += `\n  Current button style code snippet does not increase the hit area.\n  Remove the explicit width/height and use min-width: 24px; min-height: 24px instead.\n  Or place the visual content in a child <span> element.`;
          }

          node.failureSummary = message;
        }
      } else if (violation.id === 'valid-lang') {
        const ctx = await page
          .evaluate((sel: string) => {
            try {
              const el = document.querySelector(sel);
              if (!el) return null;
              return {
                langValue: el.getAttribute('lang') ?? '',
                textSnippet: (el.textContent ?? '').trim().slice(0, 120),
              };
            } catch {
              return null;
            }
          }, cssSelector)
          .catch(() => null);

        if (ctx) {
          let message = `Value of lang attribute is not a valid language.\n  Use a registered IANA language code instead of "${ctx.langValue}".`;

          if (ctx.langValue.startsWith('x-')) {
            message += `\n  Axe-core valid-lang rule also rejects private-use subtags.`;
          }

          message += `\n  Identify the actual language of this text and use its registered BCP 47 code (e.g., lang="it" Italian, "es" Spanish, "fr" French, "de" German, "zh" Chinese, "ja" Japanese, "ko" Korean, "pt" Portuguese, "ar" Arabic).`;

          node.failureSummary = message;
        }
      }
    }
  }
};

export const filterAxeResults = (
  results: AxeResultsWithScreenshot,
  pageTitle: string,
  customFlowDetails?: CustomFlowDetails,
): FilteredResults => {
  const { violations, passes, incomplete, url } = results;

  let totalItems = 0;
  const mustFix: ResultCategory = { totalItems: 0, rules: {} };
  const goodToFix: ResultCategory = { totalItems: 0, rules: {} };
  const passed: ResultCategory = { totalItems: 0, rules: {} };
  const needsReview: ResultCategory = { totalItems: 0, rules: {} };

  const process = (item: ResultWithScreenshot, displayNeedsReview: boolean) => {
    const { id: rule, help: description, helpUrl, tags, nodes } = item;

    if (rule === 'frame-tested') return;

    const conformance = tags.filter(tag => tag.startsWith('wcag') || tag === 'best-practice');

    // handle rare cases where conformance level is not the first element
    const wcagRegex = /^wcag\d+a+$/;

    if (conformance[0] !== 'best-practice' && !wcagRegex.test(conformance[0])) {
      conformance.sort((a, b) => {
        if (wcagRegex.test(a) && !wcagRegex.test(b)) {
          return -1;
        }
        if (!wcagRegex.test(a) && wcagRegex.test(b)) {
          return 1;
        }
        return 0;
      });
    }

    const addTo = (category: ResultCategory, node: NodeResultWithScreenshot) => {
      const { html, failureSummary, screenshotPath, target, impact: axeImpact } = node;
      if (!(rule in category.rules)) {
        category.rules[rule] = {
          description,
          axeImpact,
          helpUrl,
          conformance,
          totalItems: 0,
          items: [],
        };
      }
      const defaultMessage = displayNeedsReview
        ? failureSummary.slice(failureSummary.indexOf('\n') + 1).trim()
        : failureSummary;
      const message =
        rule === 'color-contrast' || rule === 'color-contrast-enhanced'
          ? buildColorContrastMessage(node) || defaultMessage
          : defaultMessage;

      let finalHtml = html;
      if (html.includes('</script>')) {
        finalHtml = html.replaceAll('</script>', '&lt;/script>');
      }
      finalHtml = truncateHtml(finalHtml);

      const xpath = target.length === 1 && typeof target[0] === 'string' ? target[0] : null;

      // add in screenshot path
      category.rules[rule].items.push({
        html: finalHtml,
        message,
        screenshotPath,
        xpath: xpath || undefined,
        displayNeedsReview: displayNeedsReview || undefined,
      });
      category.rules[rule].totalItems += 1;
      category.totalItems += 1;
      totalItems += 1;
    };

    nodes.forEach(node => {
      const hasWcagA = conformance.some(tag => /^wcag\d*a$/.test(tag));
      const hasWcagAA = conformance.some(tag => /^wcag\d*aa$/.test(tag));
      // const hasWcagAAA = conformance.some(tag => /^wcag\d*aaa$/.test(tag));

      if (displayNeedsReview) {
        addTo(needsReview, node);
      } else if (hasWcagA || hasWcagAA) {
        addTo(mustFix, node);
      } else {
        addTo(goodToFix, node);
      }
    });
  };

  violations.forEach(item => process(item, false));
  incomplete.forEach(item => process(item, true));

  passes.forEach((item: Result) => {
    const { id: rule, help: description, impact: axeImpact, helpUrl, tags, nodes } = item;

    if (rule === 'frame-tested') return;

    const conformance = tags.filter(tag => tag.startsWith('wcag') || tag === 'best-practice');

    nodes.forEach(node => {
      const { html, target } = node;
      if (!(rule in passed.rules)) {
        passed.rules[rule] = {
          description,
          axeImpact,
          helpUrl,
          conformance,
          totalItems: 0,
          items: [],
        };
      }

      const finalHtml = truncateHtml(html);
      const xpath = target.length === 1 && typeof target[0] === 'string' ? target[0] : undefined;
      passed.rules[rule].items.push({ html: finalHtml, screenshotPath: '', message: '', xpath: xpath || '' });

      passed.totalItems += 1;
      passed.rules[rule].totalItems += 1;
      totalItems += 1;
    });
  });

  return {
    url,
    pageTitle: customFlowDetails ? `${customFlowDetails.pageIndex}: ${pageTitle}` : pageTitle,
    pageIndex: customFlowDetails ? customFlowDetails.pageIndex : undefined,
    metadata: customFlowDetails?.metadata
      ? `${customFlowDetails.pageIndex}: ${customFlowDetails.metadata}`
      : undefined,
    pageImagePath: customFlowDetails ? customFlowDetails.pageImagePath : undefined,
    totalItems,
    mustFix,
    goodToFix,
    needsReview,
    passed,
  };
};

export const runAxeScript = async ({
  includeScreenshots,
  page,
  randomToken,
  customFlowDetails = null,
  selectors = [],
  ruleset = [],
}: {
  includeScreenshots: boolean;
  page: Page;
  randomToken: string;
  customFlowDetails?: CustomFlowDetails;
  selectors?: string[];
  ruleset?: RuleFlags[];
}) => {
  const browserContext: BrowserContext = page.context();
  const requestUrl = page.url();

  let pageTitle: string | null = null;
  try {
    pageTitle = await page.evaluate(() => document.title);
  } catch {
    // Page may already be in a bad state; title will remain null
  }

  try {
    // Checking for DOM mutations before proceeding to scan
    await page.evaluate(() => {
      return new Promise(resolve => {
        let timeout: NodeJS.Timeout;
        let mutationCount = 0;
        const MAX_MUTATIONS = 500;
        const MAX_SAME_MUTATION_LIMIT = 10;
        const mutationHash: Record<string, number> = {};

        const observer = new MutationObserver(mutationsList => {
          clearTimeout(timeout);

          mutationCount += 1;

          if (mutationCount > MAX_MUTATIONS) {
            observer.disconnect();
            resolve('Too many mutations detected');
          }

          // To handle scenario where DOM elements are constantly changing and unable to exit
          mutationsList.forEach(mutation => {
            let mutationKey: string;

            if (mutation.target instanceof Element) {
              Array.from(mutation.target.attributes).forEach(attr => {
                mutationKey = `${mutation.target.nodeName}-${attr.name}`;

                if (mutationKey) {
                  if (!mutationHash[mutationKey]) {
                    mutationHash[mutationKey] = 1;
                  } else {
                    mutationHash[mutationKey] += 1;
                  }

                  if (mutationHash[mutationKey] >= MAX_SAME_MUTATION_LIMIT) {
                    observer.disconnect();
                    resolve(`Repeated mutation detected for ${mutationKey}`);
                  }
                }
              });
            }
          });

          timeout = setTimeout(() => {
            observer.disconnect();
            resolve('DOM stabilized after mutations.');
          }, 1000);
        });

        timeout = setTimeout(() => {
          observer.disconnect();
          resolve('No mutations detected, exit from idle state');
        }, 1000);

        observer.observe(document, { childList: true, subtree: true, attributes: true });
      });
    });
  } catch (e) {
    // do nothing, just continue
  }

  // Omit logging of browser console errors to reduce unnecessary verbosity
  /*
  page.on('console', msg => {
    const type = msg.type();
    if (type === 'error') {
      consoleLogger.error(msg.text());
    } else {
      consoleLogger.info(msg.text());
    }
  });
  */

  const disableOobee = ruleset.includes(RuleFlags.DISABLE_OOBEE);
  const enableWcagAaa = ruleset.includes(RuleFlags.ENABLE_WCAG_AAA);

  const gradingReadabilityFlag = await extractAndGradeText(page); // Ensure flag is obtained before proceeding

  await playwrightUtils.injectFile(page, axeScript);

  const results = await page.evaluate(
    async ({
      selectors,
      saflyIconSelector,
      disableOobee,
      enableWcagAaa,
      gradingReadabilityFlag,
      evaluateAltTextFunctionString,
      escapeCssSelectorFunctionString,
      framesCheckFunctionString,
      findElementByCssSelectorFunctionString,
      getAxeConfigurationFunctionString,
      flagUnlabelledClickableElementsFunctionString,
      xPathToCssFunctionString,
    }) => {
      try {
        // Load functions into the browser context
        eval(evaluateAltTextFunctionString);
        eval(escapeCssSelectorFunctionString);
        eval(framesCheckFunctionString);
        eval(findElementByCssSelectorFunctionString);
        eval(flagUnlabelledClickableElementsFunctionString);
        eval(xPathToCssFunctionString);
        eval(getAxeConfigurationFunctionString);
        // remove so that axe does not scan
        document.querySelector(saflyIconSelector)?.remove();

        const oobeeAccessibleLabelFlaggedXpaths = disableOobee
          ? []
          : (await flagUnlabelledClickableElements()).map(item => item.xpath);
        const oobeeAccessibleLabelFlaggedCssSelectors = oobeeAccessibleLabelFlaggedXpaths
          .map(xpath => {
            try {
              const cssSelector = xPathToCss(xpath);
              return cssSelector;
            } catch (e) {
              console.error('Error converting XPath to CSS: ', xpath, e);
              return '';
            }
          })
          .filter(item => item !== '');

        const axeConfig = getAxeConfiguration({
          enableWcagAaa,
          gradingReadabilityFlag,
          disableOobee,
        });

        axe.configure(axeConfig);

        // removed needsReview condition
        const defaultResultTypes: resultGroups[] = ['violations', 'passes', 'incomplete'];

        return axe
          .run(selectors, {
            resultTypes: defaultResultTypes,
          })
          .then(async results => {
            // Re-verify aria-hidden-focus violations against the live DOM to
            // handle race conditions with JS that sets tabindex="-1" after
            // aria-hidden (common in carousel/slider libraries like slick)
            const ariaHiddenViolation = results.violations.find(
              v => v.id === 'aria-hidden-focus',
            );
            if (ariaHiddenViolation) {
              await new Promise(resolve => setTimeout(resolve, 0));
              ariaHiddenViolation.nodes = ariaHiddenViolation.nodes.filter(node => {
                const selector = node.target && node.target[0];
                if (typeof selector !== 'string') return true;
                try {
                  const el = document.querySelector(selector);
                  if (!el) return true;
                  const focusables = el.querySelectorAll(
                    'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]',
                  );
                  if (focusables.length === 0) return false;
                  return Array.from(focusables).some(child => {
                    const tabindex = child.getAttribute('tabindex');
                    if (tabindex === null) return true;
                    const parsed = parseInt(tabindex, 10);
                    return isNaN(parsed) || parsed >= 0;
                  });
                } catch {
                  return true;
                }
              });
              if (ariaHiddenViolation.nodes.length === 0) {
                results.violations = results.violations.filter(
                  v => v.id !== 'aria-hidden-focus',
                );
              }
            }

            if (disableOobee) {
              return results;
            }
            // handle css id selectors that start with a digit
            const escapedCssSelectors =
              oobeeAccessibleLabelFlaggedCssSelectors.map(escapeCssSelector);

            // Add oobee violations to Axe's report
            const oobeeAccessibleLabelViolations = {
              id: 'oobee-accessible-label',
              impact: 'serious' as ImpactValue,
              tags: ['wcag2a', 'wcag211', 'wcag412'],
              description: 'Ensures clickable elements have an accessible label.',
              help: 'Clickable elements (i.e. elements with mouse-click interaction) must have accessible labels.',
              helpUrl: 'https://www.deque.com/blog/accessible-aria-buttons',
              nodes: escapedCssSelectors
                .map((cssSelector: string): NodeResult => ({
                  html: findElementByCssSelector(cssSelector),
                  target: [cssSelector],
                  impact: 'serious' as ImpactValue,
                  failureSummary:
                    'Fix any of the following:\n  The clickable element does not have an accessible label.',
                  any: [
                    {
                      id: 'oobee-accessible-label',
                      data: null,
                      relatedNodes: [],
                      impact: 'serious',
                      message: 'The clickable element does not have an accessible label.',
                    },
                  ],
                  all: [],
                  none: [],
                }))
                .filter(item => item.html),
            };

            results.violations = [...results.violations, oobeeAccessibleLabelViolations];
            return results;
          })
          .catch(e => {
            console.error('Error at axe.run', e);
            throw e;
          });
      } catch (e) {
        console.error(e);
        throw e;
      }
    },
    {
      selectors,
      saflyIconSelector,
      disableOobee,
      enableWcagAaa,
      gradingReadabilityFlag,
      evaluateAltTextFunctionString: evaluateAltText.toString(),
      escapeCssSelectorFunctionString: escapeCssSelector.toString(),
      framesCheckFunctionString: framesCheck.toString(),
      findElementByCssSelectorFunctionString: findElementByCssSelector.toString(),
      getAxeConfigurationFunctionString: getAxeConfiguration.toString(),
      flagUnlabelledClickableElementsFunctionString: flagUnlabelledClickableElements.toString(),
      xPathToCssFunctionString: xPathToCss.toString(),
    },
  );

  await enrichViolationMessages(results, page);
  await enrichColorContrastDOMContext(results.violations, page);

  if (includeScreenshots) {
    results.violations = await takeScreenshotForHTMLElements(results.violations, page, randomToken);
    results.incomplete = await takeScreenshotForHTMLElements(results.incomplete, page, randomToken);
  }

  return filterAxeResults(results, pageTitle, customFlowDetails);
};

export const createCrawleeSubFolders = async (
  randomToken: string,
): Promise<{ dataset: Dataset; requestQueue: RequestQueue }> => {

  const crawleeDir = path.join(getStoragePath(randomToken),"crawlee");

  const dataset = await Dataset.open(crawleeDir);
  const requestQueue = await RequestQueue.open(crawleeDir);
  return { dataset, requestQueue };
};

export const preNavigationHooks = (extraHTTPHeaders: Record<string, string>) => {
  return [
    async (crawlingContext: CrawlingContext, gotoOptions: PlaywrightGotoOptions) => {
      if (extraHTTPHeaders) {
        crawlingContext.request.headers = extraHTTPHeaders;
      }
      gotoOptions = { waitUntil: 'networkidle', timeout: 30000 };
    },
  ];
};

export const postNavigationHooks = [
  async (_crawlingContext: CrawlingContext) => {
    guiInfoLog(guiInfoStatusTypes.COMPLETED, {});
  },
];

export const getPreLaunchHook = (userDataDirectory: string) => {
  let launchCount = 0;

  return async (_pageId: string, launchContext: any) => {
    const fsp = await import('fs/promises').then(m => m.default);
    launchCount += 1;

    // First launch uses the base directory; subsequent launches get a unique
    // directory so that lingering file handles from a retired browser don't
    // cause Chrome exit code 21 on Windows.
    const effectiveDir =
      launchCount === 1
        ? userDataDirectory
        : `${userDataDirectory}_pool${launchCount}`;

    await fsp.mkdir(effectiveDir, { recursive: true });

    // For pool re-launches, best-effort clone profile data from base directory
    // so authenticated sessions are preserved across browser pool retirements.
    if (launchCount > 1) {
      try {
        const copyRecursive = async (src: string, dest: string) => {
          const stat = await fsp.stat(src).catch(() => null);
          if (!stat) return;
          if (stat.isDirectory()) {
            await fsp.mkdir(dest, { recursive: true }).catch(() => {});
            const entries = await fsp.readdir(src).catch(() => []);
            await Promise.all(
              entries
                .filter(entry => !entry.startsWith('Singleton') && entry !== 'lockfile' && entry !== 'LOCK')
                .map(entry =>
                  copyRecursive(path.join(src, entry), path.join(dest, entry)).catch(() => {}),
                ),
            );
          } else {
            await fsp.copyFile(src, dest).catch(() => {});
          }
        };
        await copyRecursive(userDataDirectory, effectiveDir).catch(() => {});
      } catch {
        // Silent fallback: use empty profile if clone fails
      }
    }

    // Clean any stale lock files that may block browser launches on Windows
    const lockFiles = [
      path.join(effectiveDir, 'SingletonLock'),
      path.join(effectiveDir, 'SingletonSocket'),
      path.join(effectiveDir, 'SingletonCookie'),
      path.join(effectiveDir, 'lockfile'),
      path.join(effectiveDir, 'Default', 'LOCK'),
      path.join(effectiveDir, 'Default', 'Network', 'LOCK'),
    ];
    await Promise.all(lockFiles.map(f => fsp.rm(f, { force: true }).catch(() => {})));

    // eslint-disable-next-line no-param-reassign
    launchContext.userDataDir = effectiveDir;
  };
};

export const failedRequestHandler = async ({ request }: { request: Request }) => {
  guiInfoLog(guiInfoStatusTypes.ERROR, { numScanned: 0, urlScanned: request.url });
  log.error(`Failed Request - ${request.url}: ${request.errorMessages}`);
};

export const isUrlPdf = (url: string) => {
  if (isFilePath(url)) {
    return /\.pdf$/i.test(url);
  }
  const parsedUrl = new URL(url);
  return /\.pdf($|\?|#)/i.test(parsedUrl.pathname) || /\.pdf($|\?|#)/i.test(parsedUrl.href);
};

export async function shouldSkipClickDueToDisallowedHref(
  page: Page,
  element: ElementHandle
): Promise<boolean> {
  return await page.evaluate(
    ({ el, disallowedPrefixes }) => {
      function isDisallowedHref(href: string | null): boolean {
        if (!href) return false;
        href = href.toLowerCase();
        return disallowedPrefixes.some((prefix: string) => href.startsWith(prefix));
      }

      const castEl = el as HTMLElement;

      // Check descendant <a href="">
      const descendants = castEl.querySelectorAll('a[href]');
      for (const a of descendants) {
        const href = a.getAttribute('href');
        if (isDisallowedHref(href)) {
          return true;
        }
      }

      // Check self and ancestors for disallowed <a>
      let current: HTMLElement | null = castEl;
      while (current) {
        if (
          current.tagName === 'A' &&
          isDisallowedHref(current.getAttribute('href'))
        ) {
          return true;
        }
        current = current.parentElement;
      }

      return false;
    },
    {
      el: element,
      disallowedPrefixes: disallowedListOfPatterns,
    }
  );
}

/**
 * Check if response should be skipped based on content headers.
 * @param response - Playwright Response object
 * @param requestUrl - Optional: request URL for logging
 * @returns true if the content should be skipped
 */
export const shouldSkipDueToUnsupportedContent = (
  response: PlaywrightResponse,
  requestUrl: string = ''
): boolean => {
  if (!response) return false;

  const headers = response.headers();
  const contentDisposition = headers['content-disposition'] || '';
  const contentType = headers['content-type'] || '';

  if (contentDisposition.includes('attachment')) {
    // consoleLogger.info(`Skipping attachment (content-disposition) at ${requestUrl}`);
    return true;
  }

  if (
    contentType.startsWith('application/') ||
    contentType.includes('octet-stream') ||
    (!contentType.startsWith('text/') && !contentType.includes('html'))
  ) {
    // consoleLogger.info(`Skipping non-processible content-type "${contentType}" at ${requestUrl}`);
    return true;
  }

  return false;
};
