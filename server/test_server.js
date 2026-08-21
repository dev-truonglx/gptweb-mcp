import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function runTest() {
    console.log("Starting MCP Server Test...");
    
    const transport = new SSEClientTransport(new URL("http://localhost:8889/sse"));
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    
    try {
        await client.connect(transport);
        console.log("✅ Connected to MCP Server");
        
        const tools = await client.listTools();
        console.log("✅ Available Tools:", tools.tools.map(t => t.name).join(", "));
        
        console.log("Testing list_directory...");
        const listResult = await client.callTool({
            name: "list_directory",
            arguments: { path: process.cwd() }
        });
        console.log("✅ list_directory result:", listResult.content[0].text.substring(0, 100) + "...");
        
        console.log("Testing read_file...");
        const readResult = await client.callTool({
            name: "read_file",
            arguments: { path: `${process.cwd()}/package.json` }
        });
        console.log("✅ read_file result:", readResult.content[0].text.substring(0, 100) + "...");
        
    } catch (error) {
        console.error("❌ Test failed:", error);
    } finally {
        process.exit(0);
    }
}

runTest();
