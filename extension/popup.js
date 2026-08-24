document.addEventListener('DOMContentLoaded', () => {
    const serverBadge = document.getElementById('serverBadge');
    const serverStatusText = document.getElementById('serverStatusText');
    const autoApproveToggle = document.getElementById('autoApproveToggle');
    
    // Preset elements
    const togglePresetFormBtn = document.getElementById('togglePresetFormBtn');
    const presetSelect = document.getElementById('presetSelect');
    const delPresetBtn = document.getElementById('delPresetBtn');
    const activePresetBadge = document.getElementById('activePresetBadge');
    const presetPathText = document.getElementById('presetPathText');
    const presetRulesText = document.getElementById('presetRulesText');
    const presetForm = document.getElementById('presetForm');
    const presetNameInput = document.getElementById('presetNameInput');
    const presetPathInput = document.getElementById('presetPathInput');
    const presetRulesInput = document.getElementById('presetRulesInput');
    const savePresetBtn = document.getElementById('savePresetBtn');
    const cancelPresetBtn = document.getElementById('cancelPresetBtn');

    // Dir & Log elements
    const dirList = document.getElementById('dirList');
    const newDirInput = document.getElementById('newDirInput');
    const addDirBtn = document.getElementById('addDirBtn');
    const logList = document.getElementById('logList');
    const clearLogsBtn = document.getElementById('clearLogsBtn');
    const refreshBtn = document.getElementById('refreshBtn');

    let currentAllowedDirs = [];
    let currentPresets = [];
    let activePresetId = null;

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

    // 3. Render Presets
    function renderPresets() {
        chrome.runtime.sendMessage({ type: 'GET_PRESETS' }, (res) => {
            if (!res || !res.success) return;
            currentPresets = res.presets || [];
            activePresetId = res.activePresetId || null;

            presetSelect.innerHTML = '<option value="">-- Mặc định (Không dùng Preset) --</option>';
            currentPresets.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.innerText = p.name;
                if (p.id === activePresetId) opt.selected = true;
                presetSelect.appendChild(opt);
            });

            updateActivePresetBadge();
        });
    }

    function updateActivePresetBadge() {
        const active = currentPresets.find(p => p.id === presetSelect.value);
        if (active) {
            activePresetBadge.style.display = 'flex';
            presetPathText.innerText = active.path || 'N/A';
            presetRulesText.innerText = active.instructions || 'Không có quy tắc riêng';
        } else {
            activePresetBadge.style.display = 'none';
        }
    }

    presetSelect.addEventListener('change', () => {
        const selectedId = presetSelect.value || null;
        chrome.runtime.sendMessage({ type: 'SET_ACTIVE_PRESET', id: selectedId }, () => {
            updateActivePresetBadge();
        });
    });

    togglePresetFormBtn.addEventListener('click', () => {
        presetForm.style.display = presetForm.style.display === 'none' ? 'flex' : 'none';
    });

    cancelPresetBtn.addEventListener('click', () => {
        presetForm.style.display = 'none';
    });

    savePresetBtn.addEventListener('click', () => {
        const name = presetNameInput.value.trim();
        const path = presetPathInput.value.trim();
        const instructions = presetRulesInput.value.trim();

        if (!name || !path) {
            alert('Vui lòng nhập Tên Preset và Đường dẫn thư mục!');
            return;
        }

        const newPreset = {
            id: 'preset_' + Date.now(),
            name,
            path,
            instructions
        };

        chrome.runtime.sendMessage({ type: 'SAVE_PRESET', preset: newPreset }, () => {
            if (!currentAllowedDirs.includes(path)) {
                saveAllowedDirs([...currentAllowedDirs, path]);
            }
            presetNameInput.value = '';
            presetPathInput.value = '';
            presetRulesInput.value = '';
            presetForm.style.display = 'none';
            renderPresets();
        });
    });

    delPresetBtn.addEventListener('click', () => {
        const selectedId = presetSelect.value;
        if (!selectedId) {
            alert('Vui lòng chọn một Preset để xóa!');
            return;
        }
        if (confirm('Bạn có chắc chắn muốn xóa Preset này?')) {
            chrome.runtime.sendMessage({ type: 'DELETE_PRESET', id: selectedId }, () => {
                renderPresets();
            });
        }
    });

    // 5. Allowed Workspaces Configuration
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

    // 6. Render Audit Logs
    function renderAuditLogs() {
        chrome.runtime.sendMessage({ type: 'GET_AUDIT_LOGS' }, (response) => {
            if (!response || !response.logs || response.logs.length === 0) {
                logList.innerHTML = '<div class="empty-log">Chưa có lịch sử thao tác nào</div>';
                return;
            }

            logList.innerHTML = response.logs.map(log => {
                let tagClass = 'tag-default';
                if (log.tool === 'write_file') tagClass = 'tag-write';
                else if (log.tool === 'read_file' || log.tool === 'read_image') tagClass = 'tag-read';
                else if (log.tool === 'list_directory') tagClass = 'tag-list';
                else if (log.tool === 'execute_command' || log.tool === 'google_search' || log.tool === 'fetch_url') tagClass = 'tag-exec';
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
        renderPresets();
        renderAllowedDirs();
        renderAuditLogs();
    });

    // Initial Load
    checkServerStatus();
    renderPresets();
    renderAllowedDirs();
    renderAuditLogs();
});
