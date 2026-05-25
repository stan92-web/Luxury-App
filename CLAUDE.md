# Luxury House App — Claude Quick Reference

## Critical Constraints — NEVER TOUCH
- **Branch**: Always push to `claude/upload-version-20-wlfA6` (403 on any other)
- **Print CSS**: `@page { size: A4 portrait; margin: 5mm 9mm; }` — DO NOT MODIFY
- **Print canvas lock**: `prepareForPrint()` in survey.js — DO NOT MODIFY
- **Version bump**: Bump `?v=XX` on ALL 5 `<script>` tags in index.html on every change

## Tech Stack
- Pure HTML/CSS/JS, no framework, no build
- Netlify auto-deploy from GitHub → app.luxuryhouseonline.com
- Google Apps Script Web App backend (Sheets + Drive) via data.js
- iPad Safari primary target (aggressive caching — always bump version)

## File Map
| File | Role |
|------|------|
| `index.html` | Shell, fullscreen overlay toolbar (`#fs-tools`), 5 `<script>` tags |
| `css/style.css` | All styles. See TABLE OF CONTENTS inside file |
| `js/sketch.js` | Canvas drawing engine. See TABLE OF CONTENTS inside file |
| `js/survey.js` | Form logic, room management, buildRoomHTML(), print engine |
| `js/auth.js` | PIN login |
| `js/data.js` | AppData constants (OFFICE_WA etc.) |
| `js/orders.js` | Orders panel, email, save to Sheets |

## Shape Types (sketch.js)
Current types: `pen`, `line`, `rect`, `text`, `wardrobe4door`, `wardrobeCorner`, `wardrobeChest`, `wardrobeDesk`, `wardrobeBedside`

### Adding a NEW shape type — grep `wardrobeDesk` to find all ~12 locations:
1. `hitShapeHandle` — add to the if-condition for rect-like shapes
2. `hitShapeBody` — add bbox check
3. `drawSelectionHandles` — add to rect-like if-condition
4. `onDown` select-tool resize pivot (line ~254)
5. `onDown` rect-tool resize pivot (line ~290)
6. `onMove` resize block (line ~327)
7. `onMove` body-drag block (line ~343)
8. `fsDown` select-tool resize pivot (line ~1202)
9. `fsDown` rect-tool resize pivot (line ~1236)
10. `fsMove` resize block (line ~1268)
11. `fsMove` body-drag block (line ~1283)
12. `scaleShapes` — add x/y/w/h scaling line
13. `buildTemplate` — add name case
14. `renderShape` — add rendering block
15. measurement finders in `insertMeasurement` and `fsInsertMeasurement`
16. Small canvas toolbar in survey.js `buildRoomHTML`
17. Fullscreen furniture panel in index.html `#fs-furn-panel`

## Key Functions (sketch.js)
| Function | Purpose |
|----------|---------|
| `buildTemplate(name, W, H)` | Returns array of shapes for a premade |
| `fsTpl(name)` | Insert template into fullscreen canvas |
| `insertTemplate(id, name)` | Insert template into small canvas |
| `fsRedraw()` | Redraws fullscreen canvas + updates conditional toolbar visibility |
| `fsAddSection/fsRemoveSection` | +/– doors (4door) or drawers (chest) |
| `fsFlipCorner` | Mirror wardrobeCorner or wardrobeDesk pedestal |
| `fsFurnitureMenu/fsCloseFurniture` | Toggle furniture dropdown panel |
| `_fsUndoClearDown/Up/Cancel` | Long-press Undo/Clear for fullscreen button |
| `_undoClearDown/Up/Cancel` | Long-press Undo/Clear for small-canvas button |
| `fsInsertMeasurement(label, prefix)` | Insert W/H/D label, auto-switches to select |
| `insertMeasurement(id, label, prefix)` | Same for small canvas |

## Toolbar Conditional Elements (fullscreen)
| Element ID | Shown when |
|------------|-----------|
| `fs-section-rem/count/add/sep` | wardrobe4door or wardrobeChest selected |
| `fs-corner-flip/sep` | wardrobeCorner or wardrobeDesk selected |
| `fs-furn-panel` | `.open` class toggled by fsFurnitureMenu() |

## CSS Quick Reference
| Class | Purpose |
|-------|---------|
| `.sk-btn` | Base toolbar button |
| `.sk-tpl-btn` | Green template button |
| `.sk-undo-btn` | Amber/gold — undo button |
| `.sk-btn-holding` | Red flash — while holding for clear |
| `.sk-section-btn` | Door/drawer count control |
| `.sk-del-btn` | Red delete button |
| `.sk-furniture-wrap/.sk-furniture-panel/.sk-furn-item` | Dropdown system |

## Version History
| Version | Changes |
|---------|---------|
| v43 | Toolbar cleanup, L-corner wardrobe premade |
| v44 | Remove Snap/Straighten toggle, improved line snapping (SNAP_R=36) |
| v45 | 5-drawer chest, desk with 2 drawers |
| v46 | Bedside table, Furniture dropdown, undo/clear highlight, measure auto-select |
| v47 | Combined Undo/Clear button (tap=undo, hold=clear), CLAUDE.md |
| v48 | "Depth" label renamed to "Deep" on button and placed canvas text |

## Layout Rules
- **Measurement buttons** (↔ Width, ↕ Height, ⬛ Deep) must always stay grouped together — they are primary buttons used on every job
