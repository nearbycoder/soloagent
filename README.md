# SoloAgent

SoloAgent is a desktop app (Electron + React + TypeScript) for running terminal-first coding workflows with per-project workspaces, per-space chat context, and live git visibility.

This README describes what the project currently is and how it is wired today.

## Previews

![SoloAgent Preview 1](./previews/1.png)
![SoloAgent Preview 2](./previews/2.png)
![SoloAgent Preview 3](./previews/3.png)

## Current Product State

The app currently centers around one dashboard experience with three primary zones:

- Left panel: project picker and per-project spaces.
- Center panel:
  - Top: AI chat area (TanStack AI client, Codex-backed completion, streaming UI, tool-call traces).
  - Bottom: terminal workspace (Ghostty Web renderer + node-pty backend), with tabs and splits.
- Right panel: git diff summary and expandable real file patches rendered with `@pierre/diffs`.

## Recent Updates

- Product name and docs standardized to **SoloAgent**.
- Chat activity now drives the green project/space indicators (active while AI response streams).
- Chat rendering now uses virtualization for large histories to keep the UI responsive with thousands of messages.
- Tool calls are persisted in-chat with a compact summary and collapsible details.
- Model picker uses a curated Codex-focused model set with searchable selection.

## Current Features

- Projects
  - Add/select/remove local projects by root path.
  - Persists selected project.
- Spaces
  - Each project can have multiple spaces.
  - Spaces are independently named and can be deleted.
  - Terminal tabs are scoped to spaces.
  - Space/project activity indicators are shown when chat streaming is active for that scope.
- Terminals
  - PTY-backed shell sessions via `node-pty`.
  - Ghostty Web terminal rendering.
  - Tab creation, split panes, rename, close, focus transitions.
  - Terminal layouts are persisted and restored per project scope.
- Chat
  - Curated model selection with searchable dropdown.
  - Streaming assistant response UI.
  - Tool-call visibility inside the conversation stream with collapsed detail blocks.
  - Chat history is scoped by project + space and persisted in SQLite.
  - Virtualized message list for large histories.
- Git Diff
  - Branch/ahead/behind summary.
  - File-level add/delete totals and status.
  - Expandable real unified patch rendering using `@pierre/diffs/react`.
- Window/UX
  - Custom window chrome and theme toggle.
  - Collapsible left, right, and terminal panels.

## Tech Stack

- Desktop shell: Electron 39
- UI: React 19 + Tailwind CSS 4
- Build toolchain: electron-vite + TypeScript 5
- Terminal: `ghostty-web` + `node-pty`
- Chat UI/runtime: `@tanstack/ai`, `@tanstack/ai-react`, `@tanstack/ai-openai`
- Diff rendering: `@pierre/diffs`
- Persistence: SQLite (`node:sqlite`)
- State management: Zustand

## Architecture Overview

- `src/main`
  - Electron main process.
  - PTY lifecycle, project/config services, git diff collection.
  - Chat execution bridge to `codex exec` and chat history persistence.
- `src/preload`
  - Typed IPC bridge exposed as `window.api`.
- `src/renderer`
  - React UI (`DashboardLayout`) and feature components (chat, terminal, panels).
- `src/shared`
  - Shared IPC channels and TypeScript types used by main/preload/renderer.

## Persistence

- SQLite DB file: `${app.getPath('userData')}/soloagent.db`
- Current tables include:
  - `projects`
  - `app_settings`
  - `agent_profiles`
  - `chat_history_messages`
  - migration metadata and legacy tables
- Renderer UI state (for fast UX state) also uses localStorage for some layout/space preferences.

## Requirements

- Node.js 22+ (this project uses `node:sqlite`).
- npm (scripts are defined with npm).
- Git installed (for git diff panel).
- `codex` CLI installed and authenticated (for chat completions/tool calls).

## Getting Started

Install dependencies:

```bash
npm install
```

Run in development:

```bash
npm run dev
```

Typecheck:

```bash
npm run typecheck
```

Run tests:

```bash
npm run test
```

Run test coverage:

```bash
npm run test:coverage
```

Lint:

```bash
npm run lint
```

Build:

```bash
npm run build
```

Platform packaging:

```bash
npm run build:mac
npm run build:win
npm run build:linux
```

## Notes

- This is an actively iterated codebase and the UI/flows are evolving quickly.
- Agent profile/task infrastructure exists in the backend; current UX is primarily project/space + chat + terminal driven.
- The test suite includes chat render performance guards for large message counts.
