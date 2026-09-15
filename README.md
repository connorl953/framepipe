<p align="center">
  <h1 align="center">FramePipe</h1>
  <p align="center">Video editing for AI agents. Not another AI video editor&mdash;a video editor that AI agents actually know how to use.</p>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> •
  <a href="#why-this-exists">Why This Exists</a> •
  <a href="#tools">Tools</a> •
  <a href="#presets">Presets</a> •
  <a href="#examples">Examples</a> •
  <a href="#architecture">Architecture</a>
</p>

---

FramePipe is an [MCP](https://modelcontextprotocol.io) server that wraps FFmpeg into 17 structured, LLM-friendly tools. Every input is typed JSON. Every output is a structured response with success/error states, semantic error codes, recovery suggestions, and cost estimates. No log parsing. No guessing.

## Quickstart

> **Not published to npm.** FramePipe runs from source. There is no `framepipe` package on
> the registry — install it by cloning and building.

**Requirements:** Node.js 18+ and [FFmpeg](https://ffmpeg.org) 4.4+ installed on your system.

```bash
git clone https://github.com/connorl953/framepipe.git
cd framepipe
npm install
npm run build
```

Then point your MCP client at the built server by absolute path.

**Claude Desktop** (`~/.config/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "framepipe": {
      "command": "node",
      "args": ["/absolute/path/to/framepipe/dist/server.js"]
    }
  }
}
```

**Claude Code** (`.mcp.json` in project root):
```json
{
  "mcpServers": {
    "framepipe": {
      "command": "node",
      "args": ["/absolute/path/to/framepipe/dist/server.js"]
    }
  }
}
```

**Cursor / Windsurf / any MCP client:** same shape — `command: "node"`, with the absolute
path to `dist/server.js` as the single argument.

Your agent then has 17 video editing tools.

## Why This Exists

LLMs get asked to edit video all the time. The current experience is terrible:

1. Construct raw FFmpeg commands from memory
2. Get flag order or filter graph syntax wrong
3. FFmpeg dumps 200 lines of logs to stderr
4. Parse the logs, guess at what failed, retry
5. Three attempts later, maybe a working file—but no idea if the output is correct

FramePipe replaces that with structured tool calls. The agent calls `trim` with `{start: "00:01:30", end: "00:03:00"}` and gets back JSON confirming the output duration, file size, codec, and cost estimate. If something goes wrong, it gets a semantic error code like `END_TIME_OUT_OF_RANGE` with a suggestion like `"End time exceeds video duration (00:05:02)"` instead of a wall of FFmpeg stderr.

**The key insight:** the LLM is the user, not the human. The human just says "clip the highlight reel." The LLM needs to figure out how to do that—and it needs tools designed for how LLMs actually work.

## Tools

### Introspection

| Tool | What it does |
|------|-------------|
| `inspect_video` | Duration, resolution, FPS, codecs, audio tracks, file size, bitrate. Run this first. |
| `detect_silence` | Find silent segments with timestamps. Natural cut points for automated editing. |
| `get_thumbnail` | Extract a single frame as PNG. Preview what you're working with. |
| `sample_frames` | Extract N evenly-spaced frames. Let a multimodal model "scan" an entire video. |

### Editing

| Tool | What it does |
|------|-------------|
| `trim` | Cut to a time range. Fast stream copy when possible. |
| `concatenate` | Join clips in order. |
| `adjust_speed` | 0.25x slow motion to 4x fast forward. |
| `add_text` | Text overlay with position, timing, font size, color. 9 position presets. |

### Audio

| Tool | What it does |
|------|-------------|
| `add_audio` | Mix in music/voiceover, or replace existing audio entirely. Volume control. |
| `remove_audio` | Strip all audio tracks. |

### Analysis

| Tool | What it does |
|------|-------------|
| `extract_subtitles` | Pull embedded captions with timestamps. Suggests speech-to-text if none found. |
| `generate_waveform` | Audio visualization as PNG. |

### Export

| Tool | What it does |
|------|-------------|
| `export_video` | Transcode with format/resolution/quality, or use a social media preset. |

### Project Management

| Tool | What it does |
|------|-------------|
| `create_project` | Start an editing session. Persisted to disk. |
| `get_project` | Check project state, assets, metadata. |
| `project_add_asset` | Import a file into a project. |
| `project_history` | Full operation log for a project. |

## Presets

Export with a single word instead of remembering codec settings:

| Preset | Resolution | Aspect | Use case |
|--------|-----------|--------|----------|
| `youtube` | 1920x1080 | 16:9 | Standard YouTube upload |
| `instagram_reel` | 1080x1920 | 9:16 | Instagram Reels / Stories |
| `tiktok` | 1080x1920 | 9:16 | TikTok (mobile-optimized bitrate) |
| `twitter` | 1280x720 | 16:9 | X/Twitter posts |
| `linkedin` | 1200x675 | 16:9 | LinkedIn feed video |
| `podcast_clip` | 1280x720 | 16:9 | Audio-focused, lower video bitrate |

## Examples

### Trim a conference recording to the keynote

```
Agent calls: inspect_video → trim → export_video

1. inspect_video(file_path: "recording.mp4")
   → 2:34:17, 1920x1080, h264, 2 audio tracks

2. trim(file_path: "recording.mp4", start: "00:12:30", end: "01:05:00")
   → {success: true, cost: {estimatedUSD: 0.001, basis: "copy tier"}}

3. export_video(file_path: "recording_trim.mp4", preset: "youtube")
   → 1920x1080, h264, optimized for YouTube
```

### Turn a horizontal video into an Instagram Reel

```
1. inspect_video(file_path: "landscape.mp4")
   → 1920x1080, 16:9

2. add_text(file_path: "landscape.mp4", text: "Check this out", position: "topcenter", ...)
   → Text overlay applied

3. export_video(file_path: "landscape_text.mp4", preset: "instagram_reel")
   → 1080x1920, 9:16, ready for Instagram
```

### Find and remove dead air from a podcast recording

```
1. detect_silence(file_path: "podcast.mp4", threshold_db: -35, min_duration_seconds: 2.0)
   → [{start: 45.2, end: 52.1}, {start: 128.0, end: 135.5}, ...]

2. trim(file_path: "podcast.mp4", start: "00:00:00", end: "00:00:45")
   → First segment before silence

3. trim(file_path: "podcast.mp4", start: "00:00:52", end: "00:02:08")
   → Second segment after first silence gap

4. concatenate(file_paths: ["seg1.mp4", "seg2.mp4", ...])
   → Joined without dead air
```

## Response Format

Every tool returns the same structure. Success:

```json
{
  "success": true,
  "operation": "trim",
  "output": { "outputPath": "/path/to/trimmed.mp4" },
  "cost": {
    "estimatedRenderSeconds": 1,
    "estimatedUSD": 0.0008,
    "basis": "cloud-equivalent at $0.002/sec (copy tier). Local renders are free."
  },
  "warnings": []
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "END_TIME_OUT_OF_RANGE",
    "message": "End time 00:99:00 is beyond video duration (00:00:05.000)",
    "suggestion": "Use inspect_video first to check the duration."
  }
}
```

Error codes are semantic (`END_TIME_OUT_OF_RANGE`, `NO_SUBTITLES`, `INVALID_PRESET`, `INSPECT_FAILED`) so the agent can branch on them programmatically instead of parsing error strings. There are 24 of them.

## Architecture

```
┌─────────────────────────┐
│   MCP Client            │  Claude Desktop, Claude Code, Cursor, etc.
│   (the LLM)             │
└────────┬────────────────┘
         │ JSON-RPC over stdio
┌────────▼────────────────┐
│   server.ts             │  MCP server — 17 tool registrations
│   Routes + validation   │  Zod schemas, snake_case → camelCase mapping
└────────┬────────────────┘
         │
┌────────▼────────────────┐
│   ffmpeg.ts             │  VideoEngine class — FFmpeg abstraction
│   ~1100 lines           │  execFile (no shell injection), structured output
└────────┬────────────────┘
         │
┌────────▼────────────────┐
│   ffmpeg / ffprobe      │  System binaries
└─────────────────────────┘

┌─────────────────────────┐
│   projects.ts           │  ProjectManager — file-backed persistence
│   JSON on disk          │  Assets, history, metadata
└─────────────────────────┘
```

Key design decisions:

- **`execFile` not `exec`** — avoids shell injection when handling user-controlled file paths
- **Every method returns `OperationResult<T>`** — uniform success/error/cost/suggestions shape
- **Cost estimates use tiered pricing** — copy (stream copy), simple (standard encode), complex (filters), 4K. Based on cloud GPU benchmarks ($0.002/sec base). Local renders are free; costs are for cloud-equivalent reasoning.
- **Projects persist to disk** — each project gets a directory with `project.json` and an `assets/` folder. Survives server restarts.
- **Position normalization** — `topcenter`, `top_center`, and `top-center` all resolve correctly

## Development

```bash
git clone https://github.com/connorl953/framepipe.git
cd framepipe
npm install
npm run build
npm test                              # 13 unit tests
npx tsx src/mcp-integration-test.ts   # 16 MCP protocol tests
```

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
