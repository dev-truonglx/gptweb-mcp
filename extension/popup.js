function updateStatus(status, message = '') {
    const statusEl = document.getElementById('status');
    if (status === 'connected') {
        statusEl.innerText = 'Connected';
        statusEl.style.color = 'green';
    } else if (status === 'connecting') {
        statusEl.innerText = 'Connecting...';
        statusEl.style.color = 'orange';
    } else {
        statusEl.innerText = message ? `Error: ${message}` : 'Disconnected';
        statusEl.style.color = 'red';
    }
}

// Check status immediately when popup opens
chrome.runtime.sendMessage({type: 'CHECK_STATUS'}, (response) => {
    if (chrome.runtime.lastError) {
        updateStatus('error', chrome.runtime.lastError.message);
        return;
    }
    if (response) {
        updateStatus(response.status, response.message);
    }
});

document.getElementById('connectBtn').addEventListener('click', () => {
    updateStatus('connecting');
    chrome.runtime.sendMessage({type: 'CONNECT'}, (response) => {
        if (chrome.runtime.lastError) {
            updateStatus('error', chrome.runtime.lastError.message);
            return;
        }
        if (response) {
            updateStatus(response.status, response.message);
        }
    });
});
