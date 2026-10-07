# SPICE Plot Generator

**Use it online: https://pitt-vignali-lab.github.io/SPICE/**

A browser-based tool that turns an Excel / CSV file into SPICE-style polyfunctionality pie charts (pie slices = Boolean combinations, outer arcs = individual markers). Everything runs locally in the browser; data is never uploaded.

## Input formats

**A. Combination table** — one row per Boolean combination; marker columns contain `+`/`-` (or `1`/`0`, `Y`/`N`); every numeric column is one pie.

| IFNg | TNFa | IL2 | Healthy | HIV |
|------|------|-----|---------|-----|
| +    | +    | +   | 0.12    | 0.02 |
| +    | +    | -   | 0.35    | 0.10 |

**B. Gate-name columns (FlowJo export / Shiny-app CSV)** — one row per sample; column names encode the combination, e.g.
`CD4/IFNg+TNFa-IL2+ | Freq. of Parent` or `PD1+/LAG3-/TIGIT+`. A gate whose own name ends in `+` also works: a trailing `+-` is read as negative, so `GZMB+IFNg+TNFa-` and `GZMB+-IFNg+TNFa-` are GZMB+ and GZMB- of the same marker. When a file contains such `+-` gates, a note at the top of the page states the convention that was applied. The sample-name column is detected automatically (a `Sample`/`Name`/`ID`-style header, else the text column with the most distinct values); the remaining text columns (e.g. `Group`) can be used to average pies per group. Rows named Mean / SD are ignored, and parent gates that are always positive (e.g. `CD4+`) are dropped.

## Options

Pie selection or per-group means, marker on/off (collapses combinations), marker display names and arc colors, slice coloring, sort order, radius / donut hole / arc width & spacing, start angle and direction, percent labels, title, font, legend position, background. Export as SVG, PDF (vector), PNG or JPEG (150/300/600 DPI, DPI written into the file), plus the processed data as CSV.

## Deploy on GitHub Pages

1. Push this folder to a GitHub repository.
2. Repository → **Settings → Pages** → Source: *Deploy from a branch*, Branch: `main`, folder `/ (root)`.
3. The site appears at `https://<user>.github.io/<repo>/` after about a minute.

To try it locally, just open `index.html` in a browser.
