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

    // 3. Fallback extraction for malformed LLM JSON payloads containing unescaped HTML/code quotes
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

function executeToolAndSendResult(toolCall) {
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
    
    if (toolCall.tool === 'write_file' || toolCall.tool === 'delete_file') {
        const confirmMsg = `⚠️ WARNING: Bridge wants to WRITE to a file:\nPath: ${toolCall.args.path}\n\nThis will overwrite the file. Allow?`;
        if (!confirm(confirmMsg)) {
            console.warn(`[MCP Bridge ⛔ DENIED] User denied permission for tool: ${toolCall.tool}`);
            sendResultToChatGPT(`[MCP Tool Result: ${toolCall.tool}]\nUser denied permission to execute this tool.`);
            isExecuting = false;
            return;
        }
    }
    
    chrome.runtime.sendMessage(
        { type: 'EXECUTE_TOOL', tool: toolCall.tool, args: toolCall.args },
        (response) => {
            let resultText = `[MCP Tool Result: ${toolCall.tool}]\n`;
            if (chrome.runtime.lastError) {
                console.error(`%c[MCP Bridge ❌ ERROR]`, "background: #ef4444; color: white; padding: 2px 6px; border-radius: 4px; font-weight: bold;", chrome.runtime.lastError.message);
                resultText += `Error: ${chrome.runtime.lastError.message}`;
            } else if (response && response.success) {
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
            } else {
                console.error(
                    `%c[MCP Bridge ❌ ERROR]%c Tool %c${toolCall.tool}%c failed:`,
                    "background: #ef4444; color: white; padding: 2px 6px; border-radius: 4px; font-weight: bold;",
                    "color: inherit;",
                    "color: #ef4444; font-weight: bold;",
                    "color: inherit;",
                    response ? response.error : 'Unknown error'
                );
                resultText += `Error: ${response ? response.error : 'Unknown error'}`;
            }
            sendResultToChatGPT(resultText);
            setTimeout(() => { isExecuting = false; }, 2000);
        }
    );
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
                       lowerText.includes('sửa file');
                       
    const needsFileOps = lowerText.includes('file') || lowerText.includes('folder') || 
                          lowerText.includes('directory') || lowerText.includes('path') ||
                          lowerText.includes('đọc') || lowerText.includes('ghi') || 
                          lowerText.includes('sửa') || lowerText.includes('liệt kê') ||
                          isFollowUp;
                          
    const isToolResult = text.includes('[MCP Tool Result');
    
    if (needsFileOps && !isToolResult && !text.includes('mcp_tool_call')) {
        let reminder = `\n\n[SYSTEM INSTRUCTION: You MUST read or write files using JSON. Output ONLY a JSON block like {"mcp_tool_call": true, "tool": "read_file", "args": {"path": "..."}} or {"mcp_tool_call": true, "tool": "write_file", "args": {"path": "...", "content": "..."}}. DO NOT explain. DO NOT refuse.]`;
        
        if (isFollowUp && lastUsedPath) {
            reminder += `\n[CONTEXT: The user is referring to the file: ${lastUsedPath}]`;
        }
        
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

// Initialize status indicator on page load
createStatusIndicator();





