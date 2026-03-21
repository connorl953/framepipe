# Agentic Video Editor — Design Document

## What I (an LLM) Actually Need

I'm designing this from first principles as the target user. Here's what I struggle with today when a human asks me to do something with video:

### My Pain Points

1. **I can't see video.** I have no way to know what's in a video file without processing it. I need metadata, scene descriptions, transcripts — structured text I can reason about.

2. **FFmpeg is hostile to me.** I frequently hallucinate flags, get codec combinations wrong, and produce broken commands. I need a semantic layer that maps intent to correct operations.

3. **I don't know if I succeeded.** After running an FFmpeg command, I get a wall of log output. I need structured confirmation: did it work, what's the output file, what changed.

4. **I can't preview.** I can't look at a thumbnail. But I CAN reason about metadata — resolution, duration, file size, frame timestamps. Give me those.

5. **I don't know what things cost.** If I'm operating on a user's behalf with a budget, I need cost estimates before committing to expensive renders.

6. **I forget context across operations.** I need a project/session concept that tracks the state of what I'm working on.

---

## Tool Design Principles

1. **Every tool returns structured JSON, never raw logs.**
2. **Every destructive operation has a dry_run mode with cost estimate.**
3. **Video introspection is first-class — I need to "understand" video through text.**
4. **Errors are semantic, not stack traces.** "Audio codec incompatible with container" not "exit code 1".
5. **Operations are composable.** I can chain trim → overlay → export in a pipeline.
6. **Sensible defaults everywhere.** I shouldn't need to specify codecs unless I want to.

---

## MCP Tool Inventory

### Introspection (Read-only, no render cost)

| Tool | Purpose | Why I need it |
|------|---------|---------------|
| `inspect_video` | Get full metadata (duration, resolution, fps, codecs, audio tracks, file size) | First thing I do with any video — understand what I'm working with |
| `detect_scenes` | Get timestamp boundaries where scenes change | So I can reason about video structure without seeing it |
| `detect_silence` | Find silent segments with timestamps | For trimming dead air, finding natural cut points |
| `extract_transcript` | Speech-to-text with word-level timestamps | So I can find content by what people say, not by timecodes |
| `get_thumbnail` | Get a thumbnail image at a specific timestamp (returned as base64 or URL) | Limited usefulness for me, but helpful for multimodal models or human review |
| `sample_frames` | Get N evenly-spaced frame thumbnails across the video | For multimodal models to "scan" a video |

### Core Editing

| Tool | Purpose | Key params |
|------|---------|------------|
| `trim` | Cut video to a time range | start, end (supports "00:01:30" or seconds) |
| `split` | Divide video at timestamps into multiple files | timestamps[] |
| `concatenate` | Join multiple clips in order | clips[], transition (optional) |
| `speed` | Change playback speed | factor (0.5 = half speed, 2.0 = double) |
| `reverse` | Reverse a clip | (no params beyond input) |
| `loop` | Loop a clip N times or to a target duration | count or target_duration |

### Overlays & Graphics

| Tool | Purpose | Key params |
|------|---------|------------|
| `add_text` | Overlay text at a position and time range | text, position, start, end, style{} |
| `add_lower_third` | Add a branded lower third bar | title, subtitle, start, end, style{} |
| `add_watermark` | Overlay an image (logo) | image_path, position, opacity |
| `add_subtitles` | Burn subtitles from SRT/VTT or auto-generated | source (file or "auto"), style{} |

### Audio

| Tool | Purpose | Key params |
|------|---------|------------|
| `add_audio` | Add audio track (music, voiceover) | audio_path, start, volume, mix_mode |
| `replace_audio` | Swap the audio track entirely | audio_path |
| `remove_audio` | Strip audio from video | (no extra params) |
| `adjust_volume` | Change volume levels | level (dB or multiplier), track_index |
| `normalize_audio` | Normalize audio levels | target_loudness (LUFS) |

### Export & Delivery

| Tool | Purpose | Key params |
|------|---------|------------|
| `export` | Render final output | format, resolution, quality, preset ("youtube", "instagram_reel", "tiktok", etc.) |
| `estimate_cost` | Preview what an export will cost without doing it | (same params as export) |

### Project Management

| Tool | Purpose |
|------|---------|
| `create_project` | Start a new editing session, get a project_id |
| `get_project` | Get current state of a project (assets, timeline, pending operations) |
| `list_assets` | See all files in the project |
| `add_asset` | Import a file into the project |
| `undo` | Revert last operation |
| `get_history` | See all operations performed on this project |

---

## Response Format (Every Tool)

```json
{
  "success": true,
  "operation": "trim",
  "input": { "file": "interview.mp4", "start": "00:02:15", "end": "00:05:30" },
  "output": {
    "file": "interview_trimmed.mp4",
    "duration": "00:03:15",
    "resolution": "1920x1080",
    "file_size_mb": 42.3
  },
  "cost": {
    "render_seconds": 8.2,
    "estimated_usd": 0.006
  },
  "warnings": [],
  "suggestions": ["Consider normalizing audio — detected volume variance of 12dB"]
}
```

On error:
```json
{
  "success": false,
  "operation": "trim",
  "error": {
    "code": "INVALID_TIME_RANGE",
    "message": "End time (00:05:30) exceeds video duration (00:04:12)",
    "suggestion": "Use end: '00:04:12' to trim to the end of the video"
  }
}
```

---

## What Makes This Different From "FFmpeg With Extra Steps"

1. **Semantic errors with suggestions** — I don't get "exit code 1", I get actionable guidance
2. **Introspection-first** — I can reason about video content through structured data before editing
3. **Cost-aware** — every operation can be dry-run'd with cost estimates
4. **Social media presets** — "export for Instagram Reels" handles all the format/resolution/encoding details
5. **Project state** — operations are tracked and undoable, not fire-and-forget
6. **Composable pipelines** — I can describe a multi-step edit in one call
7. **The `suggestions` field** — the system proactively tells me about issues (volume problems, aspect ratio mismatches, etc.) because I can't see them myself
