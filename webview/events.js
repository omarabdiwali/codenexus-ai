llmSelect.addEventListener('change', () => {
    const selectedIndex = llmSelect.value;
    vscode.postMessage({ command: 'selectLLM', index: selectedIndex });
});

llmMode.addEventListener('change', (e) => {
    vscode.postMessage({ command: 'changeMode', value: llmMode.value });
})

outputFileNameInput.addEventListener("input", (e) => {
    let val = e.target.value;
    let filteredValue = val.replace(/[^a-zA-Z0-9]/g, '');
    e.target.value = filteredValue;
})

writeToFileCheckbox.addEventListener('change', (e) => {
    e.preventDefault();
    outputFileNameInput.disabled = !writeToFileCheckbox.checked;
    vscode.postMessage({ command: 'outputToFile', checked: writeToFileCheckbox.checked });
});

clearHistory.addEventListener("click", () => {
    vscode.postMessage({ command: 'clearHistory' });
})

settings.addEventListener("click", () => {
    vscode.postMessage({ command: "openSettings" });
})

refreshFiles.addEventListener("click", () => {
    refreshFiles.disabled = true;
    vscode.postMessage({ command: "refreshFiles" });
})

updateKey.addEventListener("click", () => {
    vscode.postMessage({ command: 'updateApiKey' });
})

openMediaFolder.addEventListener("click", () => {
    vscode.postMessage({ command: 'mediaFolder' });
})

question.addEventListener("keydown", (event) => {
    autocompleteUsed = false;
    if (event.key == "Enter" && !event.shiftKey && ask.innerText == "Ask" && !ask.disabled) {
        event.preventDefault();
        queue = [];
        ask.click();
    } else if (event.key == "ArrowDown") {
        if (fileSearch.childElementCount) {
            event.preventDefault();
            fileSearch.children[0].focus();
        }
    }
})

question.addEventListener("input", (event) => {
    autocompleteUsed = false;
    updateContextFiles();
    vscode.postMessage({ command: 'updateQuestion', value: question.value, files: mentionedFiles });
});

question.addEventListener("selectionchange", (event) => {
    if (autocompleteUsed) return;
    let cursorWord = findCurrentCursorWord(event.target.value, event.target.selectionStart);
    showFileOptions(cursorWord);
})

ask.addEventListener("click", () => {
    if (ask.innerText == "Ask") {
        const text = question.value.trim();
        if (text.length == 0) return;
        question.value = "";
        verifyMentionedFiles(text);
        vscode.postMessage({ command: 'chat', mentionedFiles, text, writeToFile: writeToFileCheckbox.checked, outputFile: outputFileNameInput.value });
        mentionedFiles = {};
        fileSearch.replaceChildren();
        fileSearch.style.display = 'none';
    } else {
        vscode.postMessage({ command: "stopResponse" });
    }
});

newSessions.addEventListener('click', () => {
    vscode.postMessage({ command: 'newSession' });
})

sessionList.addEventListener('click', (e) => {
    const target = e.target;
    const deleteBtn = target.closest('.session-delete');

    if (deleteBtn) {
        e.stopPropagation();
        const sessionId = deleteBtn.dataset.sessionId;
        const sessionItem = target.closest('.session-item');
        vscode.postMessage({
            command: 'deleteSession',
            id: sessionId
        })

        if (sessionItem) sessionItem.remove();
        return;
    }

    const sessionItem = target.closest('.session-item');
    if (sessionItem) {
        const switchBtn = sessionItem.querySelector('.all-sessions');
        if (switchBtn && !sessionItem.classList.contains('active')) {
            vscode.postMessage({
                command: 'changeSession',
                id: switchBtn.id
            });
        }
    }
});

toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    body.classList.toggle('sidebar-visible');
    body.classList.toggle('sidebar-hidden');
});

document.addEventListener('click', (e) => {
    if (body.classList.contains('sidebar-visible')) {
        const target = e.target;
        if (!sessionPanel.contains(target)) {
            body.classList.remove('sidebar-visible');
            body.classList.add('sidebar-hidden');
        }
    }
})

fileInput.addEventListener('change', (e) => {
    const incomingFiles = Array.from(e.target.files);
    const storedKeys = storedFiles.map(getFileKey);
    const uniqueFiles = incomingFiles.filter(newFile => {
        const newFileKey = getFileKey(newFile);
        return !storedKeys.includes(newFileKey);
    });

    if (uniqueFiles.length == 0) return;
    storedFiles = [...storedFiles, ...uniqueFiles];
    renderPreviews();
    e.target.value = "";
})

// Message handler
window.addEventListener("message", (e) => {
    const { command, text, value, key } = e.data;

    if (command == "response") {
        if (!(responseArea.lastElementChild)) return;
        responseArea.lastElementChild.querySelector('.response').innerHTML = text;
        if (value) {
            highlightNewCodeBlocks(lastMatching + 5000);
            generateChatEntryButtons(responseArea.lastElementChild, key);
        } else highlightNewCodeBlocks();
    } else if (command == "loading") {
        if (!(responseArea.lastElementChild)) return;
        responseArea.lastElementChild.querySelector('.response').innerHTML = text;
    } else if (command == "error") {
        if (!(responseArea.lastElementChild)) return;
        responseArea.lastElementChild.querySelector('.response').innerText = text;
        generateChatEntryButtons(responseArea.lastElementChild, key);
    } else if (command == 'chat') {
        appendToChat(text, value);
        highlightNewCodeBlocks();
    } else if (command == 'focus') {
        question.focus();
    } else if (command == 'content') {
        mentionedCode.innerHTML = text;
        highlightSnippet();
    } else if (command == 'history') {
        if (value) responseArea.replaceChildren(responseArea.lastElementChild);
        else responseArea.replaceChildren();
    } else if (command == 'changeAsk') {
        if (value) {
            ask.classList.replace("ask-chat", "cancel-response");
            ask.innerText = "Stop";
            ask.disabled = false;
        } else {
            ask.classList.replace("cancel-response", "ask-chat");
            ask.innerText = "Ask";
            ask.disabled = false;
            newSessions.disabled = false;
            lastMatching = 0;
            alreadyMatched = {};
        }
    } else if (command == 'disableAsk') {
        ask.disabled = true;
        newSessions.disabled = true;
    } else if (command == 'fileTitles') {
        fileTitlesWithLocations = value;
        refreshFiles.disabled = false;
    } else if (command == 'workspacePath') {
        baseWorkspacePath = value;
    } else if (command == 'fileContext') {
        contextedFilesStorage = value;
        addContextedFiles();
    } else if (command == 'pythonProg') {
        queue.push([key, text]);
    } else if (command == 'questionValue') {
        question.value = text;
        mentionedFiles = value;
    } else if (command == 'updateValues') {
        const [toFile, agent, index, fileSize, outputFileName, sessions, currentSession, savedFiles] = value;
        writeToFileCheckbox.checked = toFile;
        outputFileNameInput.disabled = !writeToFileCheckbox.checked;
        outputFileNameInput.value = outputFileName == "output" ? "" : outputFileName;
        llmMode.value = `${agent}`;
        llmSelect.value = index;
        maxFiles = fileSize;
        contextFileElements.changeSize(maxFiles);
        question.placeholder = `Type your message here, with @file.ext to mention files (max ${maxFiles}), and using tab to select the correct one...`;
        updateSessionTitles(sessions, currentSession);
        storedFiles = revertFilesFromExtension(savedFiles);
        renderPreviews();
    } else if (command == 'configUpdate') {
        if (key == "models") generateLLMDropdownValues(value.names, value.index);
        else if (key == "fileSize") {
            maxFiles = value;
            contextFileElements.changeSize(maxFiles);
            question.placeholder = `Type your message here, with @file.ext to mention files (max ${maxFiles}), and using tab to select the correct one...`;
        }
    } else if (command == 'canDelete') {
        const sessionItem = document.querySelector(`div[data-session-id="${text}"]`);
        if (!sessionItem) return;
        const deleteButton = sessionItem.querySelector('.session-delete');
        if (!deleteButton) return;
        deleteButton.style.display = value ? 'block' : 'none';
        newSessions.disabled = !value;
    } else if (command == 'updateTitle') {
        const sessionItem = document.querySelector(`div[data-session-id="${text}"]`);
        if (!sessionItem) return;
        const sessionTitle = sessionItem.querySelector('.session-title');
        if (!sessionTitle) return;
        sessionItem.title = value;
        sessionTitle.innerText = value;
    } else if (command == 'generateHeaders') {
        generateCodeHeaders(value);
    }
});