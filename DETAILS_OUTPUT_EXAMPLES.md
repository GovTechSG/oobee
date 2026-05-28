# Enriched Details Output Examples

These are real outputs captured from `scanPage` against intentionally non-compliant test pages.
The **Details** panel in the HTML report renders the `message` field shown below.

---

## 1. `color-contrast` (WCAG AA — mustFix)

**Element:**
```html
<p style="color: #999999; font-size: 14px;">This light gray text on white background fails AA contrast</p>
```

**Details message:**
```
Multiple text elements in this component fail WCAG 1.4.3 Color Contrast Minimum.
Audit all visible text in the snippet and update every failing foreground color so
normal text achieves at least 4.5:1 contrast against its actual background, with a
safety margin above the minimum where possible. Known failing combinations in this
snippet include foreground #999999 on #ffffff at 14px normal text (current contrast
2.84, expected 4.5:1). Fix all failing text colors in the component, not just the
first reported element. Recommendation: To meet the required contrast ratio, for
foreground #999999 on background #ffffff (target 4.5:1), adjust foreground to #737373
(rgb(115, 115, 115)) or background to #2e2e2e (rgb(46, 46, 46)).
```

**Element:**
```html
<button style="background-color: #55aa99; color: #e8ffe8; font-size: 12px;">Low contrast button</button>
```

**Details message:**
```
Multiple text elements in this component fail WCAG 1.4.3 Color Contrast Minimum.
Audit all visible text in the snippet and update every failing foreground color so
normal text achieves at least 4.5:1 contrast against its actual background, with a
safety margin above the minimum where possible. Known failing combinations in this
snippet include foreground #e8ffe8 on #55aa99 at 12px normal text (current contrast
2.61, expected 4.5:1). Fix all failing text colors in the component, not just the
first reported element. Recommendation: To meet the required contrast ratio, for
foreground #e8ffe8 on background #55aa99 (target 4.5:1), adjust foreground to #003a00
(rgb(0, 58, 0)) or background to #3d7a6e (rgb(61, 122, 110)).
```

---

## 2. `color-contrast-enhanced` (WCAG AAA — goodToFix)

**Element:**
```html
<p style="color: #757575; font-size: 14px;">This text passes AA but fails AAA needs 7 to 1</p>
```

**Details message:**
```
Multiple text elements in this component fail WCAG 1.4.3 Color Contrast Minimum.
Audit all visible text in the snippet and update every failing foreground color so
normal text achieves at least 7:1 contrast against its actual background, with a
safety margin above the minimum where possible. Known failing combinations in this
snippet include foreground #757575 on #ffffff at 14px normal text (current contrast
4.6, expected 7:1). Fix all failing text colors in the component, not just the first
reported element. Recommendation: To meet the required contrast ratio, for foreground
#757575 on background #ffffff (target 7:1), adjust foreground to #555555
(rgb(85, 85, 85)).
```

**Element:**
```html
<p style="color: #6b6b6b; font-size: 12px;">Small text needs 7 to 1 for AAA</p>
```

**Details message:**
```
Multiple text elements in this component fail WCAG 1.4.3 Color Contrast Minimum.
Audit all visible text in the snippet and update every failing foreground color so
normal text achieves at least 7:1 contrast against its actual background, with a
safety margin above the minimum where possible. Known failing combinations in this
snippet include foreground #6b6b6b on #ffffff at 12px normal text (current contrast
5.32, expected 7:1). Fix all failing text colors in the component, not just the first
reported element. Recommendation: To meet the required contrast ratio, for foreground
#6b6b6b on background #ffffff (target 7:1), adjust foreground to #555555
(rgb(85, 85, 85)).
```

---

## 3. `target-size` (WCAG 2.5.8 — mustFix)

### Example A: `content-box` elements (no WARNING)

**Element:**
```html
<a href="/a" class="icon-link" style="width: 16px; height: 16px;">A</a>
```

**Details message:**
```
Fix any of the following:
  Target has insufficient size (16px by 16px, should be at least 24px by 24px)
  Target has insufficient space to its closest neighbors. Safe clickable space has a
  diameter of 17px instead of at least 24px.
  Computed hit area: 16px × 16px (box-sizing: content-box).
```

### Example B: `border-box` element with explicit inline width/height (WARNING appended)

**Element:**
```html
<button style="width: 20px; height: 20px; padding: 0; box-sizing: border-box;">X</button>
```

**Details message:**
```
Fix any of the following:
  Target has insufficient size (20px by 20px, should be at least 24px by 24px)
  Target has insufficient space to its closest neighbors. Safe clickable space has a
  diameter of 21px instead of at least 24px.
  Computed hit area: 20px × 20px (box-sizing: border-box).
  Tip: inline style sets width: 20px, height: 20px with box-sizing: border-box —
  padding is included within those dimensions and will not increase the hit area. Fix:
  remove the explicit width/height and use min-width: 24px; min-height: 24px instead,
  or place the visual content in a child <span> element.
```

---

## 4. `valid-lang` (mustFix)

**Element:**
```html
<div lang="x-klingon">This section also has an invalid private-use lang tag with some sample text content for context.</div>
```

**Details message:**
```
Fix all of the following:
  Value of lang attribute not included in the list of valid languages
  Note: "x-klingon" uses a private-use "x-" prefix. axe-core's valid-lang rule also
  rejects private-use subtags — you must use a registered IANA language code.
  Original text: "This section also has an invalid private-use lang tag with some sample
  text content for context.". Identify the actual language of this text and use its
  registered BCP 47 code (e.g., lang="it" Italian, "es" Spanish, "fr" French,
  "de" German, "zh" Chinese, "ja" Japanese, "ko" Korean, "pt" Portuguese, "ar" Arabic).
```

---

## 5. `oobee-grading-text-contents` (WCAG AAA — needsReview)

**Element:**
```html
<html lang="en">...</html>
```

**Details message:**
```
The text content is potentially difficult to read, with a Flesch-Kincaid Reading Ease
score of 33.92. Difficult — college level or above.
```

### Score interpretation table (appended inline after the numeric score)

Only scores in the range 1–50 trigger a violation (scores > 50 pass, scores ≤ 0 are filtered out).

| Score Range | Interpretation appended to message |
|---|---|
| 31–50 | Difficult — college level or above. |
| 1–30 | Very difficult — best understood by university graduates. |

---

## Notes

- **color-contrast** and **color-contrast-enhanced** messages include computed color recommendations using WCAG relative luminance math with a binary search on HSL lightness.
- **target-size** appends `Computed hit area` and, when `box-sizing: border-box` with explicit inline dimensions is detected, a `Tip` explaining why padding won't help.
- **valid-lang** appends a `NOTE` when the lang value uses a private-use `x-*` prefix, plus the element's text content (up to 120 chars) to help identify the correct language code.
- **oobee-grading-text-contents** now appends a plain-language interpretation of the Flesch-Kincaid score immediately after the numeric value.
