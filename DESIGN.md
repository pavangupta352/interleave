---
name: Interleave
description: A precise visual system for inspecting recorded database executions.
colors:
  paper: "#fbfaf7"
  surface: "#ffffff"
  ink: "#20282f"
  muted: "#59636b"
  rule: "#d7dcd9"
  blue: "#245f81"
  blue-paper: "#edf4f8"
  red: "#a43b32"
  red-paper: "#f9ece8"
  amber: "#825414"
  amber-paper: "#fcf2df"
  green: "#35614d"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "25px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "17px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  subheading:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 650
    lineHeight: 1.5
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "14px"
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "12px"
    lineHeight: 1.5
  button:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 550
    lineHeight: 1.5
  code:
    fontFamily: "ui-monospace, 'SFMono-Regular', Consolas, 'Liberation Mono', monospace"
    fontSize: "12px"
    lineHeight: 1.7
rounded:
  field: "4px"
  button: "5px"
spacing:
  compact: "8px"
  inset: "12px"
  control: "16px"
  mobile-gutter: "20px"
  section: "24px"
  wide-gutter: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    padding: "7px 13px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    padding: "7px 13px"
  button-text:
    textColor: "{colors.blue}"
    padding: "3px 0"
  search-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.field}"
    padding: "7px 10px"
  actor-select:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.field}"
    padding: "7px 24px 7px 10px"
  outcome-failure:
    backgroundColor: "{colors.red-paper}"
    textColor: "{colors.red}"
    rounded: "{rounded.field}"
    padding: "4px 9px"
  outcome-incomplete:
    backgroundColor: "{colors.amber-paper}"
    textColor: "{colors.amber}"
    rounded: "{rounded.field}"
    padding: "4px 9px"
  command-selected:
    backgroundColor: "{colors.blue-paper}"
    textColor: "{colors.ink}"
    padding: "15px"
    width: "100%"
  sql-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
    rounded: "{rounded.field}"
    padding: "15px"
  wait-observation:
    backgroundColor: "{colors.amber-paper}"
    textColor: "{colors.amber}"
    typography: "{typography.label}"
    rounded: "{rounded.field}"
    padding: "12px"
---

# Design System: Interleave

## Overview

**Creative North Star: "The Experiment Record"**

Interleave uses warm white surfaces, dark ink, fine rules and compact controls to make a recorded execution easy to inspect. The interface gives exact SQL and numerical evidence room to remain readable while keeping supporting metadata quiet. Its character is practical, restrained and precise.

The system is implemented in the offline evidence viewer. Standard platform typography and native controls make it usable without downloaded fonts or other external assets. The visual hierarchy connects a written result to identifiable commands and their recorded details. This document describes the current implementation; the viewer's task flow belongs in its surface brief.

**Key Characteristics:**

- Warm white ground with white evidence fields and slate supporting text.
- Flat, ruled structure with blue selection and explicit written status.
- Compact platform typography with purposeful SQL and identifier monospace.
- Stable command identity across filtering, paging and responsive layouts.

## Colors

The neutral palette provides a quiet ground for selection and recorded outcome states. The frontmatter names match the stylesheet's custom properties.

### Primary

- **Selection blue** (`blue`) identifies links, text actions, keyboard focus, selected step numbers and the current actor label.
- **Selection wash** (`blue-paper`) marks the selected command without reducing SQL contrast.

### Secondary

- **Failure red** (`red`) and **failure wash** (`red-paper`) identify invariant violations and actor or harness failures. Red also marks incomplete cleanup and copy/import feedback errors.
- **Wait amber** (`amber`) and **wait wash** (`amber-paper`) identify observed waits and outcomes whose conclusion is incomplete or incompatible.
- **Completion green** (`green`) accompanies the written invariant-held and cleanup-complete states.

### Neutral

- **Warm paper** (`paper`) is the page ground.
- **Evidence white** (`surface`) backs inputs, SQL fields and populated command cells.
- **Ink** (`ink`) carries primary text and the filled action button.
- **Slate** (`muted`) carries supporting labels, metadata and explanatory notes.
- **Ledger rule** (`rule`) separates rows, actor lanes and detail groups. The inspector and table header use lightly tinted neutral surfaces to distinguish their roles.

**The Written State Rule.** Pair semantic color with a written outcome, actor name, error code or observation label. Color must not carry a result or actor identity by itself.

## Typography

Platform sans serves headings, copy, controls and labels. Monospace serves SQL, step numbers, release times, fingerprints and structured observations. The root uses tabular numerals so numbers remain aligned without requiring every label to be monospace.

The hierarchy is compact: headline, section title, subheading, body, label and code roles are defined in the frontmatter. Headline size reduces to 23px at the narrow-layout breakpoint. Long scenario names wrap rather than forcing the page wider. Explanatory paragraphs commonly stop at 75 characters per line; empty-state copy stops at 65.

**The Exact Text Rule.** A ledger preview may normalize whitespace and stop after two lines. The inspection field displays the recorded SQL with preserved whitespace and natural wrapping; copying uses the full recorded value.

## Layout

The shared spatial grammar uses full-width sections, fine dividers and aligned evidence columns. Desktop page sections use the wide gutter; narrower layouts use the mobile gutter. Repeated small gaps separate controls and labels, while larger section gaps distinguish groups of evidence. Spacing values describe a recurring vocabulary, not a rigid scale applied to every measurement.

The evidence viewer places its ledger beside an inspector. Above 1100px, the inspector occupies 35% of the workspace with a 335px minimum. At 1100px and below it becomes a fixed 330px column. The inspector stays visible while the ledger scrolls, with its own overflow constrained to the viewport. Three or more actor lanes may scroll horizontally on desktop.

At 780px and below, the viewer becomes a single column. Actor lanes consolidate into one command column with an explicit actor name on every command; original step and release-time columns remain. The inspector follows the ledger in normal page flow. Controls wrap, and the footer becomes a vertical stack. At 420px and below, masthead actions share the full width and have a 40px minimum height.

Selection controls stay at the top while scrolling. Paging reveals the opening command below those controls before focusing it. The same selected command remains identifiable in the ledger and inspector. These dimensions and behaviors belong to the current viewer; reuse its alignment and responsive priorities when adding related surfaces.

## Elevation & Depth

Depth comes from neutral surface changes, borders and position. Containers do not use drop shadows. The selected command uses a thin inset blue outline, implemented as a box shadow, to preserve its bounds without lifting it above the ledger. Keyboard focus uses a separate blue outline (2px with a 3px offset); inside command cells the offset turns inward to remain visible.

**The Ruled Surface Rule.** Use dividers and tonal differences to separate adjacent evidence regions. Reserve the inset selection outline for the command currently under inspection.

## Shapes

The ledger and major sections have square edges. Inputs, status labels, wait observations and code fields use the small field radius; ordinary buttons use the slightly larger button radius. Text actions have no containing shape. Fine, single-pixel borders create the recurring geometry. The interface contains no decorative raster imagery.

## Components

### Buttons and text actions

The filled ink button carries the JSON download action. White outlined buttons carry artifact opening and ordinary controls. Both have a 36px minimum height in the default layout; paging uses a smaller variant. Hover changes the surface and border tone. Disabled controls use muted text and a pale neutral fill. All keyboard-operable controls retain the visible focus outline.

Underlined blue text actions support copying and selection handoffs. They are real buttons, with button keyboard behavior. Copy failures provide a written manual-copy fallback. Artifact opening temporarily disables its trigger and changes its label; invalid input leaves the current record in place and reports the failure.

### Filters

Search and the native actor selector use white fields, a fine neutral stroke and small rounded corners. Both have accessible labels independent of their placeholder or selected option. Search matches SQL, actor names and errors. Filtering preserves original step numbers and reports matching and recorded counts separately. A no-results state offers a clear-filter action.

### Outcomes and observations

Outcome labels have compact, lightly tinted backgrounds and semibold written status. A passed execution says “Invariant held”; it does not imply that all schedules passed. Amber wait observations name the wait event and recorded blockers. Missing wait observations receive explanatory text. Missing completion, incomplete cleanup and invalid records remain visibly distinct from successful results.

### Command ledger and paging

Commands are full-cell buttons within a ruled table. Each shows a two-line SQL preview and compact protocol/completion metadata. Selected commands use the blue wash and inset outline; the step number also strengthens. Selection is exposed through `aria-pressed`, and each command identifies the inspector it controls.

Accessible command names retain step, actor and SQL while also naming the protocol, any separate stage, completion or error, and recorded wait count. This keeps those outcomes available during keyboard and screen-reader navigation, including when a command records both an error and waits.

Arrow keys and Home/End navigate the filtered order, including across the 100-command page boundary. The keyboard sequence uses one command tab stop at a time. Previous and Next controls show whether traversal is available and reveal the next page's opening command when used. Selecting a command updates the inspector and a polite status message.

### Inspector and SQL field

The inspector groups exact SQL, completion facts and observed waits under short headings. Label/value facts align in two columns and allow long values to wrap. The SQL field preserves whitespace, wraps long content and scrolls within its height limit. An explicit “Inspect selection” action moves focus to the inspector; the narrow layout adds “Back to selected command” to restore the command in view, clearing filters when necessary.

### Disclosures and feedback

Native disclosures hold command identity, actor observations, and record/replay details. Their labels stay visible above thin rules; supporting evidence expands in place. Imported values render as text. The replay command is displayed and copyable, and the viewer does not execute it. A polite live status region reports selection, filtering, import, download and clipboard feedback.

Record details include the captured fixture profile, digest, object and row counts; source, installed dependency and runtime identities; the connection profile; and actor startup digests. Missing identities in older records are labeled explicitly. Long digests wrap within the existing fact layout on narrow screens.

The only selection animation is a brief background wash (180ms). It runs only when reduced motion is not requested. Focus and result state do not depend on animation. Print styles hide interactive controls; the rendered ledger page and currently displayed details remain the print content.

## Do's and Don'ts

### Do:

- Do pair status color with explicit words and retain actor names in narrow layouts.
- Do preserve original command identity when filtering or moving between pages.
- Do keep full SQL available for inspection and copying when previews are shortened.
- Do retain visible keyboard focus, selection handoffs and reduced-motion behavior.
- Do use ruled, flat evidence regions with restrained neutral separation.
- Do state missing evidence, incomplete runs and exploration limits in plain language.

### Don't:

- Don't imply server execution order from client command release order.
- Don't treat an invariant-held record as proof that an application is race-free.
- Don't label a missing wait observation as proof that no waiting occurred.
- Don't substitute shortened previews for exact inspection or clipboard values.
- Don't add remote fonts or decorative image dependencies to the offline viewer.
