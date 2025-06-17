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
const regEx = new RegExp("\\B\\@[\\[\\]a-zA-Z]+\\.[a-zA-Z]+", "g");

let prevCommand = null;
let prevFile = null;
let prevPrompt = "";

let baseWorkspacePath = null;
let lastCursorPosition = 0;
let maximumVal = 0;
let fileTitlesWithLocations = {};
let mentionedFiles = {};

const formatUserQuestion = (text) => {
    text = DOMPurify.sanitize(text);
    text = text.replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>');

    return text.replace(regEx, (match) => {
        return "<code>" + match + "</code>";
    });
};

const copyButtons = (codeBlock) => {
    const container = document.createElement('div');
    const button = document.createElement('button');

    container.classList.add('code-container');
    codeBlock.parentNode.insertBefore(container, codeBlock);
    container.appendChild(codeBlock);
    button.innerText = 'Copy';
    button.classList.add('copy-button');

    button.onclick = () => {
        const codeToCopy = codeBlock.textContent;
        vscode.postMessage({ command: 'copy', text: codeToCopy });
        button.innerText = 'Copied!';
        setTimeout(() => button.innerText = 'Copy', 2000);
    };

    container.appendChild(button);
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
        copyButtons(codeBlock);
    });
};

const highlightNewCodeBlocks = () => {
    const newCodeBlocks = document.querySelectorAll("#chat-history pre code:not(.hljs)");
    newCodeBlocks.forEach(codeBlock => {
        hljs.highlightElement(codeBlock);
        copyButtons(codeBlock);
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

highlightAllCodeBlocks();

llmSelect.addEventListener('change', () => {
    const selectedIndex = llmSelect.value;
    vscode.postMessage({ command: 'selectLLM', index: selectedIndex });
});

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
    })
    item.addEventListener('keydown', (event) => {
        if (event.key == 'Enter') {
            event.preventDefault();
            replaceCursorWord(lastCursorPosition, [file, value]);
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

clearHistory.addEventListener("click", () => {
    vscode.postMessage({ command: 'clearHistory' });
})

prompt.addEventListener("keydown", (event) => {
    if (event.key == "Enter" && !event.shiftKey && ask.innerText == "Ask" && !ask.disabled) {
        event.preventDefault();
        ask.click();
    }
})

prompt.addEventListener("input", (event) => {
    mentionedFiles = shiftStartIndexes(prevPrompt, prompt.value);
    let cursorWord = findCurrentCursorWord(event.target.value, event.target.selectionStart);
    showFileOptions(cursorWord);
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
    } else {
        vscode.postMessage({ command: "stopResponse" });
    }
});

window.addEventListener("message", (e) => {
    const { command, text, value } = e.data;

    if (command == "response") {
        responseArea.lastElementChild.querySelector('.response').innerHTML = text;
        highlightNewCodeBlocks();
    } else if (command == "loading") {
        responseArea.lastElementChild.querySelector('.response').innerHTML = text;
    } else if (command == "error") {
        responseArea.lastElementChild.querySelector('.response').innerText = text;
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
        }
    } else if (command == 'disableAsk') {
        ask.disabled = true;
    } else if (command == 'fileTitles') {
        fileTitlesWithLocations = value;
    } else if (command == 'workspacePath') {
        baseWorkspacePath = value;
    }
});