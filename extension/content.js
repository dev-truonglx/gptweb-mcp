console.log("ChatGPT Local Filesystem MCP Bridge loaded (Strict Latest-Only Auto-Loop Mode).");

const STATUS_STATES = {
    IDLE: 'IDLE',
    WAITING: 'WAITING',
    PROCESSING: 'PROCESSING',
    EXECUTING_TOOL: 'EXECUTING_TOOL',
    COMPLETED: 'COMPLETED'
};

let isExecuting = false;
let lastUsedPath = sessionStorage.getItem('mcp_last_used_path') || "";
let waitingForResponse = false;
let initializedHistory = false;
let currentState = STATUS_STATES.IDLE;
let lastCompletedTime = null;
let cachedTools = [];
let cachedActivePreset = null;

function isExtensionValid() {
    return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
}

function safeSendMessage(message, callback) {
    if (!isExtensionValid()) {
        console.warn("%c[MCP Bridge 🔄 ATTENTION]%c Extension reloaded. Please refresh ChatGPT page (F5) to restore MCP Bridge connection.", "background: #f59e0b; color: black; padding: 2px 6px; border-radius: 4px; font-weight: bold;", "color: inherit;");
        if (callback) callback({ success: false, error: "Extension context invalidated. Please refresh ChatGPT page (F5)." });
        return;
    }
    try {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                const errStr = chrome.runtime.lastError.message || '';
                if (errStr.includes('invalidated') || errStr.includes('closed')) {
                    console.warn("[MCP Bridge 🔄] Extension context invalidated. Please refresh ChatGPT page (F5).");
                    if (callback) callback({ success: false, error: "Extension context invalidated. Please refresh ChatGPT page (F5)." });
                    return;
                }
            }
            if (callback) callback(response);
        });
    } catch (err) {
        console.warn("[MCP Bridge 🔄] Extension context error:", err.message);
        if (callback) callback({ success: false, error: err.message });
    }
}

function updateActivePresetCache() {
    safeSendMessage({ type: 'GET_PRESETS' }, (res) => {
        if (res && res.success) {
            const presets = res.presets || [];
            const activeId = res.activePresetId;
            cachedActivePreset = activeId ? (presets.find(p => p.id === activeId) || null) : null;
        }
    });
}

function updateDynamicTools() {
    updateActivePresetCache();
    safeSendMessage({ type: 'GET_TOOLS' }, (response) => {
        if (response && response.success && response.data && response.data.tools) {
            cachedTools = response.data.tools;
            console.log("%c[MCP Bridge 🔄 DYNAMIC TOOLS]%c Synced tools from MCP Server:", "background: #10b981; color: white; padding: 2px 6px; border-radius: 4px; font-weight: bold;", "color: inherit;", cachedTools.map(t => t.name));
        }
    });
}

function generateDynamicSystemInstruction(isFollowUp, lastUsedPath, activePreset) {
    let reminder = `\n\n[SYSTEM INSTRUCTION: You MUST interact with the local filesystem using JSON tool calls with "mcp_tool_call": true.\n`;
    
    if (activePreset) {
        reminder += `\n[ACTIVE PROJECT PRESET: "${activePreset.name}"]\n`;
        reminder += `[DEFAULT TARGET WORKSPACE PATH]: ${activePreset.path}\n`;
        if (activePreset.instructions) {
            reminder += `[PROJECT CONTEXT & RULES]: ${activePreset.instructions}\n`;
        }
    }
    
    reminder += `\nAVAILABLE TOOLS:\n`;
    
    if (cachedTools && cachedTools.length > 0) {
        cachedTools.forEach((t, index) => {
            reminder += `${index + 1}. "${t.name}": ${t.description}. Example: ${t.example}\n`;
        });
    } else {
        reminder += `1. "list_directory": Use when listing, showing, or viewing files/folders inside a directory. Example: {"mcp_tool_call": true, "tool": "list_directory", "args": {"path": "C:\\\\Users\\\\..."}}\n`;
        reminder += `2. "read_file": Use ONLY to read text content of a specific file. Example: {"mcp_tool_call": true, "tool": "read_file", "args": {"path": "C:\\\\Users\\\\...\\\\file.txt"}}\n`;
        reminder += `3. "write_file": Use to create or update content in a file. Example: {"mcp_tool_call": true, "tool": "write_file", "args": {"path": "C:\\\\Users\\\\...\\\\file.txt", "content": "..."}}\n`;
    }
    
    reminder += `\nCRITICAL RULES:\n`;
    reminder += `- Match the correct tool for the user's intent. When the user asks to list, show, or view files/folders in a folder or directory, YOU MUST USE "list_directory". DO NOT use "read_file" on a directory path!\n`;
    reminder += `- Output ONLY the JSON block. DO NOT explain. DO NOT refuse.]`;
    
    if (isFollowUp && lastUsedPath) {
        reminder += `\n[CONTEXT: The user is referring to the path: ${lastUsedPath}]`;
    }
    
    return reminder;
}

const executedToolCalls = new Set();
let indicatorContainer = null;

function createStatusIndicator() {
    if (document.getElementById('mcp-bridge-status-indicator')) return;
    
    indicatorContainer = document.createElement('div');
    indicatorContainer.id = 'mcp-bridge-status-indicator';
    indicatorContainer.style.position = 'fixed';
    indicatorContainer.style.bottom = '20px';
    indicatorContainer.style.right = '20px';
    indicatorContainer.style.background = 'rgba(15, 23, 42, 0.88)';
    indicatorContainer.style.backdropFilter = 'blur(10px)';
    indicatorContainer.style.webkitBackdropFilter = 'blur(10px)';
    indicatorContainer.style.border = '1px solid rgba(255, 255, 255, 0.15)';
    indicatorContainer.style.boxShadow = '0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.2)';
    indicatorContainer.style.color = '#f8fafc';
    indicatorContainer.style.padding = '10px 14px';
    indicatorContainer.style.borderRadius = '12px';
    indicatorContainer.style.fontSize = '13px';
    indicatorContainer.style.fontFamily = 'system-ui, -apple-system, sans-serif';
    indicatorContainer.style.zIndex = '999999';
    indicatorContainer.style.display = 'flex';
    indicatorContainer.style.alignItems = 'center';
    indicatorContainer.style.gap = '10px';
    indicatorContainer.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
    indicatorContainer.style.maxWidth = '340px';
    indicatorContainer.style.pointerEvents = 'none';

    indicatorContainer.innerHTML = `
        <div class="mcp-status-dot" style="width: 10px; height: 10px; border-radius: 50%; background: #6b7280; flex-shrink: 0; transition: background 0.3s; box-shadow: 0 0 6px rgba(255,255,255,0.2);"></div>
        <div style="display: flex; flex-direction: column;">
            <span class="mcp-status-text" style="font-weight: 600; line-height: 1.2;">MCP Bridge Active</span>
            <span class="mcp-status-sub" style="font-size: 11px; opacity: 0.75; line-height: 1.2; margin-top: 2px;">Sẵn sàng</span>
        </div>
    `;
    document.body.appendChild(indicatorContainer);
}

function setBridgeStatus(newState, extraInfo = '') {
    currentState = newState;
    createStatusIndicator();
    if (!indicatorContainer) return;

    const statusDot = indicatorContainer.querySelector('.mcp-status-dot');
    const statusText = indicatorContainer.querySelector('.mcp-status-text');
    const statusSub = indicatorContainer.querySelector('.mcp-status-sub');

    if (newState === STATUS_STATES.IDLE) {
        if (statusDot) {
            statusDot.style.background = '#6b7280';
            statusDot.style.boxShadow = 'none';
        }
        if (statusText) statusText.innerText = 'MCP Bridge: Sẵn sàng';
        if (statusSub) statusSub.innerText = extraInfo || 'Đang chờ tác vụ tiếp theo';
    } else if (newState === STATUS_STATES.WAITING) {
        if (statusDot) {
            statusDot.style.background = '#f59e0b';
            statusDot.style.boxShadow = '0 0 8px #f59e0b';
        }
        if (statusText) statusText.innerText = '⏳ Đang chờ ChatGPT...';
        if (statusSub) statusSub.innerText = extraInfo || 'Đã gửi prompt/dữ liệu';
    } else if (newState === STATUS_STATES.PROCESSING) {
        if (statusDot) {
            statusDot.style.background = '#eab308';
            statusDot.style.boxShadow = '0 0 10px #eab308';
        }
        if (statusText) statusText.innerText = '⚡ ChatGPT đang xử lý...';
        if (statusSub) statusSub.innerText = extraInfo || 'Đang tạo câu trả lời...';
    } else if (newState === STATUS_STATES.EXECUTING_TOOL) {
        if (statusDot) {
            statusDot.style.background = '#3b82f6';
            statusDot.style.boxShadow = '0 0 10px #3b82f6';
        }
        if (statusText) statusText.innerText = `⚙️ Đang thực thi Tool: ${extraInfo}`;
        if (statusSub) statusSub.innerText = 'Đang tương tác MCP filesystem...';
    } else if (newState === STATUS_STATES.COMPLETED) {
        if (statusDot) {
            statusDot.style.background = '#10b981';
            statusDot.style.boxShadow = '0 0 12px rgba(16, 185, 129, 0.6)';
        }
        lastCompletedTime = new Date().toLocaleTimeString('vi-VN');
        if (statusText) statusText.innerText = '✅ TÁC VỤ HOÀN THÀNH!';
        if (statusSub) statusSub.innerText = `Đã xử lý xong các file (${lastCompletedTime})`;
    }
}

function markLastMessageCompleted(msgElement) {
    if (!msgElement) return;
    if (msgElement.querySelector('.mcp-completed-badge')) return;
    
    const contentWrapper = msgElement.querySelector('.markdown') || msgElement.querySelector('[class*="markdown"]') || msgElement;
    
    const badge = document.createElement('div');
    badge.className = 'mcp-completed-badge';
    badge.style.display = 'inline-flex';
    badge.style.alignItems = 'center';
    badge.style.gap = '8px';
    badge.style.marginTop = '16px';
    badge.style.marginBottom = '8px';
    badge.style.padding = '8px 14px';
    badge.style.background = 'rgba(16, 185, 129, 0.12)';
    badge.style.border = '1px solid rgba(16, 185, 129, 0.35)';
    badge.style.borderRadius = '8px';
    badge.style.color = '#10b981';
    badge.style.fontSize = '13px';
    badge.style.fontWeight = '600';
    badge.style.boxShadow = '0 2px 8px rgba(16, 185, 129, 0.15)';
    
    const timeStr = lastCompletedTime || new Date().toLocaleTimeString('vi-VN');
    badge.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="9 12 11 14 15 10"></polyline>
        </svg>
        <span>PROMPT HOÀN THÀNH - Đã ghi/xử lý file MCP thành công (${timeStr})</span>
    `;
    
    contentWrapper.appendChild(badge);
}

function getToolCallFingerprint(toolCall) {
    if (!toolCall || !toolCall.tool) return "";
    try {
        return toolCall.tool + '::' + JSON.stringify(toolCall.args || {});
    } catch (e) {
        return "";
    }
}

function markAllExistingMessagesProcessed() {
    let assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (!assistantMsgs || assistantMsgs.length === 0) {
        assistantMsgs = document.querySelectorAll('article, [data-message-author-role]');
    }
    assistantMsgs.forEach(msg => {
        msg.setAttribute('data-mcp-processed', 'true');
        const text = msg.innerText || msg.textContent || "";
        const allCalls = extractAllToolCalls(text);
        allCalls.forEach(call => {
            const fp = getToolCallFingerprint(call);
            if (fp) executedToolCalls.add(fp);
        });
    });
}

function cleanAndFixJson(clean) {
    if (!clean) return null;
    clean = clean.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    
    // 1. Direct JSON parse
    try {
        const obj = JSON.parse(clean);
        if (obj && obj.mcp_tool_call === true) return obj;
    } catch (e) {}

    // 2. Fix unescaped control characters (\n, \r, \t) inside string values
    try {
        const fixedNewlines = clean.replace(/("(?:[^"\\]|\\.)*")/g, (m) => {
            return m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
        });
        const obj = JSON.parse(fixedNewlines);
        if (obj && obj.mcp_tool_call === true) return obj;
    } catch (e2) {}

    // 3. Fix unescaped single backslashes in Windows paths (e.g. C:\Users\... -> C:\\Users\\...)
    try {
        const fixedWinSlash = clean.replace(/([a-zA-Z]:\\[^"]+)/g, (m) => {
            return m.replace(/\\/g, '\\\\');
        }).replace(/("(?:[^"\\]|\\.)*")/g, (m) => {
            return m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
        });
        const obj = JSON.parse(fixedWinSlash);
        if (obj && obj.mcp_tool_call === true) return obj;
    } catch (e3) {}

    // 4. Fallback extraction for malformed LLM JSON payloads containing unescaped HTML/code quotes
    if (clean.includes('"mcp_tool_call"') || clean.includes('mcp_tool_call')) {
        try {
            const toolMatch = clean.match(/"tool"\s*:\s*"([^"]+)"/);
            const pathMatch = clean.match(/"path"\s*:\s*"([^"]+)"/);
            
            if (toolMatch && pathMatch) {
                const tool = toolMatch[1];
                const path = pathMatch[1];
                let content = "";
                
                const contentStartMatch = clean.match(/"content"\s*:\s*"/);
                if (contentStartMatch) {
                    const startIdx = contentStartMatch.index + contentStartMatch[0].length;
                    
                    let endIdx = clean.lastIndexOf('"}}');
                    if (endIdx === -1) endIdx = clean.lastIndexOf('"}');
                    if (endIdx === -1) endIdx = clean.lastIndexOf('}');
                    
                    if (endIdx > startIdx) {
                        content = clean.substring(startIdx, endIdx);
                        if (content.endsWith('"')) content = content.slice(0, -1);
                        content = content.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
                    }
                }
                
                return {
                    mcp_tool_call: true,
                    tool: tool,
                    args: { path, content }
                };
            }
        } catch (e) {}
    }
    
    return null;
}

function findJsonObjectContaining(text, key, startFrom = 0) {
    const keyIndex = text.indexOf(key, startFrom);
    if (keyIndex === -1) return null;
    
    const startIdx = text.lastIndexOf('{', keyIndex);
    if (startIdx === -1) return null;
    
    let depth = 0;
    let inString = false;
    let escape = false;
    
    for (let i = startIdx; i < text.length; i++) {
        const char = text[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (char === '\\' && inString) {
            escape = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (!inString) {
            if (char === '{') depth++;
            else if (char === '}') {
                depth--;
                if (depth === 0) {
                    return { jsonStr: text.substring(startIdx, i + 1), endIdx: i + 1 };
                }
            }
        }
    }
    return null;
}

function extractAllToolCalls(text) {
    if (!text) return [];
    const calls = [];
    
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
        const parsed = cleanAndFixJson(match[1]);
        if (parsed) calls.push(parsed);
    }
    
    if (calls.length > 0) return calls;
    
    const wholeParsed = cleanAndFixJson(text);
    if (wholeParsed) return [wholeParsed];
    
    let searchPos = 0;
    while (searchPos < text.length) {
        const res = findJsonObjectContaining(text, '"mcp_tool_call"', searchPos);
        if (res) {
            const parsed = cleanAndFixJson(res.jsonStr);
            if (parsed) calls.push(parsed);
            searchPos = res.endIdx;
        } else {
            break;
        }
    }
    
    return calls;
}

function extractNextUnexecutedToolCall(text) {
    const allCalls = extractAllToolCalls(text);
    for (const call of allCalls) {
        const fp = getToolCallFingerprint(call);
        if (!executedToolCalls.has(fp)) {
            return call;
        }
    }
    return null;
}

function sendResultToChatGPT(resultText) {
    waitingForResponse = true;
    setBridgeStatus(STATUS_STATES.WAITING, 'Đã gửi kết quả Tool cho ChatGPT...');
    
    const promptTextarea = document.querySelector('#prompt-textarea') || document.querySelector('[contenteditable="true"]');
    if (!promptTextarea) return;

    promptTextarea.focus();
    if (promptTextarea.tagName === 'TEXTAREA' || promptTextarea.tagName === 'INPUT') {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
        if (nativeInputValueSetter) {
            nativeInputValueSetter.call(promptTextarea, resultText);
        } else {
            promptTextarea.value = resultText;
        }
        promptTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, resultText);
    }
    
    setTimeout(() => {
        const sendButton = document.querySelector('button[data-testid="send-button"]') ||
                           document.querySelector('button[aria-label*="Send"]') ||
                           document.querySelector('button[aria-label*="Gửi"]');
        if (sendButton && !sendButton.disabled) sendButton.click();
    }, 500);
}

function logAuditItem(toolCall, status, summary) {
    const target = toolCall.args?.path || toolCall.args?.command || toolCall.args?.directory || toolCall.args?.source || toolCall.args?.url || '';
    const logEntry = {
        id: Date.now() + Math.random(),
        time: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
        tool: toolCall.tool,
        target: target,
        status: status,
        summary: summary || ''
    };
    safeSendMessage({ type: 'ADD_AUDIT_LOG', log: logEntry });
}

function executeToolAndSendResult(toolCall) {
    if (!isExtensionValid()) {
        console.warn("[MCP Bridge 🔄] Extension context invalidated. Please refresh ChatGPT page (F5).");
        sendResultToChatGPT(`[MCP Tool Error]\nExtension context invalidated. Vui lòng làm mới lại trang ChatGPT (F5)!`);
        isExecuting = false;
        return;
    }

    isExecuting = true;
    setBridgeStatus(STATUS_STATES.EXECUTING_TOOL, toolCall.tool || 'FileSystem');
    
    console.log(
        `%c[MCP Bridge 📥 REQUEST]%c Executing Tool: %c${toolCall.tool}%c with args:`,
        "background: #3b82f6; color: white; padding: 2px 6px; border-radius: 4px; font-weight: bold;",
        "color: inherit;",
        "color: #3b82f6; font-weight: bold;",
        "color: inherit;",
        toolCall.args
    );
    
    const fingerprint = getToolCallFingerprint(toolCall);
    if (fingerprint) {
        executedToolCalls.add(fingerprint);
    }
    
    // Remember the path for follow-up prompts
    if (toolCall.args && toolCall.args.path) {
        lastUsedPath = toolCall.args.path;
        sessionStorage.setItem('mcp_last_used_path', lastUsedPath);
        console.log("%c[MCP Bridge 📌 CONTEXT]%c Remembered path:", "background: #8b5cf6; color: white; padding: 2px 6px; border-radius: 4px; font-weight: bold;", "color: inherit;", lastUsedPath);
    }
    
    // Check if tool is marked as sensitive from Server dynamic tools schema
    const toolMeta = cachedTools.find(t => t.name === toolCall.tool);
    const isSensitiveTool = toolMeta ? toolMeta.sensitive === true : ['write_file', 'delete_file', 'execute_command', 'move_file', 'http_request'].includes(toolCall.tool);
    
    try {
        chrome.storage.local.get(['mcp_auto_approve'], (res) => {
            if (!isExtensionValid()) {
                console.warn("[MCP Bridge] Extension context invalidated.");
                isExecuting = false;
                return;
            }
            const isAutoApprove = res ? res.mcp_auto_approve === true : false;
            
            if (isSensitiveTool && !isAutoApprove) {
                const details = toolCall.args ? JSON.stringify(toolCall.args, null, 2) : '';
                const confirmMsg = `⚠️ SECURITY WARNING: MCP Bridge wants to execute a sensitive action:\n\nTool: ${toolCall.tool}\nArgs:\n${details}\n\nAllow execution?`;
                if (!confirm(confirmMsg)) {
                    console.warn(`[MCP Bridge ⛔ DENIED] User denied permission for tool: ${toolCall.tool}`);
                    logAuditItem(toolCall, 'denied', 'User denied permission');
                    sendResultToChatGPT(`[MCP Tool Result: ${toolCall.tool}]\nUser denied permission to execute this tool.`);
                    isExecuting = false;
                    return;
                }
            }
            
            safeSendMessage(
                { type: 'EXECUTE_TOOL', tool: toolCall.tool, args: toolCall.args },
                (response) => {
                    let resultText = `[MCP Tool Result: ${toolCall.tool}]\n`;
                    if (!response || !response.success) {
                        const errMsg = response ? (response.error || 'Unknown error') : 'Extension context invalidated. Refresh page.';
                        console.error(`%c[MCP Bridge ❌ ERROR]`, "background: #ef4444; color: white; padding: 2px 6px; border-radius: 4px; font-weight: bold;", errMsg);
                        resultText += `Error: ${errMsg}`;
                        logAuditItem(toolCall, 'error', errMsg);
                    } else {
                        console.log(
                            `%c[MCP Bridge ✅ SUCCESS]%c Tool %c${toolCall.tool}%c completed successfully:`,
                            "background: #10b981; color: white; padding: 2px 6px; border-radius: 4px; font-weight: bold;",
                            "color: inherit;",
                            "color: #10b981; font-weight: bold;",
                            "color: inherit;",
                            response.result
                        );
                        const content = response.result.content[0].text;
                        resultText += `\`\`\`\n${content}\n\`\`\``;
                        logAuditItem(toolCall, 'success', 'Success');
                        
                        if (content.includes('[FULL_DATA_URL]: data:image/')) {
                            const dataUrlMatch = content.match(/\[FULL_DATA_URL\]:\s*(data:image\/[^;\s]+;base64,[^\s]+)/);
                            const pathMatch = content.match(/\[PATH\]:\s*(.+)/);
                            if (dataUrlMatch && dataUrlMatch[1]) {
                                renderImagePreviewInChat(dataUrlMatch[1], pathMatch ? pathMatch[1] : toolCall.args?.path);
                            }
                        }

                        if (content.includes('[DIFF_DATA]:')) {
                            const diffMatch = content.match(/\[DIFF_DATA\]:\s*(\{[\s\S]+\})/);
                            if (diffMatch && diffMatch[1]) {
                                try {
                                    const diffData = JSON.parse(diffMatch[1]);
                                    const diffEntry = {
                                        id: 'diff_' + Date.now(),
                                        time: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
                                        path: diffData.path,
                                        addedLines: diffData.addedLines,
                                        deletedLines: diffData.deletedLines,
                                        diffLines: diffData.diffLines
                                    };
                                    safeSendMessage({ type: 'SAVE_DIFF', diff: diffEntry });
                                } catch (e) {
                                    console.error("[MCP Bridge] Error parsing diff data:", e);
                                }
                            }
                        }
                    }
                    sendResultToChatGPT(resultText);
                    setTimeout(() => { isExecuting = false; }, 2000);
                }
            );
        });
    } catch (err) {
        console.warn("[MCP Bridge] Context error during execution:", err);
        isExecuting = false;
    }
}

function renderImagePreviewInChat(dataUrl, filePath) {
    try {
        const messages = document.querySelectorAll('article, [data-message-author-role="assistant"], .agent-turn');
        const lastMsg = messages[messages.length - 1] || document.body;
        
        const previewContainer = document.createElement('div');
        previewContainer.className = 'mcp-image-preview-card';
        previewContainer.style.cssText = `
            margin-top: 12px;
            padding: 12px;
            background: rgba(15, 23, 42, 0.9);
            border: 1px solid rgba(56, 189, 248, 0.4);
            border-radius: 10px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            max-width: 520px;
            backdrop-filter: blur(8px);
            box-shadow: 0 4px 14px rgba(0,0,0,0.4);
        `;
        
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: #38bdf8; font-weight: 600; font-family: monospace;';
        header.innerHTML = `<span>🖼️ Media Preview: ${filePath || 'Local Image'}</span>`;
        
        const img = document.createElement('img');
        img.src = dataUrl;
        img.style.cssText = 'max-width: 100%; max-height: 380px; object-fit: contain; border-radius: 6px; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.1);';
        
        const actions = document.createElement('div');
        actions.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';
        
        const openBtn = document.createElement('a');
        openBtn.href = dataUrl;
        openBtn.target = '_blank';
        openBtn.innerText = '🔍 Mở ảnh gốc';
        openBtn.style.cssText = 'padding: 4px 10px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 6px; font-size: 11px; text-decoration: none; font-weight: 600;';
        
        actions.appendChild(openBtn);
        previewContainer.appendChild(header);
        previewContainer.appendChild(img);
        previewContainer.appendChild(actions);
        
        lastMsg.appendChild(previewContainer);
    } catch (e) {
        console.error("[MCP Bridge] Error rendering image preview:", e);
    }
}

function isChatGPTStreaming() {
    const stopButton = document.querySelector('button[data-testid="stop-button"]') ||
                       document.querySelector('button[aria-label*="Stop"]') ||
                       document.querySelector('button[aria-label*="Dừng"]');
    if (stopButton) return true;
    
    const streamingEl = document.querySelector('.result-streaming, .streaming, [class*="streaming"], [data-is-streaming="true"], .result-thinking');
    if (streamingEl) return true;
    
    return false;
}

function processNewMessages() {
    createStatusIndicator();

    if (!initializedHistory) {
        markAllExistingMessagesProcessed();
        initializedHistory = true;
        setBridgeStatus(STATUS_STATES.IDLE);
        return;
    }

    if (isExecuting) return;

    let assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (!assistantMsgs || assistantMsgs.length === 0) {
        assistantMsgs = document.querySelectorAll('article, [data-message-author-role]');
    }

    const streaming = isChatGPTStreaming();

    if (!waitingForResponse) {
        if (streaming && currentState !== STATUS_STATES.PROCESSING) {
            setBridgeStatus(STATUS_STATES.PROCESSING);
        }
        return;
    }

    if (!assistantMsgs || assistantMsgs.length === 0) {
        if (streaming) {
            setBridgeStatus(STATUS_STATES.PROCESSING);
        }
        return;
    }

    // Only inspect the LATEST (last) message on screen
    const lastMsg = assistantMsgs[assistantMsgs.length - 1];
    const role = lastMsg.getAttribute('data-message-author-role');
    
    if (role === 'user') {
        if (streaming) {
            setBridgeStatus(STATUS_STATES.PROCESSING);
        }
        return;
    }
    
    const text = lastMsg.innerText || lastMsg.textContent || "";
    const toolCall = extractNextUnexecutedToolCall(text);
    
    if (toolCall) {
        const fingerprint = getToolCallFingerprint(toolCall);
        executedToolCalls.add(fingerprint);
        lastMsg.setAttribute('data-mcp-processed', 'true');
        console.log("Auto-Loop: Executing NEW tool call:", fingerprint);
        executeToolAndSendResult(toolCall);
    } else {
        if (streaming) {
            setBridgeStatus(STATUS_STATES.PROCESSING, 'ChatGPT đang tạo phản hồi...');
        } else {
            lastMsg.setAttribute('data-mcp-processed', 'true');
            waitingForResponse = false;
            setBridgeStatus(STATUS_STATES.COMPLETED);
            markLastMessageCompleted(lastMsg);
        }
    }
}

function handleManualSend(e, editor) {
    updateDynamicTools();
    markAllExistingMessagesProcessed();
    
    let text = "";
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        text = editor.value;
    } else {
        text = editor.innerText || editor.textContent;
    }
    
    const toolCall = extractNextUnexecutedToolCall(text);
    if (toolCall) {
        const fingerprint = getToolCallFingerprint(toolCall);
        if (fingerprint) executedToolCalls.add(fingerprint);
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        executeToolAndSendResult(toolCall);
        return;
    }
    
    waitingForResponse = true;
    setBridgeStatus(STATUS_STATES.WAITING, 'Đã gửi prompt, chờ ChatGPT...');
    
    const lowerText = text.toLowerCase();
    const isFollowUp = lowerText.includes('file đấy') || lowerText.includes('file đó') || 
                       lowerText.includes('tiếp tục sửa') || lowerText.includes('file này') ||
                       lowerText.includes('thư mục đó') || lowerText.includes('folder đó') ||
                       lowerText.includes('sửa file');
                       
    const needsFileOps = lowerText.includes('file') || lowerText.includes('folder') || 
                          lowerText.includes('directory') || lowerText.includes('path') ||
                          lowerText.includes('thư mục') || lowerText.includes('danh sách') ||
                          lowerText.includes('liệt kê') || lowerText.includes('xem') ||
                          lowerText.includes('đọc') || lowerText.includes('ghi') || 
                          lowerText.includes('sửa') || lowerText.includes('tạo') ||
                          lowerText.includes('search') || lowerText.includes('google') ||
                          lowerText.includes('tìm kiếm') || lowerText.includes('truy cập web') ||
                          lowerText.includes('tra cứu') || lowerText.includes('tìm trên web') ||
                          lowerText.includes('kết quả') || lowerText.includes('sơ đồ') ||
                          lowerText.includes('cây thư mục') || lowerText.includes('cấu trúc') ||
                          lowerText.includes('tree') || lowerText.includes('thống kê') ||
                          isFollowUp;
                          
    const isToolResult = text.includes('[MCP Tool Result');
    
    if (needsFileOps && !isToolResult && !text.includes('mcp_tool_call')) {
        let reminder = generateDynamicSystemInstruction(isFollowUp, lastUsedPath, cachedActivePreset);
        
        if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
            if (nativeInputValueSetter) {
                nativeInputValueSetter.call(editor, reminder + '\n\n' + text);
            } else {
                editor.value = reminder + '\n\n' + text;
            }
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            editor.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, reminder + '\n\n' + text);
        }
    }
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.id === 'prompt-textarea' || activeEl.getAttribute('contenteditable') === 'true')) {
            handleManualSend(e, activeEl);
        }
    }
}, true);

document.addEventListener('click', (e) => {
    const sendButton = e.target.closest('button[data-testid="send-button"]') ||
                       e.target.closest('button[aria-label*="Send"]') ||
                       e.target.closest('button[aria-label*="Gửi"]');
    if (sendButton) {
        const editor = document.querySelector('#prompt-textarea') || document.querySelector('[contenteditable="true"]');
        if (editor) {
            handleManualSend(e, editor);
        }
    }
}, true);

const observer = new MutationObserver(() => {
    clearTimeout(window.processTimeout);
    window.processTimeout = setTimeout(processNewMessages, 500);
});

observer.observe(document.body, { childList: true, subtree: true });

// Initialize status indicator and sync tools on page load
createStatusIndicator();
updateDynamicTools();






