import express from 'express';
import cors from 'cors';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";

let allowedDirectories = [process.cwd(), os.homedir(), path.resolve(os.homedir(), "Desktop")];

function normalizeAllowedPath(p) {
    if (!p) return "";
    let expanded = p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : path.resolve(p);
    return expanded.replace(/\\/g, '/');
}

async function validatePath(requestedPath) {
    const expandedPath = requestedPath.startsWith('~/') 
        ? path.join(os.homedir(), requestedPath.slice(2))
        : path.resolve(requestedPath);
        
    const normalizedTarget = expandedPath.replace(/\\/g, '/');
    
    const isAllowed = allowedDirectories.some(dir => {
        const normalizedDir = normalizeAllowedPath(dir);
        return normalizedTarget === normalizedDir || normalizedTarget.startsWith(normalizedDir.endsWith('/') ? normalizedDir : normalizedDir + '/');
    });

    if (!isAllowed) {
        throw new Error(`Access denied: "${expandedPath}" is not within allowed directories.`);
    }
    
    return expandedPath;
}

async function validateExistingPath(requestedPath) {
    const expandedPath = await validatePath(requestedPath);
    try {
        const stats = await fs.stat(expandedPath);
        return { path: expandedPath, stats };
    } catch (error) {
        throw new Error(`Path does not exist: ${expandedPath}`);
    }
}

const server = new McpServer({
  name: "chatgpt-local-filesystem",
  version: "1.0.0"
});

const tools = {
    list_directory: async (args) => {
        const { path: validPath, stats } = await validateExistingPath(args.path);
        if (!stats.isDirectory()) {
            return { content: [{ type: "text", text: `Error: ${validPath} is a file, not a directory. To read file content, call tool "read_file" with {"path": "${validPath}"}.` }] };
        }
        const entries = await fs.readdir(validPath, { withFileTypes: true });
        const list = entries.map(entry => `${entry.isDirectory() ? '[DIR]' : '[FILE]'} ${entry.name}`).join('\n');
        return { content: [{ type: "text", text: `Contents of ${validPath}:\n${list}` }] };
    },
    read_file: async (args) => {
        const { path: validPath, stats } = await validateExistingPath(args.path);
        if (!stats.isFile()) {
            return { content: [{ type: "text", text: `Error: ${validPath} is a directory, not a file. To list files and subfolders in this directory, call tool "list_directory" with {"path": "${validPath}"}.` }] };
        }
        const content = await fs.readFile(validPath, "utf-8");
        return { content: [{ type: "text", text: content }] };
    },
    write_file: async (args) => {
        const validPath = await validatePath(args.path);
        const dir = path.dirname(validPath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(validPath, args.content, "utf-8");
        return { content: [{ type: "text", text: `Successfully wrote to ${validPath}` }] };
    },
    execute_command: async (args) => {
        const targetCwd = args.cwd ? await validatePath(args.cwd) : process.cwd();
        return new Promise((resolve) => {
            exec(args.command, { cwd: targetCwd, timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                let output = "";
                if (stdout) output += `[STDOUT]\n${stdout}\n`;
                if (stderr) output += `[STDERR]\n${stderr}\n`;
                if (error) output += `[EXIT CODE]: ${error.code || 1}\n[ERROR]: ${error.message}`;
                else output += `[EXIT CODE]: 0 (Success)`;
                resolve({ content: [{ type: "text", text: output.trim() }] });
            });
        });
    },
    delete_file: async (args) => {
        const { path: validPath, stats } = await validateExistingPath(args.path);
        if (stats.isDirectory()) {
            await fs.rm(validPath, { recursive: true, force: true });
            return { content: [{ type: "text", text: `Successfully deleted directory ${validPath}` }] };
        } else {
            await fs.unlink(validPath);
            return { content: [{ type: "text", text: `Successfully deleted file ${validPath}` }] };
        }
    },
    create_directory: async (args) => {
        const validPath = await validatePath(args.path);
        await fs.mkdir(validPath, { recursive: true });
        return { content: [{ type: "text", text: `Successfully created directory ${validPath}` }] };
    },
    move_file: async (args) => {
        const validSource = (await validateExistingPath(args.source)).path;
        const validDest = await validatePath(args.destination);
        const destDir = path.dirname(validDest);
        await fs.mkdir(destDir, { recursive: true });
        await fs.rename(validSource, validDest);
        return { content: [{ type: "text", text: `Successfully moved ${validSource} to ${validDest}` }] };
    },
    search_files: async (args) => {
        const targetPath = args.path || args.directory;
        if (!targetPath) {
            throw new Error("Parameter 'path' or 'directory' is required for search_files.");
        }
        const { path: validPath, stats } = await validateExistingPath(targetPath);
        if (!stats.isDirectory()) {
            return { content: [{ type: "text", text: `Error: ${validPath} is a file, not a directory.` }], isError: true };
        }
        const entries = await fs.readdir(validPath, { recursive: true, withFileTypes: true });
        let matches = entries.map(e => {
            const parent = e.parentPath || e.path || validPath;
            const relative = path.relative(validPath, path.join(parent, e.name));
            return `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${relative}`;
        });
        if (args.pattern) {
            const cleanPattern = args.pattern.replace(/\*/g, '.*');
            const regex = new RegExp(cleanPattern, 'i');
            matches = matches.filter(m => regex.test(m));
        }
        return { content: [{ type: "text", text: `Found ${matches.length} entries in ${validPath}:\n${matches.slice(0, 100).join('\n')}` }] };
    },
    get_file_info: async (args) => {
        const { path: validPath, stats } = await validateExistingPath(args.path);
        const info = {
            path: validPath,
            type: stats.isDirectory() ? 'directory' : (stats.isFile() ? 'file' : 'other'),
            sizeBytes: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
            accessed: stats.atime
        };
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    },
    fetch_url: async (args) => {
        if (!args.url) throw new Error("URL parameter is required.");
        const response = await fetch(args.url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (MCP Bridge Web Fetcher)' }
        });
        const text = await response.text();
        if (args.raw) {
            return { content: [{ type: "text", text: `[HTTP Status ${response.status}]\n${text.slice(0, 20000)}` }] };
        }
        const cleanedText = htmlToText(text);
        return { content: [{ type: "text", text: `[HTTP Status ${response.status} URL: ${args.url}]\n${cleanedText.slice(0, 15000)}` }] };
    },
    http_request: async (args) => {
        if (!args.url) throw new Error("URL parameter is required.");
        const method = (args.method || 'GET').toUpperCase();
        const headers = args.headers || {};
        let body = undefined;
        
        if (args.body) {
            if (typeof args.body === 'object') {
                body = JSON.stringify(args.body);
                if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
            } else {
                body = String(args.body);
            }
        }
        
        const response = await fetch(args.url, { method, headers, body });
        const resText = await response.text();
        
        let output = `[HTTP RESPONSE ${response.status} ${response.statusText}]\n`;
        output += `[URL]: ${args.url}\n`;
        output += `[METHOD]: ${method}\n\n`;
        output += `[BODY]:\n${resText.slice(0, 15000)}`;
        
        return { content: [{ type: "text", text: output }] };
    },
    google_search: async (args) => {
        if (!args.query) throw new Error("Search query parameter is required.");
        const count = args.count ? parseInt(args.count, 10) : 5;
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0"
            }
        });
        const html = await res.text();
        const results = [];

        const linkRegex = /<a\b[^>]*class=["']result__a["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        const snippetRegex = /<(?:a|td)\b[^>]*class=["']result__snippet["'][^>]*>([\s\S]*?)<\/(?:a|td)>/gi;

        const titlesAndLinks = [];
        let tm;
        while ((tm = linkRegex.exec(html)) !== null) {
            let rawUrl = tm[1];
            if (rawUrl.includes("uddg=")) {
                const um = rawUrl.match(/uddg=([^&]+)/);
                if (um) rawUrl = decodeURIComponent(um[1]);
            }
            const title = tm[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
            titlesAndLinks.push({ title, url: rawUrl });
        }

        const snippets = [];
        let sm;
        while ((sm = snippetRegex.exec(html)) !== null) {
            let snip = (sm[1] || sm[2] || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
            snippets.push(snip);
        }

        for (let i = 0; i < Math.min(titlesAndLinks.length, count); i++) {
            results.push({
                rank: i + 1,
                title: titlesAndLinks[i].title,
                url: titlesAndLinks[i].url,
                snippet: snippets[i] || ""
            });
        }

        let output = `[SEARCH RESULTS FOR QUERY: "${args.query}" (Top ${results.length})]\n\n`;
        results.forEach(r => {
            output += `${r.rank}. ${r.title}\n   URL: ${r.url}\n   Snippet: ${r.snippet}\n\n`;
        });

        return { content: [{ type: "text", text: output.trim() }] };
    },
    web_search: async (args) => {
        return tools.google_search(args);
    },
    read_image: async (args) => {
        const { path: validPath, stats } = await validateExistingPath(args.path);
        if (!stats.isFile()) {
            throw new Error(`Path is not a file: ${validPath}`);
        }
        
        const ext = path.extname(validPath).toLowerCase();
        const mimeTypes = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml'
        };
        
        const mimeType = mimeTypes[ext] || 'application/octet-stream';
        const imageBuffer = await fs.readFile(validPath);
        const base64Data = imageBuffer.toString('base64');
        const dataUrl = `data:${mimeType};base64,${base64Data}`;
        
        let output = `[IMAGE PREVIEW DATA]\n`;
        output += `[PATH]: ${validPath}\n`;
        output += `[MIME]: ${mimeType}\n`;
        output += `[SIZE]: ${stats.size} bytes\n`;
        output += `[FULL_DATA_URL]: ${dataUrl}`;
        
        return { content: [{ type: "text", text: output }] };
    },
    get_project_tree: async (args) => {
        const { path: validPath, stats } = await validateExistingPath(args.path);
        if (!stats.isDirectory()) {
            throw new Error(`Path is not a directory: ${validPath}`);
        }
        
        const depth = args.depth ? parseInt(args.depth, 10) : 4;
        const IGNORE_PATTERNS = new Set([
            'node_modules', '.git', 'dist', '.next', 'build', '.build', 'DerivedData',
            'vendor', 'coverage', '.cache', '.venv', 'venv', 'out', 'target', 'bin',
            'obj', '.idea', '.vscode', '.output', '.nuxt', '.svelte-kit', '.DS_Store',
            'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'composer.lock'
        ]);

        const CODE_EXTENSIONS = new Set([
            '.js', '.jsx', '.ts', '.tsx', '.json', '.html', '.css', '.scss', '.less',
            '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.go', '.rs', '.php', '.rb',
            '.vue', '.svelte', '.md', '.sql', '.sh', '.yaml', '.yml', '.toml', '.xml',
            '.swift', '.m', '.mm', '.kt', '.dart'
        ]);

        const startTime = Date.now();
        const treeStats = {
            totalFiles: 0,
            totalDirs: 0,
            totalBytes: 0,
            totalLines: 0,
            extensions: {}
        };

        let totalTreeLines = 0;
        const MAX_TREE_LINES = 250;
        let truncated = false;

        async function traverse(currentPath, currentDepth, prefix = "") {
            if (currentDepth > depth || totalTreeLines >= MAX_TREE_LINES) return "";
            
            let entries = [];
            try {
                entries = await fs.readdir(currentPath, { withFileTypes: true });
            } catch (err) {
                return prefix + "└── [Error reading directory]\n";
            }

            entries = entries.filter(e => !IGNORE_PATTERNS.has(e.name));
            
            entries.sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) return -1;
                if (!a.isDirectory() && b.isDirectory()) return 1;
                return a.name.localeCompare(b.name);
            });

            const entryData = await Promise.all(entries.map(async (entry) => {
                const fullPath = path.join(currentPath, entry.name);
                if (entry.isDirectory()) {
                    return { entry, fullPath, isDir: true };
                } else {
                    let fileSize = 0;
                    let lineCount = 0;
                    const ext = path.extname(entry.name).toLowerCase() || '[no ext]';
                    try {
                        const fStat = await fs.stat(fullPath);
                        fileSize = fStat.size;
                        
                        if (CODE_EXTENSIONS.has(ext) && fileSize < 500 * 1024) {
                            const content = await fs.readFile(fullPath, 'utf-8');
                            let count = 1;
                            for (let k = 0; k < content.length; k++) {
                                if (content[k] === '\n') count++;
                            }
                            lineCount = count;
                        }
                    } catch (e) {}
                    return { entry, fullPath, isDir: false, fileSize, lineCount, ext };
                }
            }));

            let treeStr = "";
            for (let i = 0; i < entryData.length; i++) {
                if (totalTreeLines >= MAX_TREE_LINES) {
                    if (!truncated) {
                        treeStr += prefix + "└── ... [Tree output truncated due to large folder size]\n";
                        truncated = true;
                    }
                    break;
                }

                const item = entryData[i];
                const isLast = i === entryData.length - 1;
                const pointer = isLast ? "└── " : "├── ";

                if (item.isDir) {
                    treeStats.totalDirs++;
                    totalTreeLines++;
                    treeStr += prefix + pointer + item.entry.name + "/\n";
                    const newPrefix = prefix + (isLast ? "    " : "│   ");
                    treeStr += await traverse(item.fullPath, currentDepth + 1, newPrefix);
                } else {
                    treeStats.totalFiles++;
                    treeStats.totalBytes += item.fileSize;
                    treeStats.totalLines += item.lineCount;
                    treeStats.extensions[item.ext] = (treeStats.extensions[item.ext] || 0) + 1;
                    totalTreeLines++;

                    treeStr += prefix + pointer + item.entry.name + (item.lineCount > 0 ? ` (${item.lineCount} lines)` : "") + "\n";
                }
            }
            return treeStr;
        }

        const treeOutput = await traverse(validPath, 0, "");
        const duration = Date.now() - startTime;
        
        let summary = `[PROJECT TREE & CODE STATS]\n`;
        summary += `[PATH]: ${validPath}\n`;
        summary += `[SUMMARY]: ${treeStats.totalFiles} files, ${treeStats.totalDirs} folders, ${treeStats.totalLines} total lines of code (${(treeStats.totalBytes / 1024).toFixed(1)} KB) - computed in ${duration}ms\n`;
        summary += `[FILE BREAKDOWN]: ${Object.entries(treeStats.extensions).map(([ext, count]) => `${ext}: ${count}`).join(', ')}\n\n`;
        summary += `[DIRECTORY TREE]:\n${path.basename(validPath)}/\n${treeOutput}`;

        return { content: [{ type: "text", text: summary.trim() }] };
    }
};

function htmlToText(html) {
    if (!html) return "";
    return html
        .replace(/<script\b[^<]*>([\s\S]*?)<\/script>/gi, '')
        .replace(/<style\b[^<]*>([\s\S]*?)<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getTimestamp() {
    return new Date().toLocaleTimeString('vi-VN', { hour12: false }) + '.' + String(new Date().getMilliseconds()).padStart(3, '0');
}

function logToolCall(tool, args) {
    console.log(`\n[${getTimestamp()}] 📥 [TOOL CALL RECEIVED] Tool: "${tool}"`);
    if (args && Object.keys(args).length > 0) {
        console.log(`[${getTimestamp()}] 📄 [ARGUMENTS]:`, JSON.stringify(args, null, 2));
    }
}

function logToolSuccess(tool, durationMs) {
    console.log(`[${getTimestamp()}] ✅ [TOOL SUCCESS] Tool: "${tool}" finished in ${durationMs}ms`);
}

function logToolError(tool, errorMsg) {
    console.error(`[${getTimestamp()}] ❌ [TOOL ERROR] Tool: "${tool}" failed: ${errorMsg}`);
}

server.tool("read_file",
  "Read the complete contents of a file from the local filesystem",
  { path: z.string().describe("Path to the file to read") },
  async (args) => {
      const startTime = Date.now();
      logToolCall("read_file", args);
      try {
          const res = await tools.read_file(args);
          if (res.isError) {
              logToolError("read_file", res.content[0]?.text);
          } else {
              logToolSuccess("read_file", Date.now() - startTime);
          }
          return res;
      } catch (error) {
          logToolError("read_file", error.message);
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
  }
);

server.tool("list_directory",
  "List files and directories in a local folder",
  { path: z.string().describe("Path to the directory to list") },
  async (args) => {
      const startTime = Date.now();
      logToolCall("list_directory", args);
      try {
          const res = await tools.list_directory(args);
          if (res.isError) {
              logToolError("list_directory", res.content[0]?.text);
          } else {
              logToolSuccess("list_directory", Date.now() - startTime);
          }
          return res;
      } catch (error) {
          logToolError("list_directory", error.message);
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
  }
);

server.tool("write_file",
  "Write or overwrite a file with new content",
  { 
      path: z.string().describe("Path to the file to write"),
      content: z.string().describe("Content to write to the file")
  },
  async (args) => {
      const startTime = Date.now();
      logToolCall("write_file", args);
      try {
          const res = await tools.write_file(args);
          if (res.isError) {
              logToolError("write_file", res.content[0]?.text);
          } else {
              logToolSuccess("write_file", Date.now() - startTime);
          }
          return res;
      } catch (error) {
          logToolError("write_file", error.message);
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
  }
);

const app = express();
app.use(cors());
app.use(express.json({limit: '50mb'}));

app.get("/health", (req, res) => {
    res.json({ status: "ok", version: "1.0.0" });
});

app.get("/config", (req, res) => {
    res.json({
        status: "ok",
        allowedDirectories
    });
});

app.post("/config", (req, res) => {
    const { allowedDirectories: newDirs } = req.body;
    if (Array.isArray(newDirs)) {
        allowedDirectories = newDirs.filter(d => typeof d === 'string' && d.trim() !== '');
        console.log(`[${getTimestamp()}] 📁 [CONFIG UPDATED] Allowed directories updated:`, allowedDirectories);
        return res.json({ status: "ok", allowedDirectories });
    }
    res.status(400).json({ status: "error", message: "Invalid allowedDirectories array" });
});

app.get("/tools", (req, res) => {
    res.json({
        status: "ok",
        tools: [
            {
                name: "list_directory",
                sensitive: false,
                description: "List files and subfolders in a folder or directory (e.g. liệt kê file, xem thư mục, danh sách tệp, show folder, cây thư mục)",
                parameters: { path: "Path to directory" },
                example: '{"tool": "list_directory", "args": {"path": "/path/to/directory"}}'
            },
            {
                name: "read_file",
                sensitive: false,
                description: "Read the complete text content of a specific file (e.g. đọc file, xem nội dung file, mở file, kiểm tra file)",
                parameters: { path: "Path to file" },
                example: '{"tool": "read_file", "args": {"path": "/path/to/file.txt"}}'
            },
            {
                name: "write_file",
                sensitive: true,
                description: "Write or overwrite content in a file (e.g. ghi file, tạo file, lưu file, sửa file, cập nhật file, xuất file)",
                parameters: { path: "Path to file", content: "Content string" },
                example: '{"tool": "write_file", "args": {"path": "/path/to/file.txt", "content": "..."}}'
            },
            {
                name: "execute_command",
                sensitive: true,
                description: "Execute a shell terminal command (e.g. chạy lệnh terminal, thực thi lệnh, npm test, git status, build)",
                parameters: { command: "Command string to run", cwd: "Optional working directory" },
                example: '{"tool": "execute_command", "args": {"command": "git status"}}'
            },
            {
                name: "delete_file",
                sensitive: true,
                description: "Delete a file or directory (e.g. xóa file, xóa thư mục, gỡ bỏ file, dọn dẹp file rác)",
                parameters: { path: "Path to file or folder to delete" },
                example: '{"tool": "delete_file", "args": {"path": "/path/to/file.tmp"}}'
            },
            {
                name: "create_directory",
                sensitive: true,
                description: "Create a new directory (e.g. tạo folder, tạo thư mục, tạo danh mục mới, mkdir)",
                parameters: { path: "Path to directory to create" },
                example: '{"tool": "create_directory", "args": {"path": "/path/to/folder"}}'
            },
            {
                name: "move_file",
                sensitive: true,
                description: "Move, transfer, organize, categorize, or rename a file or directory (e.g. di chuyển file, chuyển file vào folder, dọn dẹp file, phân loại file, đổi tên file)",
                parameters: { source: "Source path of file or directory", destination: "Destination path of file or directory" },
                example: '{"tool": "move_file", "args": {"source": "/path/to/source.txt", "destination": "/path/to/destination.txt"}}'
            },
            {
                name: "search_files",
                sensitive: false,
                description: "Search for files and folders inside a directory matching a pattern (e.g. tìm kiếm file, tìm file theo tên, tìm đuôi .js, tra cứu file)",
                parameters: { directory: "Path to directory to search", pattern: "Optional glob pattern like *.js" },
                example: '{"tool": "search_files", "args": {"directory": "/path/to/directory", "pattern": "*.js"}}'
            },
            {
                name: "get_file_info",
                sensitive: false,
                description: "Get file or directory metadata (e.g. xem thông tin file, kiểm tra dung lượng file, xem ngày tạo, kích thước file)",
                parameters: { path: "Path to file or directory" },
                example: '{"tool": "get_file_info", "args": {"path": "/path/to/file.txt"}}'
            },
            {
                name: "fetch_url",
                sensitive: false,
                description: "Fetch web page content or HTML/text from a URL (e.g. đọc trang web, truy cập URL, lấy nội dung web, xem website)",
                parameters: { url: "URL to fetch", raw: "Optional boolean for raw HTML" },
                example: '{"tool": "fetch_url", "args": {"url": "http://localhost:3000"}}'
            },
            {
                name: "http_request",
                sensitive: true,
                description: "Send HTTP API requests (GET, POST, PUT, DELETE, PATCH) (e.g. gửi request API, test API, gọi REST API)",
                parameters: { url: "Target API URL", method: "GET/POST/PUT/DELETE", headers: "Object of headers", body: "Request body object or string" },
                example: '{"tool": "http_request", "args": {"url": "http://localhost:8889/health", "method": "GET"}}'
            },
            {
                name: "google_search",
                sensitive: false,
                description: "Search Google/web for a query keyword (e.g. tìm kiếm google, search web, tra cứu thông tin, tìm trên mạng)",
                parameters: { query: "Search query keyword", count: "Optional number of top results (default 5)" },
                example: '{"tool": "google_search", "args": {"query": "phimmoi", "count": 5}}'
            },
            {
                name: "web_search",
                sensitive: false,
                description: "Search the web for a query keyword (alias for google_search)",
                parameters: { query: "Search query keyword", count: "Optional number of top results (default 5)" },
                example: '{"tool": "web_search", "args": {"query": "phimmoi", "count": 5}}'
            },
            {
                name: "read_image",
                sensitive: false,
                description: "Read a local image file (.png, .jpg, .svg) and return Base64 Data URL (e.g. xem hình ảnh, đọc ảnh, hiển thị ảnh)",
                parameters: { path: "Path to image file" },
                example: '{"tool": "read_image", "args": {"path": "/path/to/image.png"}}'
            },
            {
                name: "get_project_tree",
                sensitive: false,
                description: "Generate a clean directory tree and project code statistics (e.g. sơ đồ dự án, cây thư mục dự án, cấu trúc codebase, thống kê dự án)",
                parameters: { path: "Path to project directory", depth: "Optional max depth (default 4)" },
                example: '{"tool": "get_project_tree", "args": {"path": "/path/to/project"}}'
            }
        ]
    });
});

let transport = null;
app.get("/sse", async (req, res) => {
    console.log(`[${getTimestamp()}] 🔌 [SSE CONNECTED] Client connected to SSE stream`);
    transport = new SSEServerTransport("/messages", res);
    await server.connect(transport);
});

app.post("/messages", async (req, res) => {
    if (transport) {
        await transport.handlePostMessage(req, res);
    } else {
        res.status(400).send("SSE connection not established");
    }
});

app.post("/call-tool", async (req, res) => {
    const { tool, args } = req.body;
    const startTime = Date.now();
    logToolCall(tool, args);

    try {
        if (!tools[tool]) {
            const errMsg = `Tool ${tool} not found`;
            logToolError(tool, errMsg);
            return res.status(404).json({ content: [{ type: "text", text: errMsg }], isError: true });
        }
        const result = await tools[tool](args);
        const duration = Date.now() - startTime;
        if (result.isError) {
            logToolError(tool, result.content?.[0]?.text || 'Execution error');
        } else {
            logToolSuccess(tool, duration);
        }
        res.json(result);
    } catch (error) {
        logToolError(tool, error.message);
        res.json({ content: [{ type: "text", text: `Error: ${error.message}` }], isError: true });
    }
});

const PORT = 8889;
app.listen(PORT, () => {
    console.log(`🚀 Local MCP Filesystem Server running on port ${PORT}`);
});

