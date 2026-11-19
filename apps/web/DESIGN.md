# Thetis web: visual system

Direction **Certificate of Analysis**: every figure is reported like an assay result, with its
value, unit, basis and who attested it. The work queue is the first screen, never a KPI wall. The
tokens live in `src/app/globals.css`; this file records the decisions behind them.

## Colour (restrained: tinted neutrals plus one action colour)

| Token                       | Light                 | Dark                  | Job                                                 |
| --------------------------- | --------------------- | --------------------- | --------------------------------------------------- |
| `--paper`                   | `#F6F7F5`             | `#111517`             | page ground                                         |
| `--sheet`                   | `#FFFFFF`             | `#181D20`             | tables, panels, inputs                              |
| `--ink`                     | `#1B2023`             | `#E6EAE8`             | text, header rule, table head rule                  |
| `--ink-2`                   | `#545D62`             | `#A3ADB1`             | secondary text, basis lines, column heads           |
| `--rule` / `--hair`         | `#C7CDCA` / `#E1E5E3` | `#323B3F` / `#252C30` | borders / row dividers                              |
| `--act` / `--act-ink`       | `#2E6B57` / `#FFFFFF` | `#5FAF92` / `#0E1A15` | actionable controls only (chrome-oxide green)       |
| `--refuse`                  | `#A13A2E`             | `#E58273`             | refusals and errors only                            |
| `--rail`                    | `#1B2023`             | `#0B0E10`             | side rail, dark in both themes                      |
| `--pledged-tint`            | `#DCE8E2`             | `#1F3A31`             | pledged segment of the quantity bar; text selection |
| `--banner` / `--banner-ink` | `#1B2023` / `#E8ECEA` | `#E6EAE8` / `#111517` | reference banner, inverts in dark                   |

Rules: green never marks a state, only something you can press. No gold, amber or orange-yellow.
No gradients, glows or grid backgrounds.

## Type

- **Archivo** variable (`wght` 400–700, `wdth` 100–125), self-hosted via `next/font/local`. Body
  14/1.45 at width 100; page titles 28/1.1, weight 600, width 118; panel headings 16/1.2, width
  110; wordmark 20px, width 125.
- **JetBrains Mono** 500 for identifiers only: lot IDs, the settlement-mode line.
- Every figure: `tabular-nums`, right-aligned in tables, always with its unit.
- Column heads: 11px, 600, uppercase, 0.06em tracking. No eyebrow labels above headings.

## Shape and depth

One radius, 4px, on every control, mark and panel; tables are square. No shadows except the
dropdown menu. Motion: 150ms colour transitions and a 1px press; nothing animates on load.

## Signature: printed state marks

Registry status is a printed mark: dashed hairline for anything not confirmed (including "Not on
chain"), solid for confirmed, heavier solid for finalized, ferric for failed or unknown outcome.
Custody, finance, restriction and payment states use the same mark with a muted prefix and always
stay dashed, because a scenario state is never a registry fact. The quantity bar shows the whole
lot; a pending release is hatched inside the pledged segment, never added to it.

## Layout

232px graphite rail (wordmark, organisation context switcher, four destinations with counts,
theme toggle) beside a 1180px-max content column. Below 1024px the rail becomes a top bar; below
768px tables become stacked label/value blocks.
