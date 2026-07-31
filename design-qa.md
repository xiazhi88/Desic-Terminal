# Design QA

## Startup Config Preview

Reference target: clean cyber coin-selection concept with one large polished center asset, dark side assets, purple spotlight, low transparent platform, and minimal UI.

Prototype screenshot: `design-qa-startup-config-cinematic-v4.png`

Checked:

- Center coin is the dominant visual object and uses preview-only polished metal material overrides.
- BTC and DOGE use a stronger gold material palette instead of the earlier copper-like tone.
- Side coins remain present but are smaller and substantially darker through scene positioning, material brightness, and light falloff.
- Background uses a darker virtual floor with a visible perspective grid, purple focus light, and minimal UI.
- The central coin is lowered into the platform surface and supported with a stronger contact shadow.
- Cinematic pass adds restrained bloom, a lower camera angle, darker platform top, purple rim light, and a softer elliptical floor reflection.
- Drag/click carousel remains interactive.
- Main app flow is not integrated with this preview work.
- Build passes with no runtime console errors in the preview capture.

Remaining polish:

- The real GLB geometry still limits perfect reference fidelity. For final production, custom bevels, authored PBR materials, normal maps, and controlled environment reflections would outperform runtime material overrides.

## Market Intelligence V2

- Reference: `C:/Users/云创/.codex/visualizations/2026/07/20/019f7f3d-e93b-7ed2-b20a-a9bcae20730e/okx-market-intelligence-derivatives-mockup.png`
- Implementation capture: `C:/Users/云创/AppData/Local/Temp/desic-intelligence-1440x900-derivatives.png`
- Combined comparison: `C:/Users/云创/.codex/visualizations/2026/07/20/019f7f3d-e93b-7ed2-b20a-a9bcae20730e/okx-market-intelligence-v2-comparison.png`
- Viewports verified: 1440x900 and 1280x720

The implementation preserves the approved 12-column evidence layout: an 8/4 positioning and crowding row followed by three 4-column panels for taker flow, funding/basis, and system stress. It follows the existing terminal navigation, typography, borders, red/green market semantics, compact controls, and local-scroll behavior rather than copying the mockup's surrounding shell.

Checks passed:

- Five derivatives evidence panels render with nonblank `lightweight-charts` canvases.
- Crosshair hover details and synchronized Asia/Shanghai time axes render.
- Smart Money bar and X-axis centers differ by 0px.
- No global horizontal or vertical overflow at either viewport.
- Labels use the required evidence terminology and expose coverage/degraded states.
- The implementation does not introduce nested decorative cards, oversized headings, gradients, or overlapping controls.

final result: passed
