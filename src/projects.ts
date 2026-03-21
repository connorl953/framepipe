import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";

// Generate nanoid-style short IDs
function generateId(): string {
  return randomBytes(6).toString("hex");
}

export interface HistoryEntry {
  id: string;
  timestamp: string;
  operation: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

export interface Asset {
  id: string;
  file_path: string;
  imported_at: string;
  file_type: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
  assets: Asset[];
  history: HistoryEntry[];
}

export class ProjectManager {
  private projects: Map<string, Project> = new Map();
  private projectsDir: string;

  constructor(projectsDir?: string) {
    this.projectsDir = projectsDir || path.join(process.cwd(), "projects");
    this.ensureProjectsDir();
    this.loadAllProjects();
  }

  private ensureProjectsDir(): void {
    if (!fs.existsSync(this.projectsDir)) {
      fs.mkdirSync(this.projectsDir, { recursive: true });
    }
  }

  private getProjectDir(projectId: string): string {
    return path.join(this.projectsDir, projectId);
  }

  private getProjectAssetsDir(projectId: string): string {
    return path.join(this.getProjectDir(projectId), "assets");
  }

  private getProjectMetadataPath(projectId: string): string {
    return path.join(this.getProjectDir(projectId), "project.json");
  }

  /**
   * Persist a single project's metadata to disk as JSON.
   */
  private saveProject(project: Project): void {
    const metaPath = this.getProjectMetadataPath(project.id);
    fs.writeFileSync(metaPath, JSON.stringify(project, null, 2), "utf-8");
  }

  /**
   * Load all projects from disk on startup.
   * Each project directory contains a project.json with the full metadata.
   */
  private loadAllProjects(): void {
    if (!fs.existsSync(this.projectsDir)) return;

    const entries = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const metaPath = path.join(this.projectsDir, entry.name, "project.json");
      if (!fs.existsSync(metaPath)) continue;

      try {
        const raw = fs.readFileSync(metaPath, "utf-8");
        const project: Project = JSON.parse(raw);
        this.projects.set(project.id, project);
      } catch {
        // Corrupted metadata — skip silently
      }
    }
  }

  createProject(name: string, description?: string): Project {
    const id = generateId();
    const now = new Date().toISOString();

    const project: Project = {
      id,
      name,
      description,
      created_at: now,
      updated_at: now,
      assets: [],
      history: [],
    };

    // Create project directory structure
    const projectDir = this.getProjectDir(id);
    const assetsDir = this.getProjectAssetsDir(id);

    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });

    this.projects.set(id, project);
    this.saveProject(project);

    return project;
  }

  getProject(id: string): Project | null {
    return this.projects.get(id) || null;
  }

  addAsset(projectId: string, filePath: string): void {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project with id ${projectId} not found`);
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const assetId = generateId();
    const fileName = path.basename(filePath);
    const assetDestPath = path.join(this.getProjectAssetsDir(projectId), fileName);

    // Copy file to project assets directory
    fs.copyFileSync(filePath, assetDestPath);

    const fileExt = path.extname(filePath).toLowerCase();
    const asset: Asset = {
      id: assetId,
      file_path: assetDestPath,
      imported_at: new Date().toISOString(),
      file_type: fileExt.replace(".", "") || "unknown",
    };

    project.assets.push(asset);
    project.updated_at = new Date().toISOString();
    this.saveProject(project);
  }

  addHistoryEntry(
    projectId: string,
    operation: string,
    input: Record<string, unknown>,
    output: Record<string, unknown>
  ): void {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project with id ${projectId} not found`);
    }

    const entry: HistoryEntry = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      operation,
      input,
      output,
    };

    project.history.push(entry);
    project.updated_at = new Date().toISOString();
    this.saveProject(project);
  }

  getHistory(projectId: string): HistoryEntry[] {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project with id ${projectId} not found`);
    }

    return project.history;
  }
}
