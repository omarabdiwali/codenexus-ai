const vscode = acquireVsCodeApi();
const ask = document.getElementById("ask");
const prompt = document.getElementById("prompt");
const responseArea = document.getElementById("chat-history");
const llmSelect = document.getElementById("llmSelect");
const writeToFileCheckbox = document.getElementById("writeToFileCheckbox");
const outputFileNameInput = document.getElementById("outputFileNameInput");
const mentionedCode = document.getElementById("content");
const clearHistory = document.getElementById('clear-history');
const fileSearch = document.getElementById('file-options');
const contextFiles = document.getElementById('context-files');
const llmMode = document.getElementById('mode-select')
const settings = document.getElementById('open-settings');
const refreshFiles = document.getElementById('refresh-files');
const updateKey = document.getElementById('api-key');
const regEx = new RegExp(/\B@(?:[a-zA-Z0-9_.-]*[a-zA-Z0-9_-]+)/g);

let maxFiles = 3;
let prevPrompt = "";
let baseWorkspacePath = null;
let lastCursorPosition = 0;
let fileTitlesWithLocations = {};
let mentionedFiles = {};
let contextedFilesStorage = [];
let queue = [];
let lastMatching = 0;
let alreadyMatched = {};

const createNumberOfFiles = (fileCount) => {
    const files = document.createElement('div');
    files.id = 'file-number'
    files.innerText = `${fileCount}/${maxFiles}`
    if (fileCount == maxFiles) {
        files.style.opacity = '60%';
    }
    return files;
}

const replaceContextFileCount = (size) => {
    const newCount = createNumberOfFiles(size);
    const oldCount = contextFiles.lastElementChild;
    contextFiles.replaceChild(newCount, oldCount);
}

const removeDeletedContext = (location) => {
    const index = contextedFilesStorage.findIndex((val) => val[0] == location);
    contextedFilesStorage.splice(index, 1);
    vscode.postMessage({ command: 'fileContext', key: location });
    if (contextedFilesStorage.length == 0) contextFiles.style.display = 'none';
    replaceContextFileCount(contextedFilesStorage.length);
}

const createContextedFileElement = (fileName, location) => {
    if (!baseWorkspacePath) return false;

    const relativeLocation = location.substring(baseWorkspacePath.length + 1);
    const main = document.createElement('div');
    const name = document.createElement('div');
    const cancel = document.createElement('button');

    main.id = 'file-mention';
    name.id = 'name';
    cancel.classList.add('close-button');

    main.key = location;
    main.title = relativeLocation;
    name.innerText = fileName;
    cancel.innerText = 'x';
    cancel.style.paddingLeft = '7px';

    cancel.addEventListener('click', (e) => {
        main.remove();
        removeDeletedContext(location);
    })

    main.appendChild(name);
    main.appendChild(cancel);
    contextFiles.appendChild(main);
    return true;
}

const addContextedFiles = () => {
    contextFiles.replaceChildren();
    let fileCount = 0;

    for (const [location, fileName] of contextedFilesStorage) {
        if (createContextedFileElement(fileName, location)) fileCount += 1;
    }

    if (fileCount == 0) {
        contextFiles.style.display = 'none';
    } else {
        const files = createNumberOfFiles(fileCount);
        contextFiles.appendChild(files);
        contextFiles.style.display = 'flex';
    }
}

const formatUserQuestion = (text) => {
    text = text.replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>');
    return text.replace(regEx, (match) => {
        const title = match.substring(1);
        if (!(title in fileTitlesWithLocations)) return match;
        return "<code>" + match + "</code>";
    });
};

const generateRunButton = (key) => {
    const runButton = document.createElement('button');
    runButton.innerText = 'Run';
    runButton.classList.add('interactive-button');

    runButton.onclick = () => {
        vscode.postMessage({ command: "runProgram", key });
        runButton.remove()
    };

    return runButton;
}

const generateCopyButton = (text) => {
    const copyButton = document.createElement('button');
    copyButton.innerText = 'Copy';
    copyButton.classList.add('interactive-button');

    copyButton.onclick = () => {
        vscode.postMessage({ command: 'copy', text });
        copyButton.innerText = 'Copied!';
        setTimeout(() => copyButton.innerText = 'Copy', 2000);
    };

    return copyButton;
}

const generateButtons = (codeBlock, currentTime) => {
    const container = document.createElement('div');
    const buttonDiv = document.createElement('div');
    if (!codeBlock.textContent) return;
    const copyButton = generateCopyButton(codeBlock.textContent);

    container.classList.add('code-container');
    buttonDiv.classList.add('code-container-buttons');
    codeBlock.parentNode.insertBefore(container, codeBlock);
    container.appendChild(codeBlock);

    buttonDiv.appendChild(copyButton);
    const codeKey = codeBlock.textContent.trim();

    if (currentTime && currentTime - lastMatching > 1000 && !(codeKey in alreadyMatched)) {
        lastMatching = currentTime;
        for (const [key, value] of queue) {
            if (comapreCodeBlock(codeBlock.textContent.trim(), value.trim())) {
                const runButton = generateRunButton(key);
                buttonDiv.appendChild(runButton);
                alreadyMatched[codeKey] = key;
                break;
            }
        }
    } else if (codeKey in alreadyMatched) {
        const runButton = generateRunButton(alreadyMatched[codeKey]);
        buttonDiv.appendChild(runButton);
    }

    container.appendChild(buttonDiv);
};

const cancelButtons = (codeBlock) => {
    const container = document.createElement('div');    
    const header = document.createElement('div');
    const closeButton = document.createElement('button');

    header.classList.add('code-header');    
    closeButton.innerText = 'x';
    closeButton.classList.add('close-button');

    closeButton.onclick = () => {
        container.remove();
        vscode.postMessage({ command: "remove" });
    };

    header.appendChild(closeButton);
    codeBlock.parentNode.insertBefore(container, codeBlock);
    container.appendChild(header);
    container.appendChild(codeBlock);
};

const addCopyButtons = () => {
    document.querySelectorAll("#chat-history pre code").forEach(codeBlock => {
        generateButtons(codeBlock, null);
    });
};

const highlightNewCodeBlocks = (currentTime = Date.now()) => {
    const newCodeBlocks = document.querySelectorAll("#chat-history pre code:not(.hljs)");
    newCodeBlocks.forEach(codeBlock => {
        hljs.highlightElement(codeBlock);
        generateButtons(codeBlock, currentTime);
        codeBlock.classList.add('hljs');
    });
};

const highlightMentionedCodeBlock = () => {
    document.querySelectorAll("#content pre code").forEach(codeBlock => {
        hljs.highlightElement(codeBlock);
        cancelButtons(codeBlock);
        codeBlock.classList.add('hljs');
    });
};

const highlightAllCodeBlocks = () => {
    hljs.highlightAll();
    addCopyButtons();
};

const generateCloseButton = (chatEntry, key) => {
    const button = document.createElement('button');
    button.innerText = 'X';
    button.classList.add('delete-entry');
    button.onclick = () => {
        vscode.postMessage({ command: "deleteEntry", key });
        chatEntry.remove();
    }

    chatEntry.appendChild(button);
}

const addCloseButtons = () => {
    document.querySelectorAll(".chat-entry").forEach((element) => {
        generateCloseButton(element, element.id);
    })
}

highlightAllCodeBlocks();
addCloseButtons();

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

const handleDisable = (e) => {
    e.preventDefault();
    outputFileNameInput.disabled = !writeToFileCheckbox.checked;
    vscode.postMessage({ command: 'outputToFile', checked: writeToFileCheckbox.checked });
};

writeToFileCheckbox.addEventListener('change', handleDisable);

const appendToChat = (question) => {
    const chatEntry = document.createElement('div');
    chatEntry.classList.add('chat-entry');

    if (question.length > 0) {
        const questionDiv = document.createElement('div');
        questionDiv.classList.add('question');
        questionDiv.innerHTML = '<strong>You: </strong>' + formatUserQuestion(question);
        chatEntry.appendChild(questionDiv);
    }

    const responseDiv = document.createElement('div');
    responseDiv.classList.add('response');
    responseDiv.innerHTML = "";
    chatEntry.appendChild(responseDiv);

    responseArea.appendChild(chatEntry);
    responseArea.scrollTop = responseArea.scrollHeight;
}

const findChangeStart = (oldStr, newStr) => {
  const minLen = Math.min(oldStr.length, newStr.length);
  for (let i = 0; i < minLen; i++) {
    if (oldStr[i] !== newStr[i]) return i;
  }
  return minLen;
}

const shiftStartIndexes = (oldStr, newStr) => {
    const diffStart = findChangeStart(oldStr, newStr);
    const diffLength = newStr.length - oldStr.length;
    let newMentionedFiles = {};

    for (const [key, value] of Object.entries(mentionedFiles)) {
        const oldIndex = parseInt(key);
        let newIndex = oldIndex;
        if (oldIndex >= diffStart) newIndex = oldIndex + diffLength;
        if (newIndex < 0) continue;
        newMentionedFiles[newIndex] = value;
    }

    prevPrompt = newStr;
    return newMentionedFiles;
}

const verifyMentionedFiles = (value) => {
    let match;
    let verified = {};
    
    while ((match = regEx.exec(value)) != null) {
        const key = match.index;
        if (key in mentionedFiles) {
            verified[key] = mentionedFiles[key];
            continue;
        }
        const fileName = match[0].substring(1);
        if (fileName in fileTitlesWithLocations) {
            verified[key] = [fileName, fileTitlesWithLocations[fileName][0]];
        }
    }

    mentionedFiles = verified;
}

const startAndEndIndexForCursorWord = (value, start) => {
    let startIndex = value.substring(0, start).lastIndexOf(' ');
    let endIndex = value.substring(start).indexOf(' ');
    startIndex = startIndex == -1 ? 0 : startIndex + 1;
    endIndex = endIndex == -1 ? value.length : endIndex + start;
    return [startIndex, endIndex];
}

const findCurrentCursorWord = (value, start) => {
    lastCursorPosition = start;
    const [startIndex, endIndex] = startAndEndIndexForCursorWord(value, start);
    return value.substring(startIndex, endIndex);
}

const replaceCursorWord = (start, fileInfo) => {
    const value = prompt.value;
    const [word, location] = fileInfo;
    const [startIndex, endIndex] = startAndEndIndexForCursorWord(value, start);
    
    const previousCursorWord = value.substring(startIndex, endIndex);
    const addWord = value.substring(0, startIndex+1) + word;
    const cursorPosition = addWord.length;
    
    prompt.value = addWord + value.substring(endIndex);
    prompt.focus();
    prompt.setSelectionRange(cursorPosition, cursorPosition);
    
    mentionedFiles[startIndex] = [word, location];
    fileSearch.replaceChildren();
    fileSearch.style.display = 'none';
}

const createSearchItem = (file, value) => {
    if (!baseWorkspacePath) return;
    const item = document.createElement('div');
    const location = value.substring(baseWorkspacePath.length + 1);

    item.classList.add('search-item');
    item.innerHTML = `<b>${file}</b>: (<i>${location}</i>)`;
    item.tabIndex = "0"
    item.addEventListener('mouseover', (event) => {
        item.style.background = 'var(--vscode-input-background)';
    })
    item.addEventListener('mouseleave', (event) => {
        item.style.background = null;
    })
    item.addEventListener('click', (event) => {
        replaceCursorWord(lastCursorPosition, [file, value]);
        vscode.postMessage({ command: 'updatePrompt', value: prompt.value, files: mentionedFiles });
    })
    item.addEventListener('keydown', (event) => {
        if (event.key == 'Enter') {
            event.preventDefault();
            item.click();
        }
    })
    return item;
}

const showFileOptions = (word) => {
    fileSearch.replaceChildren();
    if (!word || word.at(0) != '@') {
        fileSearch.style.display = 'none';
        return;
    }

    const file = word.substring(1).trim();
    const options = [];
    for (const key of Object.keys(fileTitlesWithLocations)) {
        if (file && key.startsWith(file)) {
            options.push([key, fileTitlesWithLocations[key]]);
        }
    }

    if (!file || options.length == 0) {
        fileSearch.style.display = 'none';
        return;
    }

    for (const [fileName, locations] of options) {
        for (const loc of locations) {
            const row = createSearchItem(fileName, loc);
            fileSearch.appendChild(row);
        }
    }

    fileSearch.style.display = 'flex';
}

const levenDist = (a, b) => {
    const tmp = [];
    let i, j, alen = a.length, blen = b.length, score, alen1 = alen + 1, blen1 = blen + 1;

    for (i = 0; i < alen1; i++) {
        tmp[i] = [i];
    }
    for (j = 0; j < blen1; j++) {
        tmp[0][j] = j;
    }

    for (i = 1; i < alen1; i++) {
        for (j = 1; j < blen1; j++) {
            score = (a[i - 1] === b[j - 1]) ? 0 : 1;
            tmp[i][j] = Math.min(tmp[i - 1][j] + 1, tmp[i][j - 1] + 1, tmp[i - 1][j - 1] + score);
        }
    }
    return tmp[alen][blen];
}

const normalizeString = (str) => {
  return str
    .replace(/\s+/g, ' ')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\r\n|\r/g, '\n');
}

const escapeString = (str) => {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

const comapreCodeBlock = (codeBlock, value) => {
    const normCode = escapeString(normalizeString(codeBlock));
    const normValue = escapeString(normalizeString(value));
    const distance = levenDist(normCode, normValue);
    const maxLength = Math.max(normCode.length, normValue.length);
    const similarity = (1 - distance / maxLength);
    return similarity >= 0.95;
}

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

prompt.addEventListener("keydown", (event) => {
    if (event.key == "Enter" && !event.shiftKey && ask.innerText == "Ask" && !ask.disabled) {
        event.preventDefault();
        queue = [];
        ask.click();
    } else if (event.code == "Backspace") {
        verifyMentionedFiles();
    }
})

prompt.addEventListener("input", (event) => {
    mentionedFiles = shiftStartIndexes(prevPrompt, prompt.value);
    let cursorWord = findCurrentCursorWord(event.target.value, event.target.selectionStart);
    showFileOptions(cursorWord);
    vscode.postMessage({ command: 'updatePrompt', value: prompt.value, files: mentionedFiles });
});

prompt.addEventListener("click", (event) => {
    let cursorWord = findCurrentCursorWord(event.target.value, event.target.selectionStart);
    showFileOptions(cursorWord);
})

ask.addEventListener("click", () => {
    if (ask.innerText == "Ask") {
        const text = prompt.value.trim();
        if (text.length == 0) return;
        prompt.value = "";
        verifyMentionedFiles(text);
        vscode.postMessage({ command: 'chat', mentionedFiles, text, writeToFile: writeToFileCheckbox.checked, outputFile: outputFileNameInput.value });
        mentionedFiles = {};
        fileSearch.style.display = 'none';
    } else {
        vscode.postMessage({ command: "stopResponse" });
    }
});

window.addEventListener("message", (e) => {
    const { command, text, value, key } = e.data;

    if (command == "response") {
        responseArea.lastElementChild.querySelector('.response').innerHTML = text;
        if (value) {
            highlightNewCodeBlocks(lastMatching + 5000);
            generateCloseButton(responseArea.lastElementChild, key);
        } else highlightNewCodeBlocks();
    } else if (command == "loading") {
        responseArea.lastElementChild.querySelector('.response').innerHTML = text;
    } else if (command == "error") {
        responseArea.lastElementChild.querySelector('.response').innerText = text;
        generateCloseButton(responseArea.lastElementChild, key);
    } else if (command == 'chat') {
        appendToChat(text);
    } else if (command == 'focus') {
        prompt.focus();
    } else if (command == 'content') {
        mentionedCode.innerHTML = text;
        highlightMentionedCodeBlock();
    } else if (command == 'history') {
        if (value) responseArea.replaceChildren(responseArea.lastElementChild);
        else responseArea.replaceChildren();
    } else if (command == 'cancelView') {
        if (value) {
            ask.classList.replace("ask-chat", "cancel-response");
            ask.innerText = "Stop";
            ask.disabled = false;
        } else {
            ask.classList.replace("cancel-response", "ask-chat");
            ask.innerText = "Ask";
            ask.disabled = false;
            lastMatching = 0;
            alreadyMatched = {};
        }
    } else if (command == 'disableAsk') {
        ask.disabled = true;
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
    } else if (command == 'promptValue') {
        prompt.value = text;
        mentionedFiles = value;
    } else if (command == 'updateValues') {
        const [toFile, agent, index, fileSize] = value;
        writeToFileCheckbox.checked = toFile;
        outputFileNameInput.disabled = !writeToFileCheckbox.checked;
        llmMode.value = `${agent}`;
        llmSelect.value = index;
        maxFiles = fileSize;
    }
});