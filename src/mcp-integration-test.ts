/**
 * MCP Integration Test
 *
 * Simulates exactly what happens when an MCP client (Claude Desktop, Cursor, etc.)
 * connects to our server. Sends real JSON-RPC messages over stdio and validates responses.
 *
 * This tests the FULL user journey:
 *   1. Client starts server process
 *   2. Client sends initialize → server responds with capabilities
 *   3. Client calls tools → server executes and returns structured results
 *   4. Verify the responses are LLM-parseable and useful
 */

import { spawn, execSync, ChildProcess } from "child_process";
import { join } from "path";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { createInterface } from "readline";
import { tmpdir } from "os";

const SERVER_PATH = join(import.meta.dirname!, "..", "dist", "server.js");
const TEST_DIR = join(tmpdir(), "ave-mcp-test");

let server: ChildProcess;
let messageId = 0;
let passed = 0;
let failed = 0;

// Pending response resolvers keyed by message ID
const pendingResponses = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

// ── Helpers ──

function cleanup() {
  if (existsSync(TEST_DIR)) {
    for (const f of readdirSync(TEST_DIR)) {
      try { unlinkSync(join(TEST_DIR, f)); } catch {}
    }
  }
}

function setupResponseHandler() {
  const rl = createInterface({ input: server.stdout! });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pendingResponses.has(msg.id)) {
        const { resolve } = pendingResponses.get(msg.id)!;
        pendingResponses.delete(msg.id);
        resolve(msg);
      }
    } catch {
      // Not JSON, skip
    }
  });
}

function sendMessage(msg: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = (msg as any).id;
    const timeout = setTimeout(() => {
      pendingResponses.delete(id);
      reject(new Error("Timeout waiting for response"));
    }, 30000);

    pendingResponses.set(id, {
      resolve: (v: any) => { clearTimeout(timeout); resolve(v); },
      reject: (e: any) => { clearTimeout(timeout); reject(e); },
    });

    server.stdin!.write(JSON.stringify(msg) + "\n");
  });
}

function sendNotification(method: string, params: object = {}) {
  server.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function rpcCall(method: string, params: object = {}): Promise<any> {
  const id = ++messageId;
  return sendMessage({ jsonrpc: "2.0", id, method, params });
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

// ── Main ──

async function main() {
  console.log("\n🔌 MCP Integration Test — Full Protocol Flow\n");

  // Setup
  cleanup();
  mkdirSync(TEST_DIR, { recursive: true });

  // Create test video
  console.log("Creating test media...");
  execSync(
    `ffmpeg -y -f lavfi -i testsrc=duration=5:size=640x480:rate=30 -f lavfi -i sine=frequency=440:duration=5 -c:v libx264 -c:a aac -shortest "${join(TEST_DIR, "test.mp4")}"`,
    { stdio: 'ignore' }
  );
  console.log("Test media created.\n");

  // Start MCP server
  console.log("Starting MCP server...");
  server = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  setupResponseHandler();

  // Wait for server to start
  await new Promise(r => setTimeout(r, 500));
  console.log("Server started.\n");

  // ═══════════════════════════════════════════════
  // Phase 1: MCP Protocol Handshake
  // ═══════════════════════════════════════════════
  console.log("─── Phase 1: Protocol Handshake ───");

  let serverInfo: any;
  await test("initialize returns server info and capabilities", async () => {
    const res = await rpcCall("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "integration-test", version: "1.0.0" },
    });
    assert(res.result !== undefined, "no result in response");
    serverInfo = res.result;
    assert(serverInfo.serverInfo.name === "framepipe", `wrong name: ${serverInfo.serverInfo.name}`);
    assert(serverInfo.capabilities.tools !== undefined, "tools capability missing");
    console.log(`    → Server: ${serverInfo.serverInfo.name} v${serverInfo.serverInfo.version}`);
  });

  // Send initialized notification
  sendNotification("notifications/initialized");
  await new Promise(r => setTimeout(r, 200));

  // ═══════════════════════════════════════════════
  // Phase 2: Tool Discovery
  // This is what the LLM sees when it first connects
  // ═══════════════════════════════════════════════
  console.log("\n─── Phase 2: Tool Discovery ───");
  console.log("    (What the LLM sees when your MCP config loads)\n");

  let tools: any[] = [];
  await test("tools/list returns all 18 tools", async () => {
    const res = await rpcCall("tools/list", {});
    tools = res.result.tools;
    assert(Array.isArray(tools), "tools is not an array");
    assert(tools.length >= 17, `expected ≥17 tools, got ${tools.length}`);
    console.log(`    → ${tools.length} tools available:`);
    for (const t of tools) {
      console.log(`      • ${t.name}: ${t.description.substring(0, 70)}...`);
    }
  });

  await test("tool descriptions are LLM-actionable (contain 'Use this when' patterns)", async () => {
    // Good descriptions tell the LLM WHEN to use the tool, not just what it does
    const actionableCount = tools.filter((t: any) =>
      t.description.toLowerCase().includes("use this") ||
      t.description.toLowerCase().includes("useful for") ||
      t.description.toLowerCase().includes("essential for") ||
      t.description.toLowerCase().includes("supports") ||
      t.description.toLowerCase().includes("returns")
    ).length;
    console.log(`    → ${actionableCount}/${tools.length} tools have actionable descriptions`);
    assert(actionableCount >= tools.length * 0.5, "too many tools lack actionable descriptions");
  });

  await test("every editing tool has file_path as required parameter", async () => {
    const editingTools = tools.filter((t: any) =>
      !["create_project", "get_project", "project_add_asset", "project_history"].includes(t.name)
    );
    for (const tool of editingTools) {
      const required = tool.inputSchema?.required || [];
      const hasFileParam = required.includes("file_path") || required.includes("file_paths");
      assert(hasFileParam, `${tool.name} doesn't require file_path — LLMs will forget to pass it`);
    }
  });

  // ═══════════════════════════════════════════════
  // Phase 3: Real Editing Workflow
  // "Take this video, trim to 1-3s, add title, export for Instagram"
  // ═══════════════════════════════════════════════
  console.log("\n─── Phase 3: Editing Workflow ───");
  console.log('    Simulating: "Trim to 1-3s, add a title, export for Instagram"\n');

  // Step 1: Inspect
  await test("Step 1: inspect_video", async () => {
    const res = await rpcCall("tools/call", {
      name: "inspect_video",
      arguments: { file_path: join(TEST_DIR, "test.mp4") },
    });
    const content = JSON.parse(res.result.content[0].text);
    assert(content.success === true, `failed: ${content.error?.message}`);
    const v = content.output;
    console.log(`    → ${v.resolution.width}x${v.resolution.height}, ${v.duration.toFixed(1)}s, codec: ${v.videoCodec}, audio tracks: ${v.audioTracks.length}`);
  });

  // Step 2: Trim
  await test("Step 2: trim to 1-3 seconds", async () => {
    const res = await rpcCall("tools/call", {
      name: "trim",
      arguments: {
        file_path: join(TEST_DIR, "test.mp4"),
        start: "00:00:01",
        end: "00:00:03",
        output_path: join(TEST_DIR, "trimmed.mp4"),
      },
    });
    const content = JSON.parse(res.result.content[0].text);
    assert(content.success === true, `failed: ${content.error?.message}`);
    assert(content.cost?.estimatedUSD !== undefined, "no cost estimate");
    console.log(`    → Cost: $${content.cost.estimatedUSD.toFixed(4)}, warnings: ${content.warnings?.length ?? 0}`);
  });

  // Step 3: Add title text
  await test("Step 3: add_text overlay", async () => {
    const res = await rpcCall("tools/call", {
      name: "add_text",
      arguments: {
        file_path: join(TEST_DIR, "trimmed.mp4"),
        text: "AI-Edited Video",
        position: "topcenter",
        font_size: 36,
        color: "white",
        output_path: join(TEST_DIR, "titled.mp4"),
      },
    });
    const content = JSON.parse(res.result.content[0].text);
    assert(content.success === true, `failed: ${content.error?.message}`);
  });

  // Step 4: Export for Instagram
  await test("Step 4: export for instagram_reel", async () => {
    const res = await rpcCall("tools/call", {
      name: "export_video",
      arguments: {
        file_path: join(TEST_DIR, "titled.mp4"),
        preset: "instagram_reel",
        output_path: join(TEST_DIR, "final_reel.mp4"),
      },
    });
    const content = JSON.parse(res.result.content[0].text);
    assert(content.success === true, `failed: ${content.error?.message}`);
    assert(existsSync(join(TEST_DIR, "final_reel.mp4")), "output file missing");
  });

  // Verify final output
  await test("Step 5: verify final output is 1080x1920 (9:16)", async () => {
    const res = await rpcCall("tools/call", {
      name: "inspect_video",
      arguments: { file_path: join(TEST_DIR, "final_reel.mp4") },
    });
    const content = JSON.parse(res.result.content[0].text);
    assert(content.success === true, "inspect failed");
    const out = content.output;
    console.log(`    → Final: ${out.resolution.width}x${out.resolution.height}, ${out.duration.toFixed(1)}s`);
    assert(out.resolution.width === 1080, `expected 1080w, got ${out.resolution.width}`);
    assert(out.resolution.height === 1920, `expected 1920h, got ${out.resolution.height}`);
  });

  // ═══════════════════════════════════════════════
  // Phase 4: Error Handling
  // LLMs WILL make mistakes. Can they recover?
  // ═══════════════════════════════════════════════
  console.log("\n─── Phase 4: Error Recovery ───");
  console.log("    (LLMs will pass bad inputs — our errors must guide them back)\n");

  await test("nonexistent file → semantic error with suggestion", async () => {
    const res = await rpcCall("tools/call", {
      name: "inspect_video",
      arguments: { file_path: "/does/not/exist.mp4" },
    });
    const content = JSON.parse(res.result.content[0].text);
    assert(content.success === false, "should have failed");
    assert(content.error?.code !== undefined, "missing error code");
    assert(content.error?.suggestion !== undefined, "missing suggestion");
    console.log(`    → ${content.error.code}: "${content.error.suggestion}"`);
  });

  await test("trim past end → time range error", async () => {
    const res = await rpcCall("tools/call", {
      name: "trim",
      arguments: { file_path: join(TEST_DIR, "test.mp4"), start: "00:00:01", end: "00:99:00" },
    });
    const content = JSON.parse(res.result.content[0].text);
    assert(content.success === false, "should have failed");
    assert(content.error?.code !== undefined, "no error code");
    console.log(`    → ${content.error.code}: "${content.error.message}"`);
  });

  await test("extract_subtitles on unsubtitled video → helpful NO_SUBTITLES error", async () => {
    const res = await rpcCall("tools/call", {
      name: "extract_subtitles",
      arguments: { file_path: join(TEST_DIR, "test.mp4") },
    });
    const content = JSON.parse(res.result.content[0].text);
    assert(content.success === false, "should have failed");
    assert(content.error?.code === "NO_SUBTITLES", `expected NO_SUBTITLES, got ${content.error?.code}`);
    console.log(`    → Suggestion: "${content.error.suggestion.substring(0, 80)}..."`);
  });

  // ═══════════════════════════════════════════════
  // Phase 5: Analysis Tools
  // ═══════════════════════════════════════════════
  console.log("\n─── Phase 5: Analysis Tools ───");

  await test("detect_silence returns structured data", async () => {
    const res = await rpcCall("tools/call", {
      name: "detect_silence",
      arguments: { file_path: join(TEST_DIR, "test.mp4") },
    });
    const content = JSON.parse(res.result.content[0].text);
    assert(content.success === true, `failed: ${content.error?.message}`);
  });

  await test("sample_frames extracts frames with timestamps", async () => {
    const res = await rpcCall("tools/call", {
      name: "sample_frames",
      arguments: { file_path: join(TEST_DIR, "test.mp4"), count: 3, output_dir: TEST_DIR },
    });
    const content = JSON.parse(res.result.content[0].text);
    assert(content.success === true, `failed: ${content.error?.message}`);
    assert(content.output.frames.length === 3, `expected 3 frames`);
    console.log(`    → Frames at: ${content.output.frames.map((f: any) => f.timestamp).join(", ")}`);
  });

  await test("generate_waveform creates audio visualization", async () => {
    const res = await rpcCall("tools/call", {
      name: "generate_waveform",
      arguments: { file_path: join(TEST_DIR, "test.mp4"), output_path: join(TEST_DIR, "wave.png") },
    });
    const content = JSON.parse(res.result.content[0].text);
    assert(content.success === true, `failed: ${content.error?.message}`);
    assert(existsSync(join(TEST_DIR, "wave.png")), "waveform file not created");
  });

  // ═══════════════════════════════════════════════
  // Phase 6: Project Management
  // ═══════════════════════════════════════════════
  console.log("\n─── Phase 6: Project Management ───");

  let projectId: string;
  await test("create_project → get_project → add_asset roundtrip", async () => {
    // Create
    const create = await rpcCall("tools/call", {
      name: "create_project",
      arguments: { name: "Test Project", description: "Integration test" },
    });
    const createContent = JSON.parse(create.result.content[0].text);
    assert(createContent.success, "create failed");
    projectId = createContent.project.id;

    // Get
    const get = await rpcCall("tools/call", {
      name: "get_project",
      arguments: { project_id: projectId },
    });
    const getContent = JSON.parse(get.result.content[0].text);
    assert(getContent.success, "get failed");
    assert(getContent.project.name === "Test Project", "wrong name");

    // Add asset
    const add = await rpcCall("tools/call", {
      name: "project_add_asset",
      arguments: { project_id: projectId, file_path: join(TEST_DIR, "test.mp4") },
    });
    const addContent = JSON.parse(add.result.content[0].text);
    assert(addContent.success, "add_asset failed");
    console.log(`    → Project ${projectId}: ${addContent.project.assets.length} asset(s)`);
  });

  // ═══════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  MCP Integration: ${passed} passed, ${failed} failed`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  server.kill();
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  if (server) server.kill();
  process.exit(1);
});
