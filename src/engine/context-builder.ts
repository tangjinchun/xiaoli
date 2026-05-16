/**
 * 上下文构建器 (L1)
 *
 * 在生成追问之前，先"看"项目结构和相关代码。
 * 输出 ProjectContext，注入到追问生成 Prompt 中，让追问更精准。
 *
 * 核心步骤:
 *   1. detectProjectType()   — 识别项目类型 (Node/Java/Python/多模块)
 *   2. analyzeTechStack()    — 读配置文件，提取技术栈
 *   3. buildDirectoryTree()  — 结构化目录树
 *   4. findRelevantFiles()   — 根据任务描述定位相关代码
 *   5. readKeyFiles()        — 读取关键文件前 N 行
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ───── 类型 ─────

export interface TechStack {
  runtime?: string;
  framework?: string;
  language: string;
  buildTool?: string;
  dependencies: Record<string, string>;  // 包名 → 版本
  devDependencies: Record<string, string>;
}

export interface CodeSnapshot {
  filePath: string;
  relevance: number;       // 0~1，与任务的相关度
  preview: string;         // 前 50 行
  lineCount: number;
}

export interface ProjectContext {
  projectType: string;             // "Node.js" | "Java/Maven" | "Python" | "Multi-module"
  techStack: TechStack;
  directoryTree: string;           // 缩进目录树
  relevantFiles: string[];         // 最相关的文件路径
  codeSnapshots: CodeSnapshot[];   // 关键文件快照
  fileCount: number;
  rootPath: string;
}

// ───── 主入口 ─────

export interface ContextBuilderConfig {
  rootPath?: string;
  maxTreeDepth?: number;
  maxSnapshots?: number;
  snapshotLines?: number;
}

const DEFAULT_CONFIG: Required<ContextBuilderConfig> = {
  rootPath: process.cwd(),
  maxTreeDepth: 3,
  maxSnapshots: 5,
  snapshotLines: 50,
};

/**
 * 构建项目上下文
 */
export function buildContext(
  taskDescription: string,
  config: ContextBuilderConfig = {}
): ProjectContext {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const root = cfg.rootPath;

  const projectType = detectProjectType(root);
  const techStack = analyzeTechStack(root, projectType);
  const directoryTree = buildDirectoryTree(root, cfg.maxTreeDepth);
  const relevantFiles = findRelevantFiles(root, taskDescription);
  const codeSnapshots = readKeyFiles(relevantFiles, cfg.maxSnapshots, cfg.snapshotLines);

  return {
    projectType,
    techStack,
    directoryTree,
    relevantFiles,
    codeSnapshots,
    fileCount: countFiles(root),
    rootPath: root,
  };
}

// ───── 项目类型检测 ─────

function detectProjectType(root: string): string {
  const files = listFiles(root, 1);

  const hasNodeJS = files.some((f) => f === "package.json");
  const hasJava = files.some((f) => f === "pom.xml" || f.endsWith(".gradle"));
  const hasPython = files.some(
    (f) => f === "requirements.txt" || f === "setup.py" || f === "pyproject.toml"
  );

  const types: string[] = [];
  if (hasNodeJS) types.push("Node.js");
  if (hasJava) types.push("Java");
  if (hasPython) types.push("Python");

  if (types.length === 0) {
    // 从源码目录推断
    const hasVue = exists(path.join(root, "src", "App.vue"));
    const hasReact = exists(path.join(root, "src", "App.tsx"));
    const hasGo = files.some((f) => f === "go.mod");

    if (hasVue) types.push("Vue.js");
    if (hasReact) types.push("React");
    if (hasGo) types.push("Go");
  }

  if (types.length === 0) return "Unknown";
  if (types.length === 1) return types[0];
  return types.join("/");
}

// ───── 技术栈分析 ─────

function analyzeTechStack(root: string, projectType: string): TechStack {
  const tech: TechStack = {
    language: projectType.split("/")[0],
    dependencies: {},
    devDependencies: {},
  };

  // package.json
  const pkgPath = path.join(root, "package.json");
  if (exists(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      tech.runtime = "Node.js";
      tech.dependencies = pkg.dependencies || {};
      tech.devDependencies = pkg.devDependencies || {};

      if (tech.dependencies["vue"]) {
        tech.framework = `Vue.js ${tech.dependencies["vue"]}`;
      } else if (tech.dependencies["react"]) {
        tech.framework = `React ${tech.dependencies["react"]}`;
      } else if (tech.dependencies["next"]) {
        tech.framework = `Next.js ${tech.dependencies["next"]}`;
      }
    } catch {
      // ignore
    }
  }

  // pom.xml
  const pomPath = path.join(root, "pom.xml");
  if (exists(pomPath)) {
    tech.runtime = "JVM";
    tech.buildTool = "Maven";
    try {
      const pom = fs.readFileSync(pomPath, "utf-8");
      const springBoot = pom.match(/spring-boot-starter-parent[^>]*>([^<]+)</);
      if (springBoot) tech.framework = `Spring Boot ${springBoot[1]}`;
    } catch {
      // ignore
    }
  }

  // requirements.txt
  const reqPath = path.join(root, "requirements.txt");
  if (exists(reqPath)) {
    tech.runtime = "Python";
    try {
      const reqs = fs.readFileSync(reqPath, "utf-8");
      for (const line of reqs.split("\n")) {
        const match = line.match(/^([a-zA-Z0-9_-]+)\s*[>=<]+\s*(.+)/);
        if (match) {
          tech.dependencies[match[1]] = match[2].trim();
        }
      }
    } catch {
      // ignore
    }
  }

  return tech;
}

// ───── 目录树 ─────

function buildDirectoryTree(root: string, maxDepth: number): string {
  const lines: string[] = [path.basename(root) + "/"];

  function walk(dir: string, prefix: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((e) => !shouldSkip(e));
    } catch {
      return;
    }

    entries.sort((a, b) => {
      const aIsDir = isDir(path.join(dir, a));
      const bIsDir = isDir(path.join(dir, b));
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    });

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const fullPath = path.join(dir, entry);
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const nextPrefix = prefix + (isLast ? "    " : "│   ");

      if (isDir(fullPath)) {
        const count = countFilesInDir(fullPath);
        lines.push(`${prefix}${connector}${entry}/ (${count} files)`);
        walk(fullPath, nextPrefix, depth + 1);
      } else {
        lines.push(`${prefix}${connector}${entry}`);
      }
    }
  }

  walk(root, "", 1);
  return lines.join("\n");
}

// ───── 相关文件定位 ─────

function findRelevantFiles(root: string, taskDescription: string): string[] {
  // 从任务描述中提取关键词
  const keywords = extractSearchKeywords(taskDescription);
  if (keywords.length === 0) return [];

  const results: { path: string; score: number }[] = [];
  const srcDir = findSourceDir(root);

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      if (shouldSkip(entry)) continue;

      if (isDir(fullPath)) {
        walk(fullPath);
      } else if (isCodeFile(entry)) {
        const score = scoreFile(fullPath, entry, keywords, taskDescription);
        if (score > 0) {
          results.push({ path: fullPath, score });
        }
      }
    }
  }

  if (srcDir) walk(srcDir);

  // 按相关度排序，取前 10 个
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 10).map((r) => r.path);
}

// ───── 代码快照 ─────

function readKeyFiles(
  filePaths: string[],
  maxSnapshots: number,
  maxLines: number
): CodeSnapshot[] {
  return filePaths.slice(0, maxSnapshots).map((filePath, i) => {
    const relevance = 1.0 - i * 0.1; // 按排序衰减
    let preview = "";
    let lineCount = 0;

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      lineCount = lines.length;
      preview = lines.slice(0, maxLines).join("\n");
    } catch {
      preview = "（无法读取）";
    }

    return {
      filePath,
      relevance,
      preview,
      lineCount,
    };
  });
}

// ───── 格式化输出 ─────

export function formatContextForPrompt(ctx: ProjectContext, maxSnapshotChars = 2000): string {
  const parts: string[] = [];

  parts.push(`**项目类型**: ${ctx.projectType}`);
  parts.push(`**技术栈**: ${ctx.techStack.framework || ctx.techStack.language} (${ctx.techStack.runtime || "unknown"})`);

  // 关键依赖（最多 10 个）
  const deps = Object.entries(ctx.techStack.dependencies);
  if (deps.length > 0) {
    const topDeps = deps.slice(0, 10).map(([k, v]) => `${k}@${v}`).join(", ");
    parts.push(`**关键依赖**: ${topDeps}${deps.length > 10 ? ` ...等 ${deps.length} 个` : ""}`);
  }

  parts.push(`**文件总数**: ${ctx.fileCount}`);

  // 目录树（截断）
  const treeLines = ctx.directoryTree.split("\n");
  const shortTree = treeLines.slice(0, 30).join("\n");
  parts.push(`\n**目录结构**:\n\`\`\`\n${shortTree}${treeLines.length > 30 ? "\n... (已截断)" : ""}\n\`\`\``);

  // 代码快照（控制总字符数）
  if (ctx.codeSnapshots.length > 0) {
    const snapLines: string[] = [];
    let charCount = 0;

    for (const snap of ctx.codeSnapshots) {
      snapLines.push(`\n### ${snap.filePath} (${snap.lineCount} 行)`);
      const preview = snap.preview.slice(0, maxSnapshotChars - charCount);
      snapLines.push("```\n" + preview + "\n```");
      charCount += preview.length + snap.filePath.length + 50;
      if (charCount >= maxSnapshotChars) break;
    }

    parts.push(`\n**关键代码快照**:${snapLines.join("\n")}`);
  }

  return parts.join("\n");
}

// ───── 辅助函数 ─────

function shouldSkip(name: string): boolean {
  const skipList = [
    "node_modules", ".git", ".svn", "dist", "build", ".next",
    "__pycache__", ".tox", ".venv", "venv", "target",
    ".DS_Store", "Thumbs.db", ".idea", ".vscode",
  ];
  return skipList.includes(name) || name.startsWith(".");
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function listFiles(dir: string, _depth: number): string[] {
  try {
    return fs.readdirSync(dir).filter((e) => !shouldSkip(e));
  } catch {
    return [];
  }
}

function countFiles(root: string): number {
  let count = 0;
  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (shouldSkip(entry)) continue;
      const full = path.join(dir, entry);
      if (isDir(full)) {
        walk(full);
      } else {
        count++;
      }
    }
  }
  walk(root);
  return count;
}

function countFilesInDir(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((e) => !shouldSkip(e)).length;
  } catch {
    return 0;
  }
}

function isCodeFile(name: string): boolean {
  const codeExts = [
    ".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte",
    ".java", ".kt", ".scala",
    ".py", ".pyx",
    ".go", ".rs", ".cpp", ".c", ".h",
    ".yaml", ".yml", ".json", ".xml",
    ".sql", ".sh", ".bash",
  ];
  return codeExts.some((ext) => name.endsWith(ext));
}

function findSourceDir(root: string): string | null {
  const candidates = ["src", "lib", "app", "pkg", "cmd"];
  for (const c of candidates) {
    const p = path.join(root, c);
    if (isDir(p)) return p;
  }
  return root; // 找不到就返回根目录
}

function extractSearchKeywords(task: string): string[] {
  // 提取有意义的词
  const words: string[] = [];

  // 中文词（连续 2+ 字）
  const chinese = task.match(/[\u4e00-\u9fff]{2,}/g) || [];
  words.push(...chinese);

  // 英文词（3+ 字母）
  const english = task.match(/[a-zA-Z]{3,}/g) || [];
  words.push(...english);

  // 技术关键词（驼峰/下划线命名）
  const techTerms = task.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
  words.push(...techTerms.filter((t) => t.length >= 3));

  // 去重 + 过滤泛词
  const stopWords = new Set([
    "优化", "修复", "开发", "实现", "添加", "删除", "修改",
    "需要", "可以", "应该", "可能", "这个", "那个", "如何",
    "and", "the", "for", "with", "that", "this", "from",
  ]);

  return Array.from(new Set(words.map((w) => w.toLowerCase()))).filter((w) => !stopWords.has(w));
}

function scoreFile(
  _fullPath: string,
  fileName: string,
  keywords: string[],
  taskDescription: string
): number {
  let score = 0;
  const fileLower = fileName.toLowerCase();
  const taskLower = taskDescription.toLowerCase();

  // 文件名关键词匹配
  for (const kw of keywords) {
    if (fileLower.includes(kw.toLowerCase())) {
      score += 2;
    }
  }

  // 任务描述中包含文件名片段
  const nameParts = fileLower.replace(/[._-]/g, " ").split(" ");
  for (const part of nameParts) {
    if (part.length >= 3 && taskLower.includes(part)) {
      score += 1;
    }
  }

  return score;
}
