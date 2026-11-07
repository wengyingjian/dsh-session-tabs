# Lightweight Session Tabs (personal fork) / dsh-session-tabs

A single-client DSH tab strip that reuses the native conversation and task services. Both sidebars and the bottom workbench stay native; no iframe and no runtime dependencies. This repository is a fork of upstream **0.1.6** with a denser two-row strip, workspace labels, attention pinning and guarded bulk close.

[中文](README.md) · MIT · based on upstream v0.1.6

[![verify](https://github.com/wengyingjian/dsh-session-tabs/actions/workflows/verify.yml/badge.svg)](https://github.com/wengyingjian/dsh-session-tabs/actions/workflows/verify.yml)

## Origin and license

- **Forked from**: [DEVbyQIN/dsh-session-tabs](https://github.com/DEVbyQIN/dsh-session-tabs) (original author **QIN-SMART**; the old `QIN-SMART/dsh-session-tabs` URL redirects there)
- **Base**: upstream `v0.1.6` (commit `aa4cb30`); this fork is versioned **0.2.0**
- **License**: MIT, copyright the upstream author (see [LICENSE](LICENSE)). Changes in this fork are released under the same MIT license with the original attribution kept.
- **Note**: this fork is **not published to npm**. `dsh-session-tabs` on npm is the upstream release and does not include the features below.

## Features

### Tab strip

- **Two-row labels**: a 10px tertiary line on top with the session's **workspace** (workspace title, falling back to the path's last segment; the line is hidden when the session has no workspace), a 13px session title below; both left-aligned and ellipsized.
- **Compact**: 46px strip, 40px tabs, 60–168px tab width, 108px label column, 13px title.
- The active tab shares the content surface and joins it with reverse corners; other tabs sit on a darker strip. Light and dark themes follow DSH.
- `＋` follows the tabs and uses native session creation. The right end of the row holds proxies for the bottom workbench and the right sidebar, reusing the native icons, state and click handlers.
- The line icon at the bottom of the left sidebar toggles between tab view and the native single-conversation view.

### Status and pinning

- Status marks are **solid circles**: running blue, needs attention yellow, completed unread green, connecting grey; idle shows nothing.
- Running / needs-attention / completed-unread tabs **pin to the far left** in the order **needs attention > completed unread > running**, keeping their original order inside one state.
- The pinned area **does not scroll** with the normal tabs; it takes at most half of the strip and scrolls internally when it overflows.
- A status change unpins immediately and returns the tab to its stored position.
- Right-click **Pin / Unpin** pins a tab manually: persisted, drag-sortable inside the manual pin group, and an idle pinned tab shows a pin glyph in the status slot.

### Closing

- `×` closes the tab only: it never deletes, archives or stops a session; running or waiting sessions stay retained in the background until idle.
- Every tab **reserves 20px for the close button**, hovering or focusing only toggles its visibility, so tab widths never jump.
- Right-click **Close others / Close to the left / Close to the right** **skips** running, needs-attention, completed-unread and manually pinned tabs; items grey out when nothing can be closed; bulk close never cancels background work.
- `⌘/Ctrl + Shift + T` while the strip has focus reopens recently closed tabs (up to 20), in close order.

### Interaction

- Click a tab to switch; label text is not selectable, so clicks cannot start a text selection.
- **Drag**: the drag starts only after 12px of horizontal movement, so clicks are never mistaken for drags; the dragged tab lifts, the cursor changes to grabbing, and tabs reorder live inside their own group.
- **Cross-group drags are rejected** (not-allowed cursor, no movement, releasing changes nothing), because group order is driven by status or manual pinning.
- Pointer release, window blur and hidden-page events all end a drag, so it can never get stuck.
- With a tab focused, ←/→ switches tabs and `Alt + Shift + ←/→` reorders inside the group; `Shift+F10` or the menu key opens the context menu.
- Tab order, manual pins and the enabled preference live in `localStorage['dsh-session-tabs.v1']` and survive reloads.

## Differences from upstream 0.1.6

| | Upstream 0.1.6 | This fork |
| --- | --- | --- |
| Label rows | single title row | workspace line + title |
| Size | 47/48px strip, 14px font, 78–210px tabs | 46px strip, 13px font, 60–168px tabs |
| Status marks | `●` `!` `✓` `…` glyphs | solid circles (blue/yellow/green/grey) |
| Pinning | none | automatic status pinning + manual pin, fixed zone |
| Bulk close | closes everything | skips running/attention/unread/pinned tabs |
| Close button | always on or on-hover (changes width) | 20px reserved, visibility-only on hover |
| Dragging | native HTML5 drag (fires after a few pixels, eats clicks) | pointer drag, 12px threshold, live reorder |
| Context menu | close others/left/right | pin/unpin + the three close actions, disabled per guard rules |

## Install

This fork is not on npm.

**Local clone (recommended for development)**

```sh
git clone https://github.com/wengyingjian/dsh-session-tabs.git
cd dsh-session-tabs
dsh plugin --profile desktop add link:$PWD
```

Restart DSH afterwards. Editing `lib/client.js` then only needs a page refresh (the desktop window does not hot-reload plugin code).

**Straight from GitHub**

```sh
dsh plugin --profile desktop add github:wengyingjian/dsh-session-tabs
```

**Upstream npm release** (without the features above): add `dsh-session-tabs` in the plugin manager, or `dsh plugin --profile desktop add dsh-session-tabs@0.1.6`.

**Revert / remove**: the sidebar icon switches back to the native view; removing the plugin in the plugin manager and refreshing cleans up injected nodes, styles, subscriptions and session references. The browser-side tab list can be cleared via the `dsh-session-tabs.v1` site key.

## Compatibility

- Upstream 0.1.6 was validated against **DSH 0.2.0-rc.2**.
- This fork was checked on **DSH 0.2.2-rc.1 (macOS desktop)**: 62 unit tests plus a real-UI smoke check (strip height, workspace row, pinned zone, context menu, drag and click).
- The client API is still evolving: re-run the acceptance checks after a host upgrade. The strip mounts on the stable `data-slot="main"`; host layout changes are the main compatibility risk.
- Known third-party behaviour: in the DS Bot view an empty "New session" is pulled back to Main Bot by ds-bot's sentinel, unrelated to this plugin.
- Upstream acceptance history for 0.1.6 and earlier stays in [docs/validation.md](docs/validation.md).

## Development and acceptance

```sh
node --test test/verify.mjs                        # unit tests, no dependencies
node tools/real-ui-check.mjs --url http://127.0.0.1:<port> --global __dshSessionTabs
```

`test/verify.mjs` loads the real bundle in a mock DOM; `tools/real-ui-check.mjs` drives a real WebUI over CDP and captures a screenshot (`--url` should point at the running DSH). `tools/start-test-profile.mjs` starts an isolated profile and needs a locally installed `@deepseek-ai/dsh` package path.

| Path | Purpose |
| --- | --- |
| `lib/client.js` | all browser-side behaviour (strip, pinning, context menu, dragging) |
| `index.mjs` | host half, intentionally lazy |
| `cordis.patch.yml` | registers the package as one enabled loader entry |
| `test/` | mock-DOM regression tests |
| `tools/` | real-UI smoke check and isolated profile launcher |

## License

[MIT](LICENSE), copyright (c) 2026 QIN-SMART (upstream author); changes in this fork are released under the same MIT license.
