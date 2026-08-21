# ChatGPT Local Filesystem MCP Bridge

This project allows ChatGPT Web to interact directly with your local filesystem using the Model Context Protocol (MCP).

## Architecture
- **Local Server**: A Node.js server exposing the official `@modelcontextprotocol/sdk` via SSE (Server-Sent Events) on port 8889. It implements `list_directory` and `read_file` tools.
- **Browser Extension**: Injects a prompt into ChatGPT to teach it how to use tools and acts as a bridge to the local server.

## Installation & Usage

### 1. Start the Local Server
```bash
cd server
npm install
npm start
```
The server runs on `http://localhost:8889/sse` and only allows access to your current working directory, Home directory, and Desktop by default.

### 2. Install the Browser Extension
1. Open Chrome/Edge and go to `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** and select3. Click **Load unpacked** and select3. Click **Load unpacked** and select3. Click **Loacom](https://chatgpt.com)
2. Click the MCP Bridge extension icon in your browser toolbar and click **Connect to Local Server**.
3. In ChatGPT, paste the system prompt printed in your browser's DevTools console (or ask ChatGPT to list files in your Desktop directory using the JSON format).

## Security
- The local server strictly validates paths against an `allowedDirectories` whitelist to prevent path traversal attacks.
