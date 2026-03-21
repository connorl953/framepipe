import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VideoEngine } from "./ffmpeg.js";
import { ProjectManager } from "./projects.js";

const server = new McpServer({
  name: "framepipe",
  version: "0.1.0",
  description: "Video editing for AI agents. Use this when you need to inspect, edit, trim, overlay, export, or manipulate video files. 17 structured tools with semantic errors and cost estimates.",
});

const videoEngine = new VideoEngine();
const projectManager = new ProjectManager();

// Helper to format tool responses
function formatResponse(result: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

// ============ INTROSPECTION TOOLS ============

server.tool(
  "inspect_video",
  "Get full metadata for a video file: duration, resolution, FPS, codecs, audio tracks, file size, bitrate. Use this FIRST on any video to understand what you're working with.",
  { file_path: z.string().describe("Absolute path to the video file") },
  async ({ file_path }) => {
    const result = await videoEngine.inspect(file_path);
    return formatResponse(result);
  }
);

server.tool(
  "detect_silence",
  "Find silent segments in a video with timestamps. Useful for finding natural cut points, trimming dead air, or identifying pauses.",
  {
    file_path: z.string().describe("Absolute path to the video file"),
    threshold_db: z.number().optional().describe("Silence threshold in dB (default: -40)"),
    min_duration_seconds: z.number().optional().describe("Minimum silence duration in seconds (default: 0.5)"),
  },
  async ({ file_path, threshold_db, min_duration_seconds }) => {
    const result = await videoEngine.detectSilence(file_path, {
      threshold: threshold_db,
      minDuration: min_duration_seconds,
    });
    return formatResponse(result);
  }
);

server.tool(
  "get_thumbnail",
  "Extract a single frame from a video as a PNG image. Use this when you need a preview image, a cover frame, or want to check what the video looks like at a specific moment. Returns the saved file path.",
  {
    file_path: z.string().describe("Absolute path to the video file"),
    timestamp: z.string().optional().describe("Timestamp to capture (HH:MM:SS or seconds, default: 00:00:01)"),
    output_path: z.string().optional().describe("Where to save the thumbnail"),
  },
  async ({ file_path, timestamp, output_path }) => {
    const result = await videoEngine.getThumbnail(file_path, { timestamp, outputPath: output_path });
    return formatResponse(result);
  }
);

// ============ EDITING TOOLS ============

server.tool(
  "trim",
  "Cut a video to a specific time range. Use this when you need to extract a clip, remove an intro/outro, or isolate a segment. Supports HH:MM:SS format or raw seconds. Returns the output path and cost estimate.",
  {
    file_path: z.string().describe("Absolute path to the video file"),
    start: z.string().describe("Start time (HH:MM:SS or seconds)"),
    end: z.string().optional().describe("End time (HH:MM:SS or seconds). Omit to trim to end of video."),
    output_path: z.string().optional().describe("Output file path"),
  },
  async ({ file_path, start, end, output_path }) => {
    const result = await videoEngine.trim(file_path, { start, end, outputPath: output_path });
    return formatResponse(result);
  }
);

server.tool(
  "concatenate",
  "Join multiple video clips into one file, in order. Use this when you need to combine separate clips into a single video, build a compilation, or merge segments after trimming. Returns the output path.",
  {
    file_paths: z.array(z.string()).describe("Ordered list of video file paths to join"),
    output_path: z.string().optional().describe("Output file path"),
    transition: z.string().optional().describe("Transition type between clips (none supported yet)"),
  },
  async ({ file_paths, output_path, transition }) => {
    const result = await videoEngine.concatenate(file_paths, { outputPath: output_path, transition });
    return formatResponse(result);
  }
);

server.tool(
  "adjust_speed",
  "Change playback speed of a video. Factor 0.5 = half speed, 2.0 = double speed.",
  {
    file_path: z.string().describe("Absolute path to the video file"),
    factor: z.number().describe("Speed factor (0.25-4.0). 0.5 = slow motion, 2.0 = fast forward."),
    output_path: z.string().optional().describe("Output file path"),
  },
  async ({ file_path, factor, output_path }) => {
    const result = await videoEngine.adjustSpeed(file_path, { factor, outputPath: output_path });
    return formatResponse(result);
  }
);

server.tool(
  "add_text",
  "Overlay text on a video at a specified position and time range.",
  {
    file_path: z.string().describe("Absolute path to the video file"),
    text: z.string().describe("Text content to overlay"),
    position: z.string().optional().describe("Position: topleft, topcenter, topright, centerleft, center, centerright, bottomleft, bottomcenter, bottomright (default: bottomcenter)"),
    start: z.string().optional().describe("When text appears (HH:MM:SS or seconds)"),
    end: z.string().optional().describe("When text disappears (HH:MM:SS or seconds)"),
    font_size: z.number().optional().describe("Font size in pixels (default: 24)"),
    color: z.string().optional().describe("Text color (default: white)"),
    output_path: z.string().optional().describe("Output file path"),
  },
  async ({ file_path, text, position, start, end, font_size, color, output_path }) => {
    const result = await videoEngine.addText(file_path, {
      text, position, start, end,
      fontSize: font_size, color, outputPath: output_path,
    });
    return formatResponse(result);
  }
);

// ============ AUDIO TOOLS ============

server.tool(
  "add_audio",
  "Add an audio track to a video. Use this when you need to add background music, a voiceover, or sound effects. Supports mixing with existing audio or replacing it entirely. Returns the output path.",
  {
    file_path: z.string().describe("Absolute path to the video file"),
    audio_path: z.string().describe("Absolute path to the audio file"),
    start: z.string().optional().describe("When audio starts in the video (HH:MM:SS or seconds)"),
    volume: z.number().optional().describe("Audio volume multiplier (0.0-2.0, default: 1.0)"),
    mix_mode: z.enum(["mix", "replace"]).optional().describe("'mix' blends with existing audio, 'replace' swaps it (default: mix)"),
    output_path: z.string().optional().describe("Output file path"),
  },
  async ({ file_path, audio_path, start, volume, mix_mode, output_path }) => {
    const result = await videoEngine.addAudio(file_path, {
      audioPath: audio_path, start, volume,
      mixMode: mix_mode, outputPath: output_path,
    });
    return formatResponse(result);
  }
);

server.tool(
  "remove_audio",
  "Strip all audio from a video, producing a silent video file. Use this when you need to remove unwanted audio before adding a new track, or when creating a visual-only clip. Returns the output path.",
  {
    file_path: z.string().describe("Absolute path to the video file"),
    output_path: z.string().optional().describe("Output file path"),
  },
  async ({ file_path, output_path }) => {
    const result = await videoEngine.removeAudio(file_path, { outputPath: output_path });
    return formatResponse(result);
  }
);

// ============ ANALYSIS TOOLS ============

server.tool(
  "extract_subtitles",
  "Extract embedded subtitles/captions from a video file. Returns structured text with timestamps. If no subtitles exist, suggests using external speech-to-text.",
  {
    file_path: z.string().describe("Absolute path to the video file"),
    stream_index: z.number().optional().describe("Subtitle stream index if multiple exist (default: 0)"),
    output_path: z.string().optional().describe("Where to save the SRT file"),
  },
  async ({ file_path, stream_index, output_path }) => {
    const result = await videoEngine.extractSubtitles(file_path, {
      streamIndex: stream_index, outputPath: output_path,
    });
    return formatResponse(result);
  }
);

server.tool(
  "generate_waveform",
  "Generate a visual waveform image (PNG) of the video's audio track. Useful for understanding audio structure, identifying loud/quiet sections, and finding edit points.",
  {
    file_path: z.string().describe("Absolute path to the video file"),
    output_path: z.string().optional().describe("Where to save the waveform PNG"),
    width: z.number().optional().describe("Image width in pixels (default: 1920)"),
    height: z.number().optional().describe("Image height in pixels (default: 200)"),
  },
  async ({ file_path, output_path, width, height }) => {
    const result = await videoEngine.generateWaveform(file_path, { outputPath: output_path, width, height });
    return formatResponse(result);
  }
);

server.tool(
  "sample_frames",
  "Extract N evenly-spaced frame thumbnails from a video. Returns file paths to each frame image. Essential for multimodal models to 'scan' a video visually.",
  {
    file_path: z.string().describe("Absolute path to the video file"),
    count: z.number().optional().describe("Number of frames to extract (default: 10)"),
    output_dir: z.string().optional().describe("Directory to save frame images"),
  },
  async ({ file_path, count, output_dir }) => {
    const result = await videoEngine.sampleFrames(file_path, { count, outputDir: output_dir });
    return formatResponse(result);
  }
);

// ============ EXPORT TOOLS ============

server.tool(
  "export_video",
  "Export/transcode a video with format, resolution, and quality settings. Supports social media presets: youtube, instagram_reel, tiktok, twitter, linkedin, podcast_clip.",
  {
    file_path: z.string().describe("Absolute path to the video file"),
    format: z.string().optional().describe("Output container format: mp4, webm, mov, avi, mkv (default: mp4)"),
    resolution: z.string().optional().describe("Target resolution: e.g. 1920x1080, 1280x720"),
    quality: z.string().optional().describe("Quality level: high, medium, low"),
    preset: z.string().optional().describe("Social media preset: youtube, instagram_reel, tiktok, twitter, linkedin, podcast_clip"),
    output_path: z.string().optional().describe("Output file path"),
  },
  async ({ file_path, format, resolution, quality, preset, output_path }) => {
    const result = await videoEngine.exportVideo(file_path, {
      format, resolution, quality, preset, outputPath: output_path,
    });
    return formatResponse(result);
  }
);

// ============ PROJECT MANAGEMENT TOOLS ============

server.tool(
  "create_project",
  "Create a new video editing project to organize assets and track operation history. Use this when starting a multi-step editing workflow to keep assets organized. Returns a project ID for subsequent operations.",
  {
    name: z.string().describe("Project name"),
    description: z.string().optional().describe("What this project is for"),
  },
  async ({ name, description }) => {
    const project = projectManager.createProject(name, description);
    return formatResponse({ success: true, project });
  }
);

server.tool(
  "get_project",
  "Get the current state of a project including its assets and metadata. Use this to check what files are in a project before performing operations. Returns project details and asset list.",
  { project_id: z.string().describe("Project ID") },
  async ({ project_id }) => {
    const project = projectManager.getProject(project_id);
    if (!project) return formatResponse({ success: false, error: { code: "PROJECT_NOT_FOUND", message: `No project with ID '${project_id}'`, suggestion: "Use create_project to start a new project, or check the ID." } });
    return formatResponse({ success: true, project });
  }
);

server.tool(
  "project_add_asset",
  "Import a media file into a project for tracking. Use this after create_project to register files you'll be working with. Returns updated project state.",
  {
    project_id: z.string().describe("Project ID"),
    file_path: z.string().describe("Absolute path to the file to import"),
  },
  async ({ project_id, file_path }) => {
    projectManager.addAsset(project_id, file_path);
    const project = projectManager.getProject(project_id);
    return formatResponse({ success: true, project });
  }
);

server.tool(
  "project_history",
  "Get the full operation history for a project — every edit, export, and inspection performed. Use this to review what's been done or to understand the editing timeline. Returns chronological operation list.",
  { project_id: z.string().describe("Project ID") },
  async ({ project_id }) => {
    const history = projectManager.getHistory(project_id);
    return formatResponse({ success: true, project_id, history });
  }
);

// ============ SERVER STARTUP ============

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
