import express from 'express';
import cors from 'cors';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import os from "os";

const allowedDirectories = [process.cwd(), os.homedir(), path.resolve(os.homedir(), "Desktop")];

async function validatePath(requestedPath) {
    const expandedPath = requestedPath.startsWith('~/') 
        ? path.join(os.homedir(), requestedPath.slice(2))
        : path.resolve(requestedPath);
        
    const isAllowed = allowedDirectories.some(dir => expandedPath.startsWith(dir));
    if (!isAllowed) {
        throw new Error(`Access denied: ${expandedPath} is not within allowed directories.`);
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
            return { content: [{ type: "text", text: `Error: ${validPath} is a file, not a directory.` }] };
        }
        const entries = await fs.readdir(validPath, { withFileTypes: true });
        const list = entries.map(entry => `${entry.isDirectory() ? '[DIR]' : '[FILE]'} ${entry.name}`).join('\n');
        return { content: [{ type: "text", text: `Contents of ${validPath}:\n${list}` }] };
    },
    read_file: async (args) => {
        const { path: validPath, stats } = await validateExistingPath(args.path);
        if (!stats.isFile()) {
            return { content: [{ type: "text", text: `Error: ${validPath} is a directory, not a file.` }] };
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

