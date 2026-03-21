/**
 * Quick smoke test: creates a synthetic test video with ffmpeg,
 * then exercises the VideoEngine directly to verify each operation works.
 */
import { execSync } from "child_process";
import { existsSync, mkdirSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { VideoEngine } from "./ffmpeg.js";

const TEST_DIR = join(tmpdir(), "ave-test");
const engine = new VideoEngine();

let passed = 0;
let failed = 0;

function cleanup() {
  if (existsSync(TEST_DIR)) {
    for (const f of readdirSync(TEST_DIR)) {
      try { unlinkSync(join(TEST_DIR, f)); } catch {}
    }
  }
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ✗ ${name}: ${err.message || err}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

async function main() {
  console.log("\n🎬 Agentic Video Editor — Smoke Tests\n");

  // Setup
  cleanup();
  mkdirSync(TEST_DIR, { recursive: true });

  // Create a 5-second test video with audio using ffmpeg directly
  const testVideo = join(TEST_DIR, "test.mp4");
  const testAudio = join(TEST_DIR, "test_audio.mp3");
  console.log("Creating test media...");
  execSync(
    `ffmpeg -y -f lavfi -i testsrc=duration=5:size=640x480:rate=30 -f lavfi -i sine=frequency=440:duration=5 -c:v libx264 -c:a aac -shortest "${testVideo}"`,
    { stdio: 'ignore' }
  );
  execSync(
    `ffmpeg -y -f lavfi -i sine=frequency=880:duration=3 -c:a libmp3lame "${testAudio}"`,
    { stdio: 'ignore' }
  );
  console.log("Test media created.\n");

  // ── inspect ──
  await test("inspect_video returns metadata", async () => {
    const r = await engine.inspect(testVideo);
    assert(r.success, "inspect failed");
    assert(r.output!.duration > 4 && r.output!.duration < 6, `unexpected duration: ${r.output!.duration}`);
    assert(r.output!.resolution.width === 640, `unexpected width: ${r.output!.resolution.width}`);
    assert(r.output!.resolution.height === 480, `unexpected height: ${r.output!.resolution.height}`);
    assert(r.output!.audioTracks.length > 0, "no audio tracks found");
  });

  // ── detect_silence ──
  await test("detect_silence runs without error", async () => {
    const r = await engine.detectSilence(testVideo, { threshold: -50, minDuration: 0.3 });
    assert(r.success, `detectSilence failed: ${r.error?.message}`);
  });

  // ── trim ──
  await test("trim produces shorter video", async () => {
    const out = join(TEST_DIR, "trimmed.mp4");
    const r = await engine.trim(testVideo, { start: "00:00:01", end: "00:00:03", outputPath: out });
    assert(r.success, `trim failed: ${r.error?.message}`);
    assert(existsSync(out), "output file not created");
    // Verify duration
    const info = await engine.inspect(out);
    assert(info.output!.duration >= 1.5 && info.output!.duration <= 2.5, `trimmed duration wrong: ${info.output!.duration}`);
  });

  // ── adjust_speed ──
  await test("adjust_speed 2x halves duration", async () => {
    const out = join(TEST_DIR, "fast.mp4");
    const r = await engine.adjustSpeed(testVideo, { factor: 2, outputPath: out });
    assert(r.success, `adjustSpeed failed: ${r.error?.message}`);
    assert(existsSync(out), "output file not created");
    const info = await engine.inspect(out);
    assert(info.output!.duration >= 2 && info.output!.duration <= 3, `sped-up duration wrong: ${info.output!.duration}`);
  });

  // ── remove_audio ──
  await test("remove_audio strips audio tracks", async () => {
    const out = join(TEST_DIR, "silent.mp4");
    const r = await engine.removeAudio(testVideo, { outputPath: out });
    assert(r.success, `removeAudio failed: ${r.error?.message}`);
    const info = await engine.inspect(out);
    assert(info.output!.audioTracks.length === 0, "audio tracks still present");
  });

  // ── add_text ──
  await test("add_text overlay creates output", async () => {
    const out = join(TEST_DIR, "text_overlay.mp4");
    const r = await engine.addText(testVideo, {
      text: "Hello AI",
      position: "center",
      start: "00:00:00",
      end: "00:00:03",
      fontSize: 48,
      color: "white",
      outputPath: out,
    });
    assert(r.success, `addText failed: ${r.error?.message}`);
    assert(existsSync(out), "output file not created");
  });

  // ── add_audio ──
  await test("add_audio mixes audio into video", async () => {
    const out = join(TEST_DIR, "with_audio.mp4");
    const r = await engine.addAudio(testVideo, {
      audioPath: testAudio,
      volume: 0.5,
      mixMode: "mix",
      outputPath: out,
    });
    assert(r.success, `addAudio failed: ${r.error?.message}`);
    assert(existsSync(out), "output file not created");
  });

  // ── get_thumbnail ──
  await test("get_thumbnail extracts a frame", async () => {
    const out = join(TEST_DIR, "thumb.png");
    const r = await engine.getThumbnail(testVideo, { timestamp: "00:00:02", outputPath: out });
    assert(r.success, `getThumbnail failed: ${r.error?.message}`);
    assert(existsSync(out), "thumbnail not created");
  });

  // ── export_video with preset ──
  await test("export_video with youtube preset", async () => {
    const out = join(TEST_DIR, "youtube_export.mp4");
    const r = await engine.exportVideo(testVideo, { preset: "youtube", outputPath: out });
    assert(r.success, `exportVideo failed: ${r.error?.message}`);
    assert(existsSync(out), "exported file not created");
    const info = await engine.inspect(out);
    // YouTube preset should upscale to 1920x1080
    assert(info.output!.resolution.width === 1920, `expected 1920 width, got ${info.output!.resolution.width}`);
  });

  // ── concatenate ──
  await test("concatenate joins two clips", async () => {
    const clip1 = join(TEST_DIR, "trimmed.mp4"); // from earlier trim test
    const clip2 = testVideo;
    const out = join(TEST_DIR, "concat.mp4");
    const r = await engine.concatenate([clip1, clip2], { outputPath: out });
    assert(r.success, `concatenate failed: ${r.error?.message}`);
    assert(existsSync(out), "concatenated file not created");
  });

  // ── generate_waveform ──
  await test("generate_waveform creates PNG", async () => {
    const out = join(TEST_DIR, "waveform.png");
    const r = await engine.generateWaveform(testVideo, { outputPath: out });
    assert(r.success, `generateWaveform failed: ${r.error?.message}`);
    assert(existsSync(out), "waveform PNG not created");
  });

  // ── sample_frames ──
  await test("sample_frames extracts N frames", async () => {
    const r = await engine.sampleFrames(testVideo, { count: 3, outputDir: TEST_DIR });
    assert(r.success, `sampleFrames failed: ${r.error?.message}`);
    assert(r.output!.frames.length === 3, `expected 3 frames, got ${r.output!.frames.length}`);
    for (const frame of r.output!.frames) {
      assert(existsSync(frame.path), `frame ${frame.index} not created at ${frame.path}`);
    }
  });

  // ── extract_subtitles (expect graceful failure — test video has no subs) ──
  await test("extract_subtitles returns NO_SUBTITLES for unsubtitled video", async () => {
    const r = await engine.extractSubtitles(testVideo);
    assert(!r.success, "should have failed on video without subtitles");
    assert(r.error?.code === "NO_SUBTITLES", `expected NO_SUBTITLES, got ${r.error?.code}`);
  });

  // ── Summary ──
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main();
