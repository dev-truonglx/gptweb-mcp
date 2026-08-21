document.addEventListener('DOMContentLoaded', () => {
    const serverBadge = document.getElementById('serverBadge');
    const serverStatusText = document.getElementById('serverStatusText');
    const autoApproveToggle = document.getElementById('autoApproveToggle');
    const dirList = document.getElementById('dirList');
    const newDirInput = document.getElementById('newDirInput');
    const addDirBtn = document.getElementById('addDirBtn');
    const logList = document.getElementById('logList');
    const clearLogsBtn = document.getElementById('clearLogsBtn');
    const refreshBtn = document.getElementById('refreshBtn');

    let currentAllowedDirs = [];

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // 1. Check Server Connection Status
    function checkServerStatus() {
        serverStatusText.innerText = 'Checking...';
        chrome.runtime.sendMessage({ type: 'CHECK_STATUS' }, (response) => {
            if (chrome.runtime.lastError || !response || response.status !== 'connected') {
                serverBadge.className = 'server-badge';
                serverStatusText.innerText = 'Offline';
            } else {
                serverBadge.className = 'server-badge online';
                serverStatusText.innerText = 'Online (Port 8889)';
            }
        });
    }

    // 2. Load & Save Auto-Approve Toggle state
    chrome.storage.local.get(['mcp_auto_approve'], (res) => {
        autoApproveToggle.checked = res.mcp_auto_approve === true;
    });

    autoApproveToggle.addEventListener('change', () => {
        const isChecked = autoApproveToggle.checked;
        chrome.storage.local.set({ mcp_auto_approve: isChecked });
    });

    // 3. Allowed Workspaces Configuration
    function renderAllowedDirs() {
        chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, (response) => {
            if (chrome.runtime.lastError || !response || !response.success || !response.data) {
                dirList.innerHTML = '<div class="empty-log">Không thể kết nối Server để lấy cấu hình</div>';
                return;
            }

            currentAllowedDirs = response.data.allowedDirectories || [];
            if (currentAllowedDirs.length === 0) {
                dirList.innerHTML = '<div class="empty-log">Chưa có thư mục nào được cấp phép</div>';
                return;
            }

            dirList.innerHTML = currentAllowedDirs.map((dir, idx) => `
                <div class="dir-item">
                    <span class="dir-path">${escapeHtml(dir)}</span>
                    <button class="dir-del-btn" data-index="${idx}">🗑️</button>
                </div>
            `).join('');

            // Attach delete button click handlers
            const delButtons = dirList.querySelectorAll('.dir-del-btn');
            delButtons.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const idx = parseInt(e.target.getAttribute('data-index'), 10);
                    deleteDir(idx);
                });
            });
        });
    }

    function saveAllowedDirs(newDirs) {
        chrome.runtime.sendMessage({ type: 'SET_CONFIG', allowedDirectories: newDirs }, (response) => {
            if (response && response.success) {
                renderAllowedDirs();
            } else {
                alert('Không thể lưu cấu hình thư mục lên Server');
            }
        });
    }

    function deleteDir(index) {
        if (index >= 0 && index < currentAllowedDirs.length) {
            const updated = [...currentAllowedDirs];
            updated.splice(index, 1);
            saveAllowedDirs(updated);
        }
    }

    addDirBtn.addEventListener('click', () => {
        const val = newDirInput.value.trim();
        if (!val) return;
        if (currentAllowedDirs.includes(val)) {
            alert('Thư mục này đã có trong danh sách!');
            return;
        }
        const updated = [...currentAllowedDirs, val];
        saveAllowedDirs(updated);
        newDirInput.value = '';
    });

    newDirInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            addDirBtn.click();
        }
    });

    // 4. Render Audit Logs
    function renderAuditLogs() {
        chrome.runtime.sendMessage({ type: 'GET_AUDIT_LOGS' }, (response) => {
            if (!response || !response.logs || response.logs.length === 0) {
                logList.innerHTML = '<div class="empty-log">Chưa có lịch sử thao tác nào</div>';
                return;
            }

            logList.innerHTML = response.logs.map(log => {
                let tagClass = 'tag-default';
                if (log.tool === 'write_file') tagClass = 'tag-write';
                else if (log.tool === 'read_file') tagClass = 'tag-read';
                else if (log.tool === 'list_directory') tagClass = 'tag-list';
                else if (log.tool === 'execute_command') tagClass = 'tag-exec';
                else if (log.tool === 'delete_file') tagClass = 'tag-delete';

                let statusClass = 'status-success';
                let statusText = '✅ Success';
                if (log.status === 'error') {
                    statusClass = 'status-error';
                    statusText = '❌ Error';
                } else if (log.status === 'denied') {
                    statusClass = 'status-denied';
                    statusText = '⛔ Denied';
                }

                return `
                    <div class="log-item">
                        <div class="log-top">
                            <span class="tool-tag ${tagClass}">${log.tool}</span>
                            <span class="log-time">${log.time || ''}</span>
                        </div>
                        <div class="log-target">${escapeHtml(log.target || 'N/A')}</div>
                        <div class="log-status ${statusClass}">${statusText}</div>
                    </div>
                `;
            }).join('');
        });
    }

    clearLogsBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'CLEAR_AUDIT_LOGS' }, () => {
            renderAuditLogs();
        });
    });

    refreshBtn.addEventListener('click', () => {
        checkServerStatus();
        renderAllowedDirs();
        renderAuditLogs();
    });

    // Initial Load
    checkServerStatus();
    renderAllowedDirs();
    renderAuditLogs();
});
