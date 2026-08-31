# Design QA — 数据大屏光感与切角装甲框

- Source visual truth: `C:\Users\黄建凯\AppData\Local\Temp\codex-clipboard-fc444005-39c4-4e48-bc1d-7ec21f811c8e.png`
- Supporting generated background: `C:\Users\黄建凯\.codex\generated_images\01a05653-cc16-7201-a113-7b9f1fd710bc\exec-de905992-22c2-4836-be23-893c8cc3435b.png`
- Project background asset: `E:\沉积岩\demo-ronghe\public\assets\img\bigscreen\cockpit-glow-bg.png`
- Implementation screenshot (compact): `C:\Users\黄建凯\AppData\Local\Temp\demo-ronghe-glow-qa\implementation-chamfer-1366x768.png`
- Implementation screenshot (large): `C:\Users\黄建凯\AppData\Local\Temp\demo-ronghe-glow-qa\implementation-chamfer-1920x900.png`
- Comparison image: `C:\Users\黄建凯\AppData\Local\Temp\demo-ronghe-glow-qa\comparison-frame-reference-vs-implementation.png`
- Source pixels: 821 × 528; dashboard crop: 810 × 456. Implementation pixels: 1366 × 768 and 1920 × 900.
- CSS viewports: 1366 × 768 and 1920 × 900; device scale factor 1.
- Density normalization: the 810 × 456 dashboard region was cropped from the reference and resampled to 1366 × 768; the implementation remained at native 1× density.
- State: `#/bigscreen`, default dashboard after map and charts settled.

## Full-view comparison evidence

- The implementation now matches the reference's key border language: clipped corners, bright cyan outer frame, restrained inner frame, deep-blue translucent surface, and semantic KPI glow.
- The generated cockpit image is clearly visible in the title canopy, page gaps, KPI cards, and side panels without overlaying the map.
- The existing three-column hierarchy, map area, chart placement, panel count, labels, and actions remain unchanged.
- Both required viewports exactly match document width and height with no horizontal or vertical overflow.
- Intentional exception: the source concept uses a dark map; the production implementation keeps the existing light AMap, markers, center, zoom, controls, data, and UAV video interaction as explicitly required.

## Focused comparison evidence

- Header/KPI region: checked at native resolution for title halo, frame cuts, two-layer borders, semantic colors, ring sharpness, and equal card sizing.
- Side panels: checked for all four clipped corners, inner border continuity, title/summary readability, chart contrast, and table alignment.
- Action cards: checked for smaller matching cut corners, real Ionicons, risk colors, hover/focus affordance, and text truncation.
- Focused extra crops were unnecessary because the 1366 × 768 native screenshot keeps headers, icons, table copy, and border geometry readable.

## Required fidelity surfaces

- Fonts and typography: title, headers, KPI numerals, chart labels, legends, and table rows retain clear optical hierarchy with no overlap or broken wrapping.
- Spacing and layout rhythm: three columns, KPI band, 10–12px gaps, and equal panel heights remain stable at 1366 × 768 and 1920 × 900.
- Colors and tokens: cyan/blue remain normal-operation colors; amber means pending; red is reserved for danger; green means normal or low risk.
- Image quality and asset fidelity: the generated 16:9 background is used at cover size without stretching; the existing brand logo, title wing, KPI ring, panel assets, map, and video renderer remain real assets; business icons come from Ionicons.
- Copy and content: module titles, KPI labels, summaries, chart legends, table columns, and entry labels remain coherent and readable.
- Accessibility and motion: buttons remain semantic, Enter-based chart navigation works, focus outlines remain visible, and all new frame animations stop under `prefers-reduced-motion`.

## Interaction and technical checks

- Passed: KPI click route to `#/situation`.
- Passed: action-card click route to `#/alarms`.
- Passed: chart Enter key route to `#/legality`.
- Passed: six panels and four KPI cards render after route return.
- Browser console errors/warnings: none.
- Production build: passed (`4044 modules transformed`).
- Source compliance scan: all 9 checks passed.
- `git diff --check`: passed; only repository line-ending notices remain.

## Findings and comparison history

1. Earlier P2: the generated background was technically loaded but nearly hidden by a 60% page veil and 88% opaque panels.
   Fix: increased the asset layer visibility and allowed the light texture to pass through the header, side panels, and KPI surfaces while leaving the map opaque.
   Post-fix evidence: both final screenshots clearly show the canopy circuitry and blue energy illumination.
2. Earlier P2: ordinary rectangular borders did not match the selected effect image's technical frame language.
   Fix: replaced side-panel and KPI borders with two-layer clipped-corner frames, semantic KPI edge colors, and smaller matching action-card cuts.
   Post-fix evidence: the final side-by-side comparison shows matching chamfer geometry and cyan edge hierarchy.

## Follow-up polish

- P3: the reference's dark map increases overall contrast, while the production light map remains intentionally unchanged by product constraint.

final result: passed
