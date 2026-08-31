# Design QA — 监控大屏重点目标模块与地图视频弹窗

- Source visual truth: `C:\Users\黄建凯\AppData\Local\Temp\codex-clipboard-33091226-24f7-42c8-8719-7b1ded8daf80.png`
- Implementation screenshot: `E:\沉积岩\demo-ronghe\design-qa-assets\implementation-bigscreen-target-dynamics.png`
- Interaction screenshot: `E:\沉积岩\demo-ronghe\design-qa-assets\implementation-bigscreen-video-modal.png`
- Viewport: 1920 × 900 CSS px, device scale factor 1
- Source pixels: 1920 × 900; implementation pixels: 1920 × 900
- Density normalization: both artifacts were inspected at native 1× density with matching viewport and crop.
- State: `bigscreen.html`, online AMap loaded; default dashboard and clicked-unmanned-aircraft video modal states.

## Full-view comparison evidence

- The three-column dashboard, header, KPI row, map extent, panel geometry, borders, corner decoration, typography, and semantic color system remain aligned with the source.
- The source's blank realtime-video slot is intentionally replaced with a populated “重点目标动态” table in the same panel footprint, so no surrounding region shifts or resizes.
- The replacement module uses existing table density and tokens, displays four visible rows without clipping, and reports the live/actively tracked totals in the panel header.
- The map hint is compact and non-interactive; it does not obscure persistent controls or important map content.

## Focused comparison evidence

- The replacement panel was inspected at full 1920 × 900 resolution. Target IDs, districts, risk levels, and states remain readable; long values truncate within fixed table columns instead of overflowing.
- The modal interaction screenshot confirms that clicking a map unmanned-aircraft target opens a centered realtime-video view with the selected target ID, optical device, preview state, legal status, and risk level.
- Focused evidence was required because the new table and modal text are too small to validate reliably from layout geometry alone.

## Required fidelity surfaces

- Fonts and typography: the existing PingFang SC/system and Menlo/Consolas stacks, header hierarchy, table sizes, line heights, and numeric treatment are preserved.
- Spacing and layout rhythm: the replacement occupies the original middle-left panel, keeps existing padding and row rhythm, and introduces no viewport overflow.
- Colors and visual tokens: risk and state colors reuse the dashboard's red, amber, cyan, and green semantic tokens; panel surfaces and modal elevation match the existing theme.
- Image quality and asset fidelity: the existing logo, map rendering, chart canvases, KPI ring, and EO video renderer remain unchanged and sharp at the tested density.
- Copy and content: the module title, live/track totals, target metadata, map instruction, and video-modal labels are concise and consistent with the low-altitude safety domain.

## Interaction and console checks

- Verified map unmanned-aircraft hover, click, selected-target video modal opening, animated video canvas creation, and close-button dismissal.
- Verified the original realtime-video panel is absent from the DOM and the replacement displays four height-fitted target rows.
- Verified no horizontal or vertical viewport overflow at 1920 × 900.
- Browser console errors/warnings: none.

## Findings

- No actionable P0/P1/P2 visual or interaction issues remain.
- Accepted intentional difference: the highlighted blank “实时视频” source region now contains “重点目标动态,” as requested.

## Comparison history

1. Earlier P1: the realtime-video panel was hidden only with the HTML `hidden` attribute, but the product's panel display rule overrode it and left a visible blank realtime-video shell.
2. Fix: replaced the shell with the data-backed “重点目标动态” table and preserved realtime video exclusively as a map-target modal.
3. Post-fix evidence: the final dashboard screenshot shows the replacement panel without layout drift, and the interaction screenshot shows the selected-target realtime-video modal.

final result: passed
