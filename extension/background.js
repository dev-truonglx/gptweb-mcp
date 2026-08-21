let isConnected = false;

function checkHealth(sendResponse) {
    fetch('http://localhost:8889/health')
        .then(response => response.json())
        .then(data => {
            if (data.status === 'ok') {
                isConnected = true;
                if (sendResponse) sendResponse({status: "connected"});
            } else {
                isConnected = false;
                if (sendResponse) sendResponse({status: "disconnected"});
            }
        })
        .catch(err => {
            isConnected = false;
            if (sendResponse) sendResponse({status: "error", message: err.message});
        });
}

function executeTool(toolName, args, sendResponse) {
    // If not connected, try to connect first before failing
    if (!isConnected) {
        fetch('http://localhost:8889/health')
            .then(res => res.json())
            .then(data => {
                if (data.status === 'ok') {
                    isConnected = true;
                    doExecuteTool(toolName, args, sendResponse);
                } else {
                    sendResponse({ success: false, error: "Not connected to Local MCP Server" });
                }
            })
            .catch(err => {
                sendResponse({ success: false, error: "Not connected to Local MCP Server: " + err.message });
            });
    } else {
        doExecuteTool(toolName, args, sendResponse);
    }
}

function doExecuteTool(toolName, args, sendResponse) {
    fetch('http://localhost:8889/call-tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: toolName, args })
    })
    .then(res => res.json())
    .then(data => {
        if (data.isError) {
            sendResponse({ success: false, error: data.content[0].text });
        } else {
            sendResponse({ success: true, result: data });
        }
    })
    .catch(err => {
        sendResponse({ success: false, error: err.message });
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'CONNECT') {
        checkHealth(sendResponse);
        return true;
    }
    
    if (request.type === 'CHECK_STATUS') {
        checkHealth(sendResponse);
        return true;
    }
    
    if (request.type === 'EXECUTE_TOOL') {
        executeTool(request.tool, request.args, sendResponse);
        return true;
    }
});

// Periodic health check
setInterval(() => checkHealth(), 5000);
