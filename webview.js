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
let autocompleteUsed = false;

/** Creates a div element showing context file count (current/total). */
const createNumberOfFiles = (fileCount) => {
    const files = document.createElement('div');
    files.id = 'file-number'
    files.innerText = `${fileCount}/${maxFiles}`
    if (fileCount == maxFiles) {
        files.style.opacity = '60%';
    }
    return files;
}

/** Updates displayed context file count in the UI. */
const replaceContextFileCount = (size) => {
    const newCount = createNumberOfFiles(size);
    const oldCount = contextFiles.lastElementChild;
    contextFiles.replaceChild(newCount, oldCount);
}

/** Removes a deleted context file from storage and UI. */
const removeDeletedContext = (location) => {
    const index = contextedFilesStorage.findIndex((val) => val[0] == location);
    contextedFilesStorage.splice(index, 1);
    vscode.postMessage({ command: 'fileContext', key: location });
    if (contextedFilesStorage.length == 0) contextFiles.style.display = 'none';
    replaceContextFileCount(contextedFilesStorage.length);
}

/** Creates UI element for a context file with remove button. */
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

/** Renders all context files in the UI with count display. */
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

/** Formats user questions by highlighting '@mentioned' files. */
const formatUserQuestion = (text) => {
    text = text.replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>');
    return text.replace(regEx, (match) => {
        const title = match.substring(1);
        if (!(title in fileTitlesWithLocations)) return match;
        return "<code>" + match + "</code>";
    });
};

/** Creates a 'Run' button for executable code blocks. */
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

/** Creates a 'Copy' button for code blocks. */
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

/** Adds action buttons (run/copy) to code blocks in responses. */
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

/** Creates UI for cancelable code blocks for mentioned code. */
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

/** Adds copy buttons to all existing code blocks. */
const addCopyButtons = () => {
    document.querySelectorAll("#chat-history pre code").forEach(codeBlock => {
        generateButtons(codeBlock, null);
    });
};

/** Highlights new code blocks and adds interaction buttons. */
const highlightNewCodeBlocks = (currentTime = Date.now()) => {
    const newCodeBlocks = document.querySelectorAll("#chat-history pre code:not(.hljs)");
    newCodeBlocks.forEach(codeBlock => {
        hljs.highlightElement(codeBlock);
        generateButtons(codeBlock, currentTime);
        codeBlock.classList.add('hljs');
    });
};

/** Applies syntax highlighting to mentioned code blocks. */
const highlightMentionedCodeBlock = () => {
    document.querySelectorAll("#content pre code").forEach(codeBlock => {
        hljs.highlightElement(codeBlock);
        cancelButtons(codeBlock);
        codeBlock.classList.add('hljs');
    });
};

/** Initial syntax highlighting setup for all code blocks. */
const highlightAllCodeBlocks = () => {
    hljs.highlightAll();
    addCopyButtons();
};

/** Generates a delete button for a chat entry. */
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

/** Adds delete buttons to all existing chat entries. */
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

/** Toggles output filename input based on checkbox state. */
const handleDisable = (e) => {
    e.preventDefault();
    outputFileNameInput.disabled = !writeToFileCheckbox.checked;
    vscode.postMessage({ command: 'outputToFile', checked: writeToFileCheckbox.checked });
};

writeToFileCheckbox.addEventListener('change', handleDisable);

/** Appends a new user question to chat history, and creates a div for the response. */
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

/** Finds start index of difference between two strings. */
const findChangeStart = (oldStr, newStr) => {
  const minLen = Math.min(oldStr.length, newStr.length);
  for (let i = 0; i < minLen; i++) {
    if (oldStr[i] !== newStr[i]) return i;
  }
  return minLen;
}

/** Adjusts file mention indexes after prompt changes, and removes them if necessary. */
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

/** Verifies '@mentioned' files exist in workspace before sending. */
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

/** Finds boundaries of current word at cursor position. */
const startAndEndIndexForCursorWord = (value, start) => {
    let startIndex = value.substring(0, start).lastIndexOf(' ');
    let endIndex = value.substring(start).indexOf(' ');
    startIndex = startIndex == -1 ? 0 : startIndex + 1;
    endIndex = endIndex == -1 ? value.length : endIndex + start;
    return [startIndex, endIndex];
}

/** Gets word at current cursor position. */
const findCurrentCursorWord = (value, start) => {
    lastCursorPosition = start;
    const [startIndex, endIndex] = startAndEndIndexForCursorWord(value, start);
    return value.substring(startIndex, endIndex);
}

/** Returns the correct current auto-complete filename candidate, the filename and the start index. */
const getCorrectFilename = (string) => {
    const initialMatch = string.match(regEx);
    const [startIndex, endIndex] = startAndEndIndexForCursorWord(prompt.value, lastCursorPosition);
    const relativeCursorPosition = lastCursorPosition - startIndex;
    let word;
    let wordStartIndex;

    if (!initialMatch) return [];
    if (initialMatch.length > 1) {
        let match;
        while ((match = regEx.exec(string)) !== null) {
            const start = match.index;
            const end = start + match[0].length;
            if (start > relativeCursorPosition) break;
            if (start <= relativeCursorPosition && end >= relativeCursorPosition) {
                word = match[0];
                wordStartIndex = startIndex + start;
                break;
            }
        }
    } else {
        const matchedWord = initialMatch[0];
        const matchedStart = startIndex + string.indexOf(matchedWord);
        const matchedEnd = matchedStart + matchedWord.length;
        if (matchedStart <= lastCursorPosition && matchedEnd >= lastCursorPosition) {
            word = matchedWord;
            wordStartIndex = matchedStart;
        }
    }

    return [word, wordStartIndex];
}

/** Replaces cursor word with selected filename from autocomplete. */
const replaceCursorWord = (start, fileInfo) => {
    const value = prompt.value;
    const [word, location] = fileInfo;
    const [stringStart, stringEnd] = startAndEndIndexForCursorWord(value, start);
    const [wordChange, startIndex] = getCorrectFilename(value.substring(stringStart, stringEnd));
    if (!wordChange) return;

    const endIndex = startIndex + wordChange.length;
    const addWord = value.substring(0, startIndex+1) + word;
    const cursorPosition = addWord.length;
    
    prompt.value = addWord + value.substring(endIndex);
    prompt.focus();
    prompt.setSelectionRange(cursorPosition, cursorPosition);
    
    mentionedFiles[startIndex] = [word, location];
    fileSearch.replaceChildren();
    fileSearch.style.display = 'none';
}

/** Creates clickable file autocomplete suggestions. */
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
        autocompleteUsed = true;
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

/** Orders file options based on mention status, position, and alphabetical order. */
const orderFileOptions = (options) => {
    return options.sort((a, b) => {
        const [fileNameA, locationA] = a;
        const [fileNameB, locationB] = b;

        const entryA = Object.entries(mentionedFiles).find(
            ([key, [name, loc]]) => name === fileNameA && loc === locationA
        );
        const entryB = Object.entries(mentionedFiles).find(
            ([key, [name, loc]]) => name === fileNameB && loc === locationB
        );

        const isMentionedA = !!entryA;
        const isMentionedB = !!entryB;

        if (isMentionedA && !isMentionedB) return -1;
        if (!isMentionedA && isMentionedB) return 1;
        if (isMentionedA && isMentionedB) {
            const keyA = parseInt(entryA[0]);
            const keyB = parseInt(entryB[0]);
            return keyB - keyA;
        }

        const nameCompare = fileNameA.localeCompare(fileNameB);
        if (nameCompare !== 0) return nameCompare;        
        return locationA.localeCompare(locationB);
    });
};

/** Displays the filename suggestions dropdown. */
const showFileOptions = (string) => {
    fileSearch.replaceChildren();
    const [word, start] = getCorrectFilename(string);

    if (!word) {
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

    let flatOptions = [];
    for (const [fileName, locations] of options) {
        for (const loc of locations) {
            flatOptions.push([fileName, loc]);
        }
    }

    const orderedOptions = orderFileOptions(flatOptions);
    for (const [fileName, location] of orderedOptions) {
        const row = createSearchItem(fileName, location);
        fileSearch.appendChild(row);
    }

    fileSearch.style.display = 'flex';
};


/** Calculates the Levenshtein distance between two strings. */
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

/** Normalizes whitespace in a string. */
const normalizeString = (str) => {
  return str
    .replace(/\s+/g, ' ')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\r\n|\r/g, '\n');
}

/** Escapes special characters in a string. */
const escapeString = (str) => {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** Compares code blocks with high similarity threshold. */
const comapreCodeBlock = (codeBlock, value) => {
    const normCode = escapeString(normalizeString(codeBlock));
    const normValue = escapeString(normalizeString(value));
    const distance = levenDist(normCode, normValue);
    const maxLength = Math.max(normCode.length, normValue.length);
    const similarity = (1 - distance / maxLength);
    return similarity >= 0.95;
}

const generateLLMDropdownValues = (names, index) => {
    llmSelect.innerHTML = "";
    for (let i = 0; i < names.length; i++) {
        const option = document.createElement("option");
        option.text = names[i];
        option.value = i;
        llmSelect.appendChild(option);
    }
    
    llmSelect.value = index;
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
    autocompleteUsed = false;
    if (event.key == "Enter" && !event.shiftKey && ask.innerText == "Ask" && !ask.disabled) {
        event.preventDefault();
        queue = [];
        ask.click();
    } else if (event.code == "Backspace") {
        verifyMentionedFiles();
    }
})

prompt.addEventListener("input", (event) => {
    autocompleteUsed = false;
    mentionedFiles = shiftStartIndexes(prevPrompt, prompt.value);
    vscode.postMessage({ command: 'updatePrompt', value: prompt.value, files: mentionedFiles });
});

prompt.addEventListener("selectionchange", (event) => {
    if (autocompleteUsed) return;
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
    } else if (command == 'configUpdate') {
        if (key == "models") generateLLMDropdownValues(value.names, value.index);
        else if (key == "fileSize") maxFiles = value;
    }
});