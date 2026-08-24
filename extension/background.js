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

function fetchTools(sendResponse) {
    fetch('http://localhost:8889/tools')
        .then(res => res.json())
        .then(data => {
            if (sendResponse) sendResponse({ success: true, data });
        })
        .catch(err => {
            if (sendResponse) sendResponse({ success: false, error: err.message });
        });
}

function saveAuditLog(logEntry) {
    if (!chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get(['mcp_audit_logs'], (result) => {
        const logs = result.mcp_audit_logs || [];
        logs.unshift(logEntry);
        if (logs.length > 50) logs.pop();
        chrome.storage.local.set({ mcp_audit_logs: logs });
    });
}

function fetchConfig(sendResponse) {
    fetch('http://localhost:8889/config')
        .then(res => res.json())
        .then(data => {
            if (sendResponse) sendResponse({ success: true, data });
        })
        .catch(err => {
            if (sendResponse) sendResponse({ success: false, error: err.message });
        });
}

function updateConfig(allowedDirectories, sendResponse) {
    fetch('http://localhost:8889/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedDirectories })
    })
    .then(res => res.json())
    .then(data => {
        if (sendResponse) sendResponse({ success: true, data });
    })
    .catch(err => {
        if (sendResponse) sendResponse({ success: false, error: err.message });
    });
}

function getPresets(sendResponse) {
    chrome.storage.local.get(['mcp_presets', 'mcp_active_preset_id'], (res) => {
        sendResponse({
            success: true,
            presets: res.mcp_presets || [],
            activePresetId: res.mcp_active_preset_id || null
        });
    });
}

function savePreset(preset, sendResponse) {
    chrome.storage.local.get(['mcp_presets'], (res) => {
        let presets = res.mcp_presets || [];
        const existingIdx = presets.findIndex(p => p.id === preset.id);
        if (existingIdx >= 0) {
            presets[existingIdx] = preset;
        } else {
            presets.push(preset);
        }
        chrome.storage.local.set({ mcp_presets: presets }, () => {
            if (sendResponse) sendResponse({ success: true, presets });
        });
    });
}

function deletePreset(id, sendResponse) {
    chrome.storage.local.get(['mcp_presets', 'mcp_active_preset_id'], (res) => {
        let presets = (res.mcp_presets || []).filter(p => p.id !== id);
        let activeId = res.mcp_active_preset_id;
        if (activeId === id) activeId = null;
        chrome.storage.local.set({ mcp_presets: presets, mcp_active_preset_id: activeId }, () => {
            if (sendResponse) sendResponse({ success: true, presets, activePresetId: activeId });
        });
    });
}

function setActivePreset(id, sendResponse) {
    chrome.storage.local.set({ mcp_active_preset_id: id }, () => {
        if (sendResponse) sendResponse({ success: true, activePresetId: id });
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'CONNECT' || request.type === 'CHECK_STATUS') {
        checkHealth(sendResponse);
        return true;
    }

    if (request.type === 'GET_PRESETS') {
        getPresets(sendResponse);
        return true;
    }

    if (request.type === 'SAVE_PRESET') {
        savePreset(request.preset, sendResponse);
        return true;
    }

    if (request.type === 'DELETE_PRESET') {
        deletePreset(request.id, sendResponse);
        return true;
    }

    if (request.type === 'SET_ACTIVE_PRESET') {
        setActivePreset(request.id, sendResponse);
        return true;
    }
    
    if (request.type === 'GET_TOOLS') {
        fetchTools(sendResponse);
        return true;
    }

    if (request.type === 'GET_CONFIG') {
        fetchConfig(sendResponse);
        return true;
    }

    if (request.type === 'SET_CONFIG') {
        updateConfig(request.allowedDirectories, sendResponse);
        return true;
    }
    
    if (request.type === 'EXECUTE_TOOL') {
        executeTool(request.tool, request.args, sendResponse);
        return true;
    }

    if (request.type === 'ADD_AUDIT_LOG') {
        saveAuditLog(request.log);
        if (sendResponse) sendResponse({ success: true });
        return true;
    }
    
    if (request.type === 'GET_AUDIT_LOGS') {
        chrome.storage.local.get(['mcp_audit_logs'], (result) => {
            sendResponse({ success: true, logs: result.mcp_audit_logs || [] });
        });
        return true;
    }

    if (request.type === 'CLEAR_AUDIT_LOGS') {
        chrome.storage.local.set({ mcp_audit_logs: [] }, () => {
            sendResponse({ success: true });
        });
        return true;
    }
});

// Periodic health check
setInterval(() => checkHealth(), 5000);
