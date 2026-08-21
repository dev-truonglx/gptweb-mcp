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
        
        let oldContent = "";
        try {
            oldContent = await fs.readFile(validPath, "utf-8");
        } catch (e) {
            oldContent = "";
        }
        
        const diff = generateLineDiff(oldContent, args.content);
        const addedCount = diff.filter(d => d.type === 'add').length;
        const delCount = diff.filter(d => d.type === 'del').length;
        
        await fs.writeFile(validPath, args.content, "utf-8");
        
        const diffData = {
            path: validPath,
            addedLines: addedCount,
            deletedLines: delCount,
            diffLines: diff.slice(0, 500)
        };
        
        let output = `Successfully wrote to ${validPath} (+${addedCount} / -${delCount} lines)\n`;
        output += `[DIFF_DATA]: ${JSON.stringify(diffData)}`;
        
        return { content: [{ type: "text", text: output }] };
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
        const { path: validPath, stats } = await validateExistingPath(args.directory);
        if (!stats.isDirectory()) {
            return { content: [{ type: "text", text: `Error: ${validPath} is a file, not a directory.` }], isError: true };
        }
        const entries = await fs.readdir(validPath, { recursive: true, withFileTypes: true });
        let matches = entries.map(e => {
            const relative = path.relative(validPath, path.join(e.parentPath || validPath, e.name));
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
        const ignoreList = ['node_modules', '.git', 'dist', '.next', 'build', '.DS_Store'];
        
        const treeStats = {
            totalFiles: 0,
            totalDirs: 0,
            totalBytes: 0,
            totalLines: 0,
            extensions: {}
        };

        async function traverse(currentPath, currentDepth, prefix = "") {
            if (currentDepth > depth) return "";
            
            let entries = [];
            try {
                entries = await fs.readdir(currentPath, { withFileTypes: true });
            } catch (err) {
                return prefix + "└── [Error reading directory]\n";
            }

            entries = entries.filter(e => !ignoreList.includes(e.name));
            
            entries.sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) return -1;
                if (!a.isDirectory() && b.isDirectory()) return 1;
                return a.name.localeCompare(b.name);
            });

            let treeStr = "";
            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];
                const isLast = i === entries.length - 1;
                const pointer = isLast ? "└── " : "├── ";
                const fullPath = path.join(currentPath, entry.name);

                if (entry.isDirectory()) {
                    treeStats.totalDirs++;
                    treeStr += prefix + pointer + entry.name + "/\n";
                    const newPrefix = prefix + (isLast ? "    " : "│   ");
                    treeStr += await traverse(fullPath, currentDepth + 1, newPrefix);
                } else {
                    treeStats.totalFiles++;
                    let fileSize = 0;
                    let lineCount = 0;

                    try {
                        const fStat = await fs.stat(fullPath);
                        fileSize = fStat.size;
                        treeStats.totalBytes += fileSize;

                        const ext = path.extname(entry.name).toLowerCase() || '[no ext]';
                        treeStats.extensions[ext] = (treeStats.extensions[ext] || 0) + 1;

                        const isBinary = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.exe', '.tar', '.gz'].includes(ext);
                        if (!isBinary && fileSize < 2 * 1024 * 1024) {
                            const content = await fs.readFile(fullPath, 'utf-8');
                            lineCount = content.split('\n').length;
                            treeStats.totalLines += lineCount;
                        }
                    } catch (e) {}

                    treeStr += prefix + pointer + entry.name + (lineCount > 0 ? ` (${lineCount} lines)` : "") + "\n";
                }
            }
            return treeStr;
        }

        const treeOutput = await traverse(validPath, 0, "");
        
        let summary = `[PROJECT TREE & CODE STATS]\n`;
        summary += `[PATH]: ${validPath}\n`;
        summary += `[SUMMARY]: ${treeStats.totalFiles} files, ${treeStats.totalDirs} folders, ${treeStats.totalLines} total lines of code (${(treeStats.totalBytes / 1024).toFixed(1)} KB)\n`;
        summary += `[FILE BREAKDOWN]: ${Object.entries(treeStats.extensions).map(([ext, count]) => `${ext}: ${count}`).join(', ')}\n\n`;
        summary += `[DIRECTORY TREE]:\n${path.basename(validPath)}/\n${treeOutput}`;

        return { content: [{ type: "text", text: summary.trim() }] };
    }
};

function generateLineDiff(oldText, newText) {
    const oldLines = (oldText || "").split('\n');
    const newLines = (newText || "").split('\n');
    
    const diff = [];
    let i = 0, j = 0;
    
    while (i < oldLines.length || j < newLines.length) {
        if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
            diff.push({ type: 'normal', oldNum: i + 1, newNum: j + 1, text: oldLines[i] });
            i++;
            j++;
        } else {
            let foundOld = -1;
            let foundNew = -1;
            
            for (let look = 1; look < 10; look++) {
                if (i + look < oldLines.length && j < newLines.length && oldLines[i + look] === newLines[j]) {
                    foundOld = i + look;
                    break;
                }
                if (j + look < newLines.length && i < oldLines.length && newLines[j + look] === oldLines[i]) {
                    foundNew = j + look;
                    break;
                }
            }
            
            if (foundOld !== -1) {
                while (i < foundOld) {
                    diff.push({ type: 'del', oldNum: i + 1, newNum: null, text: oldLines[i] });
                    i++;
                }
            } else if (foundNew !== -1) {
                while (j < foundNew) {
                    diff.push({ type: 'add', oldNum: null, newNum: j + 1, text: newLines[j] });
                    j++;
                }
            } else {
                if (i < oldLines.length) {
                    diff.push({ type: 'del', oldNum: i + 1, newNum: null, text: oldLines[i] });
                    i++;
                }
                if (j < newLines.length) {
                    diff.push({ type: 'add', oldNum: null, newNum: j + 1, text: newLines[j] });
                    j++;
                }
            }
        }
    }
    
    return diff;
}

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
                description: "List files and subfolders in a folder or directory",
                parameters: { path: "Path to directory" },
                example: '{"mcp_tool_call": true, "tool": "list_directory", "args": {"path": "C:\\\\Users\\\\..."}}'
            },
            {
                name: "read_file",
                sensitive: false,
                description: "Read the complete text content of a specific file",
                parameters: { path: "Path to file" },
                example: '{"mcp_tool_call": true, "tool": "read_file", "args": {"path": "C:\\\\path\\\\to\\\\file.txt"}}'
            },
            {
                name: "write_file",
                sensitive: true,
                description: "Write or overwrite content in a file",
                parameters: { path: "Path to file", content: "Content string" },
                example: '{"mcp_tool_call": true, "tool": "write_file", "args": {"path": "C:\\\\path\\\\to\\\\file.txt", "content": "..."}}'
            },
            {
                name: "execute_command",
                sensitive: true,
                description: "Execute a shell terminal command (e.g. git status, npm test, python, etc.)",
                parameters: { command: "Command string to run", cwd: "Optional working directory" },
                example: '{"mcp_tool_call": true, "tool": "execute_command", "args": {"command": "git status"}}'
            },
            {
                name: "delete_file",
                sensitive: true,
                description: "Delete a file or directory",
                parameters: { path: "Path to file or folder to delete" },
                example: '{"mcp_tool_call": true, "tool": "delete_file", "args": {"path": "C:\\\\path\\\\to\\\\file.tmp"}}'
            },
            {
                name: "create_directory",
                sensitive: true,
                description: "Create a new directory (creates parent folders recursively if needed)",
                parameters: { path: "Path to directory to create" },
                example: '{"mcp_tool_call": true, "tool": "create_directory", "args": {"path": "C:\\\\path\\\\to\\\\folder"}}'
            },
            {
                name: "move_file",
                sensitive: true,
                description: "Move or rename a file or directory",
                parameters: { source: "Source path", destination: "Destination path" },
                example: '{"mcp_tool_call": true, "tool": "move_file", "args": {"source": "C:\\\\old.txt", "destination": "C:\\\\new.txt"}}'
            },
            {
                name: "search_files",
                sensitive: false,
                description: "Search for files and folders inside a directory matching a pattern",
                parameters: { directory: "Path to directory to search", pattern: "Optional glob pattern like *.js" },
                example: '{"mcp_tool_call": true, "tool": "search_files", "args": {"directory": "C:\\\\Users\\\\...", "pattern": "*.js"}}'
            },
            {
                name: "get_file_info",
                sensitive: false,
                description: "Get file or directory metadata (size, created/modified time, type)",
                parameters: { path: "Path to file or directory" },
                example: '{"mcp_tool_call": true, "tool": "get_file_info", "args": {"path": "C:\\\\path\\\\to\\\\file.txt"}}'
            },
            {
                name: "fetch_url",
                sensitive: false,
                description: "Fetch web page content or HTML/text from a URL and convert to clean text",
                parameters: { url: "URL to fetch", raw: "Optional boolean for raw HTML" },
                example: '{"mcp_tool_call": true, "tool": "fetch_url", "args": {"url": "http://localhost:3000"}}'
            },
            {
                name: "http_request",
                sensitive: true,
                description: "Send HTTP API requests (GET, POST, PUT, DELETE, PATCH) with headers and JSON body to test APIs",
                parameters: { url: "Target API URL", method: "GET/POST/PUT/DELETE", headers: "Object of headers", body: "Request body object or string" },
                example: '{"mcp_tool_call": true, "tool": "http_request", "args": {"url": "http://localhost:8889/health", "method": "GET"}}'
            },
            {
                name: "google_search",
                sensitive: false,
                description: "Search Google/web for a query keyword and return top search result titles, URLs, and snippets",
                parameters: { query: "Search query keyword", count: "Optional number of top results (default 5)" },
                example: '{"mcp_tool_call": true, "tool": "google_search", "args": {"query": "phimmoi", "count": 5}}'
            },
            {
                name: "web_search",
                sensitive: false,
                description: "Search the web for a query keyword (alias for google_search)",
                parameters: { query: "Search query keyword", count: "Optional number of top results (default 5)" },
                example: '{"mcp_tool_call": true, "tool": "web_search", "args": {"query": "phimmoi", "count": 5}}'
            },
            {
                name: "read_image",
                sensitive: false,
                description: "Read a local image file (.png, .jpg, .jpeg, .gif, .webp, .svg) and return Base64 Data URL for preview and visual inspection",
                parameters: { path: "Path to image file" },
                example: '{"mcp_tool_call": true, "tool": "read_image", "args": {"path": "C:\\\\path\\\\to\\\\image.png"}}'
            },
            {
                name: "get_project_tree",
                sensitive: false,
                description: "Generate a clean ASCII directory tree and project code statistics (file count, total LOC lines of code, file types breakdown)",
                parameters: { path: "Path to project directory", depth: "Optional max depth (default 4)" },
                example: '{"mcp_tool_call": true, "tool": "get_project_tree", "args": {"path": "C:\\\\path\\\\to\\\\project"}}'
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

