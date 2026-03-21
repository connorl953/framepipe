import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { dirname, basename, join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ============================================================================
// Types and Interfaces
// ============================================================================

interface OperationResult<T = unknown> {
  success: boolean;
  operation: string;
  input: Record<string, unknown>;
  output?: T;
  cost?: {
    estimatedRenderSeconds: number;
    estimatedUSD: number;
    basis: string;
  };
  warnings?: string[];
  suggestions?: string[];
  error?: {
    code: string;
    message: string;
    suggestion: string;
  };
}

interface VideoMetadata {
  duration: number;
  resolution: {
    width: number;
    height: number;
  };
  fps: number;
  videoCodec: string;
  audioTracks: Array<{
    index: number;
    codec: string;
    sampleRate: number;
    channels: number;
  }>;
  fileSize: number;
  bitrate: number;
}

interface SilentSegment {
  start: number;
  end: number;
  duration: number;
}

interface ExportPreset {
  resolution: string;
  aspectRatio: string;
  videoCodec: string;
  audioCodec: string;
  bitrate: string;
  audioRate: string;
  container: string;
  customArgs: string[];
}

interface TrimOptions {
  start: string;
  end?: string;
  outputPath?: string;
}

interface DetectSilenceOptions {
  threshold?: number;
  minDuration?: number;
}

interface ConcatenateOptions {
  outputPath?: string;
  transition?: string;
}

interface AddTextOptions {
  text: string;
  position?: string;
  start?: string;
  end?: string;
  fontSize?: number;
  color?: string;
  outputPath?: string;
}

interface AddAudioOptions {
  audioPath: string;
  start?: string;
  volume?: number;
  mixMode?: 'mix' | 'replace';
  outputPath?: string;
}

interface RemoveAudioOptions {
  outputPath?: string;
}

interface AdjustSpeedOptions {
  factor: number;
  outputPath?: string;
}

interface ExportVideoOptions {
  format?: string;
  resolution?: string;
  quality?: string;
  preset?: string;
  outputPath?: string;
}

interface GetThumbnailOptions {
  timestamp?: string;
  outputPath?: string;
}

// ============================================================================
// Presets Configuration
// ============================================================================

const PRESETS: Record<string, ExportPreset> = {
  youtube: {
    resolution: '1920x1080',
    aspectRatio: '16:9',
    videoCodec: 'libx264',
    audioCodec: 'aac',
    bitrate: '8000k',
    audioRate: '48k',
    container: 'mp4',
    customArgs: ['-preset', 'slow', '-crf', '18'],
  },
  instagram_reel: {
    resolution: '1080x1920',
    aspectRatio: '9:16',
    videoCodec: 'libx264',
    audioCodec: 'aac',
    bitrate: '6000k',
    audioRate: '44.1k',
    container: 'mp4',
    customArgs: ['-preset', 'medium', '-crf', '23'],
  },
  tiktok: {
    resolution: '1080x1920',
    aspectRatio: '9:16',
    videoCodec: 'libx264',
    audioCodec: 'aac',
    bitrate: '5000k',
    audioRate: '44.1k',
    container: 'mp4',
    customArgs: ['-preset', 'fast', '-crf', '28'],
  },
  twitter: {
    resolution: '1280x720',
    aspectRatio: '16:9',
    videoCodec: 'libx264',
    audioCodec: 'aac',
    bitrate: '5000k',
    audioRate: '48k',
    container: 'mp4',
    customArgs: ['-preset', 'fast', '-crf', '23'],
  },
  linkedin: {
    resolution: '1920x1080',
    aspectRatio: '16:9',
    videoCodec: 'libx264',
    audioCodec: 'aac',
    bitrate: '6000k',
    audioRate: '48k',
    container: 'mp4',
    customArgs: ['-preset', 'medium', '-crf', '23'],
  },
  podcast_clip: {
    resolution: '1080x1080',
    aspectRatio: '1:1',
    videoCodec: 'libx264',
    audioCodec: 'aac',
    bitrate: '4000k',
    audioRate: '48k',
    container: 'mp4',
    customArgs: ['-preset', 'fast', '-crf', '28'],
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse a fraction string like "30/1" or "30000/1001" to a float
 */
function parseFraction(frac: string): number {
  const parts = frac.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]!);
    const den = parseFloat(parts[1]!);
    return den !== 0 ? num / den : 0;
  }
  return parseFloat(frac) || 0;
}

/**
 * Parse timestamp string ("HH:MM:SS.ms" or "MM:SS" or raw seconds) to float seconds
 */
function parseTimestamp(ts: string): number {
  if (/^\d+$/.test(ts)) {
    return parseFloat(ts);
  }

  const parts = ts.split(':');
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts.map(parseFloat);
    return hours * 3600 + minutes * 60 + seconds;
  } else if (parts.length === 2) {
    const [minutes, seconds] = parts.map(parseFloat);
    return minutes * 60 + seconds;
  }

  return parseFloat(ts);
}

/**
 * Convert seconds to "HH:MM:SS.ms" format
 */
function formatTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');
  const ms = String((secs % 1).toFixed(3)).slice(2, 5);

  return `${pad(hours)}:${pad(minutes)}:${pad(secs).split('.')[0]}.${ms || '000'}`;
}

/**
 * Generate default output path based on operation name
 */
function getDefaultOutputPath(inputPath: string, operationName: string): string {
  const dir = dirname(inputPath);
  const name = basename(inputPath, '.mp4');
  return join(dir, `${name}_${operationName}.mp4`);
}

/**
 * Calculate cost estimate based on output duration.
 *
 * Pricing model: Based on cloud GPU render time benchmarks.
 * Local renders cost nothing (ffmpeg on CPU), but we report estimated
 * cloud-equivalent cost so agents can reason about usage at scale.
 *
 * Base rate: $0.002/sec for 1080p h264 encoding (~$7.20/hr, roughly
 * the cost of an A10G spot instance on AWS). Scaling factors:
 *   - 4K: 3x base (more GPU VRAM / longer encode)
 *   - Complex filters (text overlay, speed change): 1.5x
 *   - Simple copy/trim: 0.2x (stream copy, near-instant)
 */
type CostTier = 'copy' | 'simple' | 'complex' | '4k';

function calculateCost(
  durationSeconds: number,
  tier: CostTier = 'simple'
): { estimatedRenderSeconds: number; estimatedUSD: number; basis: string } {
  const BASE_RATE_PER_SEC = 0.002; // $/sec at 1080p
  const tierMultiplier: Record<CostTier, number> = {
    copy: 0.2,
    simple: 1.0,
    complex: 1.5,
    '4k': 3.0,
  };
  const renderMultiplier: Record<CostTier, number> = {
    copy: 0.1,
    simple: 1.5,
    complex: 2.5,
    '4k': 4.0,
  };
  const mult = tierMultiplier[tier];
  const renderMult = renderMultiplier[tier];
  return {
    estimatedRenderSeconds: Math.ceil(durationSeconds * renderMult),
    estimatedUSD: parseFloat((durationSeconds * BASE_RATE_PER_SEC * mult).toFixed(6)),
    basis: `cloud-equivalent at $${BASE_RATE_PER_SEC}/sec (${tier} tier). Local renders are free.`,
  };
}

// ============================================================================
// VideoEngine Class
// ============================================================================

export class VideoEngine {
  /**
   * Inspect video file and extract metadata using ffprobe
   */
  async inspect(filePath: string): Promise<OperationResult<VideoMetadata>> {
    const startTime = Date.now();

    try {
      // Validate file exists
      await fs.access(filePath);

      // Run ffprobe to get metadata
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_format',
        '-show_streams',
        '-print_format', 'json',
        filePath,
      ]);

      const probeData = JSON.parse(stdout);

      // Extract video stream
      const videoStream = probeData.streams.find((s: any) => s.codec_type === 'video');
      if (!videoStream) {
        return {
          success: false,
          operation: 'inspect',
          input: { filePath },
          error: {
            code: 'NO_VIDEO_STREAM',
            message: 'No video stream found in file',
            suggestion: 'Ensure the input file contains valid video data',
          },
        };
      }

      // Extract audio tracks
      const audioTracks = probeData.streams
        .filter((s: any) => s.codec_type === 'audio')
        .map((s: any, idx: number) => ({
          index: idx,
          codec: s.codec_name || 'unknown',
          sampleRate: s.sample_rate || 0,
          channels: s.channels || 0,
        }));

      // Parse metadata
      const duration = parseFloat(probeData.format.duration || videoStream.duration || 0);
      const fileSize = parseInt(probeData.format.size || 0, 10);
      const bitrate = parseInt(probeData.format.bit_rate || 0, 10);

      const metadata: VideoMetadata = {
        duration,
        resolution: {
          width: videoStream.width || 0,
          height: videoStream.height || 0,
        },
        fps: videoStream.r_frame_rate ? parseFraction(videoStream.r_frame_rate) : 0,
        videoCodec: videoStream.codec_name || 'unknown',
        audioTracks,
        fileSize,
        bitrate,
      };

      const renderTime = Date.now() - startTime;

      return {
        success: true,
        operation: 'inspect',
        input: { filePath },
        output: metadata,
        cost: calculateCost(duration, 'copy'),
        suggestions:
          audioTracks.length === 0 ? ['This video has no audio tracks. Consider adding audio.'] : undefined,
      };
    } catch (err) {
      return {
        success: false,
        operation: 'inspect',
        input: { filePath },
        error: {
          code: 'INSPECT_FAILED',
          message: `Failed to inspect video: ${err instanceof Error ? err.message : String(err)}`,
          suggestion: 'Ensure ffprobe is installed and the file path is correct and accessible',
        },
      };
    }
  }

  /**
   * Detect silent segments in audio
   */
  async detectSilence(
    filePath: string,
    opts: DetectSilenceOptions = {}
  ): Promise<OperationResult<SilentSegment[]>> {
    const threshold = opts.threshold ?? -35;
    const minDuration = opts.minDuration ?? 0.5;

    try {
      // Validate file exists
      await fs.access(filePath);

      // Run ffmpeg with silencedetect filter
      const { stderr } = await execFileAsync('ffmpeg', [
        '-i', filePath,
        '-af', `silencedetect=n=${threshold}dB:d=${minDuration}`,
        '-f', 'null',
        '-',
      ]);

      // Parse silencedetect output
      const silentSegments: SilentSegment[] = [];
      const lines = stderr.split('\n');

      let currentStart: number | null = null;
      for (const line of lines) {
        if (line.includes('silence_start:')) {
          const match = line.match(/silence_start:\s*([\d.]+)/);
          if (match) {
            currentStart = parseFloat(match[1]);
          }
        } else if (line.includes('silence_end:')) {
          const match = line.match(/silence_end:\s*([\d.]+)/);
          if (match && currentStart !== null) {
            const end = parseFloat(match[1]);
            silentSegments.push({
              start: currentStart,
              end,
              duration: end - currentStart,
            });
            currentStart = null;
          }
        }
      }

      // Get metadata for cost calculation
      const metadata = await this.inspect(filePath);

      return {
        success: true,
        operation: 'detectSilence',
        input: { filePath, threshold, minDuration },
        output: silentSegments,
        cost:
          metadata.success && metadata.output
            ? calculateCost(metadata.output.duration, 'copy')
            : { estimatedRenderSeconds: 0, estimatedUSD: 0, basis: 'unknown (inspect failed)' },
        suggestions:
          silentSegments.length > 0
            ? [`Found ${silentSegments.length} silent segments. Consider trimming them for a tighter edit.`]
            : ['No significant silent segments detected.'],
      };
    } catch (err) {
      return {
        success: false,
        operation: 'detectSilence',
        input: { filePath, threshold, minDuration },
        error: {
          code: 'SILENCE_DETECT_FAILED',
          message: `Failed to detect silence: ${err instanceof Error ? err.message : String(err)}`,
          suggestion: 'Ensure ffmpeg is installed and the audio stream is valid',
        },
      };
    }
  }

  /**
   * Trim/cut video to specified time range
   */
  async trim(filePath: string, opts: TrimOptions): Promise<OperationResult<{ outputPath: string }>> {
    const outputPath = opts.outputPath || getDefaultOutputPath(filePath, 'trimmed');

    try {
      // Validate inputs
      await fs.access(filePath);

      const startSeconds = parseTimestamp(opts.start);
      let endSeconds: number | undefined;
      if (opts.end) {
        endSeconds = parseTimestamp(opts.end);
        if (endSeconds <= startSeconds) {
          return {
            success: false,
            operation: 'trim',
            input: { filePath, start: opts.start, end: opts.end },
            error: {
              code: 'INVALID_TIME_RANGE',
              message: 'End time must be greater than start time',
              suggestion: 'Check your start and end timestamps',
            },
          };
        }
      }

      // Get duration for calculating trim length
      const metadata = await this.inspect(filePath);
      if (!metadata.success || !metadata.output) {
        throw new Error('Could not inspect video for duration');
      }

      if (startSeconds > metadata.output.duration) {
        return {
          success: false,
          operation: 'trim',
          input: { filePath, start: opts.start, end: opts.end },
          error: {
            code: 'START_TIME_OUT_OF_RANGE',
            message: `Start time ${opts.start} is beyond video duration (${formatTimestamp(metadata.output.duration)})`,
            suggestion: 'Set start time within the video duration',
          },
        };
      }

      if (endSeconds && endSeconds > metadata.output.duration) {
        return {
          success: false,
          operation: 'trim',
          input: { filePath, start: opts.start, end: opts.end },
          error: {
            code: 'END_TIME_OUT_OF_RANGE',
            message: `End time ${opts.end} is beyond video duration (${formatTimestamp(metadata.output.duration)})`,
            suggestion: 'Set end time within the video duration',
          },
        };
      }

      // Build ffmpeg command
      // Use -ss before -i for fast seek, -t for duration
      const args = ['-ss', String(startSeconds), '-i', filePath];

      if (endSeconds !== undefined) {
        const duration = endSeconds - startSeconds;
        args.push('-t', String(duration));
      }

      args.push('-c:v', 'copy', '-c:a', 'copy', outputPath);

      // Execute ffmpeg
      await execFileAsync('ffmpeg', [...args, '-y']);

      // Verify output file
      await fs.access(outputPath);
      const outputStats = await fs.stat(outputPath);

      const trimmedDuration = endSeconds ? endSeconds - startSeconds : metadata.output.duration - startSeconds;

      return {
        success: true,
        operation: 'trim',
        input: { filePath, start: opts.start, end: opts.end, outputPath },
        output: { outputPath },
        cost: calculateCost(trimmedDuration, 'copy'),
        suggestions: [`Trimmed ${formatTimestamp(trimmedDuration)} from original video`],
      };
    } catch (err) {
      return {
        success: false,
        operation: 'trim',
        input: { filePath, start: opts.start, end: opts.end, outputPath },
        error: {
          code: 'TRIM_FAILED',
          message: `Failed to trim video: ${err instanceof Error ? err.message : String(err)}`,
          suggestion: 'Verify ffmpeg is installed and the input file is a valid video',
        },
      };
    }
  }

  /**
   * Concatenate multiple video clips
   */
  async concatenate(
    files: string[],
    opts: ConcatenateOptions = {}
  ): Promise<OperationResult<{ outputPath: string }>> {
    const outputPath = opts.outputPath || getDefaultOutputPath(files[0], 'concatenated');

    try {
      // Validate inputs
      if (files.length < 2) {
        return {
          success: false,
          operation: 'concatenate',
          input: { fileCount: files.length },
          error: {
            code: 'INSUFFICIENT_FILES',
            message: 'At least 2 files required for concatenation',
            suggestion: 'Provide multiple video files to concatenate',
          },
        };
      }

      // Check all files exist
      for (const file of files) {
        await fs.access(file);
      }

      // Create concat demuxer file
      const concatContent = files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
      const concatFile = join(dirname(outputPath), '.concat_list.txt');
      await fs.writeFile(concatFile, concatContent);

      try {
        // Run ffmpeg concat
        const args = [
          '-f', 'concat',
          '-safe', '0',
          '-i', concatFile,
          '-c:v', 'copy',
          '-c:a', 'copy',
          outputPath,
        ];

        await execFileAsync('ffmpeg', [...args, '-y']);

        // Verify output
        await fs.access(outputPath);

        // Calculate total duration
        let totalDuration = 0;
        for (const file of files) {
          const meta = await this.inspect(file);
          if (meta.success && meta.output) {
            totalDuration += meta.output.duration;
          }
        }

        return {
          success: true,
          operation: 'concatenate',
          input: { files, fileCount: files.length },
          output: { outputPath },
          cost: calculateCost(totalDuration, 'simple'),
          suggestions: [`Concatenated ${files.length} clips into single file`],
        };
      } finally {
        // Cleanup concat file
        await fs.unlink(concatFile).catch(() => {});
      }
    } catch (err) {
      return {
        success: false,
        operation: 'concatenate',
        input: { fileCount: files.length },
        error: {
          code: 'CONCATENATE_FAILED',
          message: `Failed to concatenate videos: ${err instanceof Error ? err.message : String(err)}`,
          suggestion: 'Ensure all input files are valid videos with compatible codecs',
        },
      };
    }
  }

  /**
   * Add text overlay to video
   */
  async addText(filePath: string, opts: AddTextOptions): Promise<OperationResult<{ outputPath: string }>> {
    const outputPath = opts.outputPath || getDefaultOutputPath(filePath, 'text');
    const position = opts.position || 'center';
    const fontSize = opts.fontSize || 24;
    const color = opts.color || 'white';

    try {
      await fs.access(filePath);

      const metadata = await this.inspect(filePath);
      if (!metadata.success || !metadata.output) {
        throw new Error('Could not inspect video');
      }

      // Normalize position: accept both "topcenter" and "top_center" forms
      const normalizedPosition = position.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
        .replace(/^(top|bottom|center)(left|right|center)$/, '$1_$2');

      // Position mapping using ffmpeg drawtext expressions for accuracy
      const w = metadata.output.resolution.width;
      const h = metadata.output.resolution.height;
      const positionMap: Record<string, [number, number]> = {
        center: [
          w / 2 - (fontSize * opts.text.length) / 4,
          h / 2,
        ],
        top_left: [10, 30],
        top_center: [w / 2 - (fontSize * opts.text.length) / 4, 30],
        top_right: [w - (fontSize * opts.text.length) / 2, 30],
        center_left: [10, h / 2],
        center_right: [w - (fontSize * opts.text.length) / 2, h / 2],
        bottom_left: [10, h - fontSize - 10],
        bottom_center: [
          w / 2 - (fontSize * opts.text.length) / 4,
          h - fontSize - 10,
        ],
        bottom_right: [
          w - (fontSize * opts.text.length) / 2,
          h - fontSize - 10,
        ],
      };

      const [x, y] = positionMap[normalizedPosition] || positionMap.center;

      // Build filter_complex
      let drawFilter = `drawtext=text='${opts.text.replace(/'/g, "'\\''")}':x=${x}:y=${y}:fontsize=${fontSize}:fontcolor=${color}`;

      if (opts.start || opts.end) {
        const startTime = opts.start ? parseTimestamp(opts.start) : 0;
        const endTime = opts.end ? parseTimestamp(opts.end) : metadata.output.duration;
        drawFilter += `:enable='between(t,${startTime},${endTime})'`;
      }

      const args = [
        '-i', filePath,
        '-vf', drawFilter,
        '-c:a', 'copy',
        outputPath,
      ];

      await execFileAsync('ffmpeg', [...args, '-y']);

      await fs.access(outputPath);

      return {
        success: true,
        operation: 'addText',
        input: { filePath, text: opts.text, position, fontSize, color },
        output: { outputPath },
        cost: calculateCost(metadata.output.duration, 'complex'),
        suggestions: ['Text overlay added successfully'],
      };
    } catch (err) {
      return {
        success: false,
        operation: 'addText',
        input: { filePath, text: opts.text },
        error: {
          code: 'ADD_TEXT_FAILED',
          message: `Failed to add text: ${err instanceof Error ? err.message : String(err)}`,
          suggestion: 'Ensure the video file is valid and ffmpeg supports the text filter',
        },
      };
    }
  }

  /**
   * Add or mix audio with video
   */
  async addAudio(
    filePath: string,
    opts: AddAudioOptions
  ): Promise<OperationResult<{ outputPath: string }>> {
    const outputPath = opts.outputPath || getDefaultOutputPath(filePath, 'audio');
    const mixMode = opts.mixMode || 'mix';
    const volume = opts.volume ?? 1.0;

    try {
      await fs.access(filePath);
      await fs.access(opts.audioPath);

      const metadata = await this.inspect(filePath);
      if (!metadata.success || !metadata.output) {
        throw new Error('Could not inspect video');
      }

      const args = ['-i', filePath, '-i', opts.audioPath];

      if (opts.start) {
        const startTime = parseTimestamp(opts.start);
        args.push('-ss', String(startTime));
      }

      if (mixMode === 'replace') {
        // Replace audio completely
        if (volume !== 1.0) {
          args.push('-filter_complex', `[1:a]volume=${volume}[a]`, '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy', '-shortest');
        } else {
          args.push('-c:v', 'copy', '-map', '0:v:0', '-map', '1:a:0', '-shortest');
        }
      } else {
        // Mix audio tracks, incorporating volume into the filter graph
        const volumeFilter = volume !== 1.0 ? `[1:a]volume=${volume}[adj];[0:a][adj]` : '[0:a][1:a]';
        args.push(
          '-filter_complex',
          `${volumeFilter}amix=inputs=2:duration=first[a]`,
          '-map', '0:v',
          '-map', '[a]',
          '-c:v', 'copy'
        );
      }

      args.push(outputPath);

      await execFileAsync('ffmpeg', [...args, '-y']);

      await fs.access(outputPath);

      return {
        success: true,
        operation: 'addAudio',
        input: { filePath, audioPath: opts.audioPath, mixMode, volume },
        output: { outputPath },
        cost: calculateCost(metadata.output.duration, 'complex'),
        suggestions: [`Audio ${mixMode === 'replace' ? 'replaced' : 'mixed'} successfully`],
      };
    } catch (err) {
      return {
        success: false,
        operation: 'addAudio',
        input: { filePath, audioPath: opts.audioPath },
        error: {
          code: 'ADD_AUDIO_FAILED',
          message: `Failed to add audio: ${err instanceof Error ? err.message : String(err)}`,
          suggestion: 'Ensure both video and audio files are valid and accessible',
        },
      };
    }
  }

  /**
   * Remove audio track from video
   */
  async removeAudio(
    filePath: string,
    opts: RemoveAudioOptions = {}
  ): Promise<OperationResult<{ outputPath: string }>> {
    const outputPath = opts.outputPath || getDefaultOutputPath(filePath, 'noaudio');

    try {
      await fs.access(filePath);

      const metadata = await this.inspect(filePath);
      if (!metadata.success || !metadata.output) {
        throw new Error('Could not inspect video');
      }

      if (metadata.output.audioTracks.length === 0) {
        return {
          success: false,
          operation: 'removeAudio',
          input: { filePath },
          error: {
            code: 'NO_AUDIO_TO_REMOVE',
            message: 'This video has no audio tracks',
            suggestion: 'Audio removal is only needed for videos with audio',
          },
        };
      }

      const args = ['-i', filePath, '-c:v', 'copy', '-an', outputPath];

      await execFileAsync('ffmpeg', [...args, '-y']);

      await fs.access(outputPath);

      return {
        success: true,
        operation: 'removeAudio',
        input: { filePath },
        output: { outputPath },
        cost: calculateCost(metadata.output.duration, 'copy'),
        suggestions: ['Audio removed successfully. Video-only file created.'],
      };
    } catch (err) {
      return {
        success: false,
        operation: 'removeAudio',
        input: { filePath },
        error: {
          code: 'REMOVE_AUDIO_FAILED',
          message: `Failed to remove audio: ${err instanceof Error ? err.message : String(err)}`,
          suggestion: 'Ensure ffmpeg is installed and the input file is valid',
        },
      };
    }
  }

  /**
   * Adjust playback speed
   */
  async adjustSpeed(
    filePath: string,
    opts: AdjustSpeedOptions
  ): Promise<OperationResult<{ outputPath: string }>> {
    const outputPath = opts.outputPath || getDefaultOutputPath(filePath, 'speed');
    const factor = opts.factor;

    try {
      await fs.access(filePath);

      if (factor <= 0) {
        return {
          success: false,
          operation: 'adjustSpeed',
          input: { filePath, factor },
          error: {
            code: 'INVALID_SPEED_FACTOR',
            message: 'Speed factor must be greater than 0',
            suggestion: 'Use values like 0.5 (half speed), 1.0 (normal), 2.0 (double speed)',
          },
        };
      }

      const metadata = await this.inspect(filePath);
      if (!metadata.success || !metadata.output) {
        throw new Error('Could not inspect video');
      }

      const speedFilter = `[0:v]setpts=PTS/${factor}[v];[0:a]atempo=${factor}[a]`;
      const args = [
        '-i', filePath,
        '-filter_complex', speedFilter,
        '-map', '[v]',
        '-map', '[a]',
        outputPath,
      ];

      await execFileAsync('ffmpeg', [...args, '-y']);

      await fs.access(outputPath);

      const newDuration = metadata.output.duration / factor;

      return {
        success: true,
        operation: 'adjustSpeed',
        input: { filePath, factor },
        output: { outputPath },
        cost: calculateCost(newDuration, 'complex'),
        suggestions: [
          `Video speed adjusted to ${(factor * 100).toFixed(0)}%. New duration: ${formatTimestamp(newDuration)}`,
        ],
      };
    } catch (err) {
      return {
        success: false,
        operation: 'adjustSpeed',
        input: { filePath, factor },
        error: {
          code: 'ADJUST_SPEED_FAILED',
          message: `Failed to adjust speed: ${err instanceof Error ? err.message : String(err)}`,
          suggestion: 'Ensure ffmpeg is installed and the input file has both video and audio',
        },
      };
    }
  }

  /**
   * Export video with preset or custom settings
   */
  async exportVideo(
    filePath: string,
    opts: ExportVideoOptions = {}
  ): Promise<OperationResult<{ outputPath: string }>> {
    try {
      await fs.access(filePath);

      const metadata = await this.inspect(filePath);
      if (!metadata.success || !metadata.output) {
        throw new Error('Could not inspect video');
      }

      // Determine preset and output path
      const presetName = opts.preset || 'youtube';
      const preset = PRESETS[presetName];

      if (!preset && opts.preset) {
        return {
          success: false,
          operation: 'exportVideo',
          input: { filePath, preset: opts.preset },
          error: {
            code: 'INVALID_PRESET',
            message: `Preset "${opts.preset}" not found`,
            suggestion: `Available presets: ${Object.keys(PRESETS).join(', ')}`,
          },
        };
      }

      const activePreset = preset || PRESETS.youtube;
      const resolution = opts.resolution || activePreset.resolution;
      const quality = opts.quality || 'medium';
      const format = opts.format || activePreset.container;

      const outputPath = opts.outputPath || getDefaultOutputPath(filePath, `exported_${presetName}`);

      // Build ffmpeg args
      const args = ['-i', filePath, '-s', resolution];

      // Add codec settings
      args.push('-c:v', activePreset.videoCodec);
      args.push('-b:v', activePreset.bitrate);

      if (activePreset.customArgs.length > 0) {
        args.push(...activePreset.customArgs);
      }

      args.push('-c:a', activePreset.audioCodec);
      args.push('-b:a', activePreset.audioRate);

      args.push(outputPath);

      await execFileAsync('ffmpeg', [...args, '-y']);

      await fs.access(outputPath);

      return {
        success: true,
        operation: 'exportVideo',
        input: { filePath, preset: presetName, resolution, quality },
        output: { outputPath },
        cost: calculateCost(metadata.output.duration, 'simple'),
        suggestions: [
          `Video exported with "${presetName}" preset at ${resolution}`,
          `Optimized for ${presetName.replace('_', ' ')}`,
        ],
      };
    } catch (err) {
      return {
        success: false,
        operation: 'exportVideo',
        input: { filePath, preset: opts.preset },
        error: {
          code: 'EXPORT_FAILED',
          message: `Failed to export video: ${err instanceof Error ? err.message : String(err)}`,
          suggestion: 'Verify ffmpeg is installed and supports the requested codec and preset',
        },
      };
    }
  }

  /**
   * Extract a frame as a thumbnail image
   */
  async getThumbnail(
    filePath: string,
    opts: GetThumbnailOptions = {}
  ): Promise<OperationResult<{ outputPath: string }>> {
    const timestamp = opts.timestamp ? parseTimestamp(opts.timestamp) : 0;
    const outputPath = opts.outputPath || getDefaultOutputPath(filePath, 'thumbnail').replace('.mp4', '.png');

    try {
      await fs.access(filePath);

      const metadata = await this.inspect(filePath);
      if (!metadata.success || !metadata.output) {
        throw new Error('Could not inspect video');
      }

      if (timestamp < 0 || timestamp > metadata.output.duration) {
        return {
          success: false,
          operation: 'getThumbnail',
          input: { filePath, timestamp: opts.timestamp },
          error: {
            code: 'INVALID_TIMESTAMP',
            message: `Timestamp ${opts.timestamp} is outside video duration (0-${formatTimestamp(metadata.output.duration)})`,
            suggestion: 'Use a timestamp within the video duration',
          },
        };
      }

      const args = [
        '-i', filePath,
        '-ss', String(timestamp),
        '-vframes', '1',
        '-vf', `scale=${metadata.output.resolution.width}:${metadata.output.resolution.height}`,
        outputPath,
      ];

      await execFileAsync('ffmpeg', [...args, '-y']);

      await fs.access(outputPath);

      return {
        success: true,
        operation: 'getThumbnail',
        input: { filePath, timestamp: opts.timestamp || '0' },
        output: { outputPath },
        cost: { estimatedRenderSeconds: 1, estimatedUSD: 0.0004, basis: 'single frame extraction (near-instant)' },
        suggestions: [`Thumbnail extracted at ${formatTimestamp(timestamp)}`],
      };
    } catch (err) {
      return {
        success: false,
        operation: 'getThumbnail',
        input: { filePath, timestamp: opts.timestamp },
        error: {
          code: 'THUMBNAIL_FAILED',
          message: `Failed to extract thumbnail: ${err instanceof Error ? err.message : String(err)}`,
          suggestion: 'Ensure ffmpeg is installed and the video file is valid',
        },
      };
    }
  }

  /**
   * Extract embedded subtitles/captions from a video file.
   * Returns subtitle text with timestamps in structured format.
   */
  async extractSubtitles(
    filePath: string,
    opts: { streamIndex?: number; outputPath?: string } = {}
  ): Promise<OperationResult<{ outputPath: string; entries: Array<{ index: number; start: string; end: string; text: string }> }>> {
    const outputPath = opts.outputPath || getDefaultOutputPath(filePath, 'subtitles').replace('.mp4', '.srt');

    try {
      await fs.access(filePath);

      // Check for subtitle streams
      const metadata = await this.inspect(filePath);
      if (!metadata.success || !metadata.output) {
        throw new Error('Could not inspect video');
      }

      // Probe for subtitle streams specifically
      const { stdout: probeOut } = await execFileAsync('ffprobe', [
        '-v', 'error', '-select_streams', 's',
        '-show_entries', 'stream=index,codec_name,codec_type',
        '-print_format', 'json', filePath,
      ]);
      const subtitleStreams = JSON.parse(probeOut).streams || [];

      if (subtitleStreams.length === 0) {
        return {
          success: false,
          operation: 'extractSubtitles',
          input: { filePath },
          error: {
            code: 'NO_SUBTITLES',
            message: 'No subtitle streams found in this video',
            suggestion: 'This video has no embedded subtitles. Use a speech-to-text service (Whisper, Deepgram, AssemblyAI) to generate a transcript, then pass the resulting SRT file to add_subtitles.',
          },
        };
      }

      const streamIdx = opts.streamIndex ?? 0;

      // Extract subtitles to SRT format
      await execFileAsync('ffmpeg', [
        '-i', filePath,
        '-map', `0:s:${streamIdx}`,
        '-c:s', 'srt',
        outputPath,
        '-y',
      ]);

      // Parse the SRT file into structured entries
      const srtContent = await fs.readFile(outputPath, 'utf-8');
      const entries = parseSRT(srtContent);

      return {
        success: true,
        operation: 'extractSubtitles',
        input: { filePath, streamIndex: streamIdx },
        output: { outputPath, entries },
        cost: { estimatedRenderSeconds: 1, estimatedUSD: 0.0004, basis: 'stream extraction (near-instant)' },
        suggestions: [`Extracted ${entries.length} subtitle entries from stream ${streamIdx}`],
      };
    } catch (err) {
      return {
        success: false,
        operation: 'extractSubtitles',
        input: { filePath },
        error: {
          code: 'SUBTITLE_EXTRACTION_FAILED',
          message: `Failed to extract subtitles: ${err instanceof Error ? err.message : String(err)}`,
          suggestion: 'Ensure the video file has embedded subtitle tracks',
        },
      };
    }
  }

  /**
   * Generate a waveform visualization of the audio track as a PNG image.
   * Useful for agents to understand audio structure without hearing it.
   */
  async generateWaveform(
    filePath: string,
    opts: { outputPath?: string; width?: number; height?: number; color?: string } = {}
  ): Promise<OperationResult<{ outputPath: string }>> {
    const outputPath = opts.outputPath || getDefaultOutputPath(filePath, 'waveform').replace('.mp4', '.png');
    const width = opts.width || 1920;
    const height = opts.height || 200;
    const color = opts.color || '3B82F6';

    try {
      await fs.access(filePath);

      await execFileAsync('ffmpeg', [
        '-i', filePath,
        '-filter_complex',
        `aformat=channel_layouts=mono,showwavespic=s=${width}x${height}:colors=#${color}`,
        '-frames:v', '1',
        outputPath,
        '-y',
      ]);

      await fs.access(outputPath);

      return {
        success: true,
        operation: 'generateWaveform',
        input: { filePath, width, height },
        output: { outputPath },
        cost: { estimatedRenderSeconds: 2, estimatedUSD: 0.004, basis: 'audio visualization render (complex filter)' },
      };
    } catch (err) {
      return {
        success: false,
        operation: 'generateWaveform',
        input: { filePath },
        error: {
          code: 'WAVEFORM_FAILED',
          message: `Failed to generate waveform: ${err instanceof Error ? err.message : String(err)}`,
          suggestion: 'Ensure the video has an audio track',
        },
      };
    }
  }

  /**
   * Sample N evenly-spaced frames from a video as thumbnails.
   * Returns paths to each frame image. Useful for multimodal models
   * to "scan" a video without watching it.
   */
  async sampleFrames(
    filePath: string,
    opts: { count?: number; outputDir?: string } = {}
  ): Promise<OperationResult<{ frames: Array<{ index: number; timestamp: string; path: string }> }>> {
    const count = opts.count || 10;
    const outputDir = opts.outputDir || dirname(filePath);

    try {
      await fs.access(filePath);

      const metadata = await this.inspect(filePath);
      if (!metadata.success || !metadata.output) {
        throw new Error('Could not inspect video');
      }

      const duration = metadata.output.duration;
      const interval = duration / (count + 1);
      const frames: Array<{ index: number; timestamp: string; path: string }> = [];

      for (let i = 1; i <= count; i++) {
        const timestamp = interval * i;
        const framePath = join(outputDir, `${basename(filePath, '.mp4')}_frame_${String(i).padStart(3, '0')}.png`);

        await execFileAsync('ffmpeg', [
          '-ss', String(timestamp),
          '-i', filePath,
          '-frames:v', '1',
          '-q:v', '2',
          framePath,
          '-y',
        ]);

        frames.push({
          index: i,
          timestamp: formatTimestamp(timestamp),
          path: framePath,
        });
      }

      return {
        success: true,
        operation: 'sampleFrames',
        input: { filePath, count },
        output: { frames },
        cost: { estimatedRenderSeconds: count * 0.5, estimatedUSD: count * 0.0004, basis: `${count} frame extractions (near-instant each)` },
        suggestions: [`Sampled ${count} frames at ${formatTimestamp(interval)} intervals`],
      };
    } catch (err) {
      return {
        success: false,
        operation: 'sampleFrames',
        input: { filePath },
        error: {
          code: 'SAMPLE_FRAMES_FAILED',
          message: `Failed to sample frames: ${err instanceof Error ? err.message : String(err)}`,
          suggestion: 'Ensure the video file is valid and accessible',
        },
      };
    }
  }
}

// ============================================================================
// Utility: SRT Parser
// ============================================================================

function parseSRT(srtContent: string): Array<{ index: number; start: string; end: string; text: string }> {
  const entries: Array<{ index: number; start: string; end: string; text: string }> = [];
  const blocks = srtContent.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 3) continue;

    const index = parseInt(lines[0]!, 10);
    const timeLine = lines[1]!;
    const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/);
    if (!timeMatch) continue;

    const text = lines.slice(2).join(' ').replace(/<[^>]+>/g, '').trim();
    entries.push({
      index,
      start: timeMatch[1]!.replace(',', '.'),
      end: timeMatch[2]!.replace(',', '.'),
      text,
    });
  }

  return entries;
}

export { PRESETS };
export type {
  OperationResult,
  VideoMetadata,
  SilentSegment,
  TrimOptions,
  DetectSilenceOptions,
  ConcatenateOptions,
  AddTextOptions,
  AddAudioOptions,
  RemoveAudioOptions,
  AdjustSpeedOptions,
  ExportVideoOptions,
  GetThumbnailOptions,
};
