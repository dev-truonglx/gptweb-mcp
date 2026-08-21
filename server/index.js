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
    }
};

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
                description: "List files and subfolders in a folder or directory",
                parameters: { path: "Path to directory" },
                example: '{"mcp_tool_call": true, "tool": "list_directory", "args": {"path": "C:\\\\Users\\\\..."}}'
            },
            {
                name: "read_file",
                description: "Read the complete text content of a specific file",
                parameters: { path: "Path to file" },
                example: '{"mcp_tool_call": true, "tool": "read_file", "args": {"path": "C:\\\\path\\\\to\\\\file.txt"}}'
            },
            {
                name: "write_file",
                description: "Write or overwrite content in a file",
                parameters: { path: "Path to file", content: "Content string" },
                example: '{"mcp_tool_call": true, "tool": "write_file", "args": {"path": "C:\\\\path\\\\to\\\\file.txt", "content": "..."}}'
            },
            {
                name: "execute_command",
                description: "Execute a shell terminal command (e.g. git status, npm test, python, etc.)",
                parameters: { command: "Command string to run", cwd: "Optional working directory" },
                example: '{"mcp_tool_call": true, "tool": "execute_command", "args": {"command": "git status"}}'
            },
            {
                name: "delete_file",
                description: "Delete a file or directory",
                parameters: { path: "Path to file or folder to delete" },
                example: '{"mcp_tool_call": true, "tool": "delete_file", "args": {"path": "C:\\\\path\\\\to\\\\file.tmp"}}'
            },
            {
                name: "create_directory",
                description: "Create a new directory (creates parent folders recursively if needed)",
                parameters: { path: "Path to directory to create" },
                example: '{"mcp_tool_call": true, "tool": "create_directory", "args": {"path": "C:\\\\path\\\\to\\\\folder"}}'
            },
            {
                name: "move_file",
                description: "Move or rename a file or directory",
                parameters: { source: "Source path", destination: "Destination path" },
                example: '{"mcp_tool_call": true, "tool": "move_file", "args": {"source": "C:\\\\old.txt", "destination": "C:\\\\new.txt"}}'
            },
            {
                name: "search_files",
                description: "Search for files and folders inside a directory matching a pattern",
                parameters: { directory: "Path to directory to search", pattern: "Optional glob pattern like *.js" },
                example: '{"mcp_tool_call": true, "tool": "search_files", "args": {"directory": "C:\\\\Users\\\\...", "pattern": "*.js"}}'
            },
            {
                name: "get_file_info",
                description: "Get file or directory metadata (size, created/modified time, type)",
                parameters: { path: "Path to file or directory" },
                example: '{"mcp_tool_call": true, "tool": "get_file_info", "args": {"path": "C:\\\\path\\\\to\\\\file.txt"}}'
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

