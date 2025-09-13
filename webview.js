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
const openMediaFolder = document.getElementById('media-folder');
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

/**
 * An LRUCache that is used for handling the number of files for context.
 */
class LRUCache {
    constructor(capacity) {
        this.cache = new Map();
        this.capacity = capacity;
    }
    put(key, value) {
        this.cache.delete(key);
        if (this.cache.size === this.capacity) {
            this.cache.delete(this.cache.keys().next().value);
            this.cache.set(key, value);
        } else {
            this.cache.set(key, value);
        }
    }
    delete(key) {
        this.cache.delete(key);
    }
    changeSize(size) {
        if (this.cache.size > size) {
            const overflow = this.cache.size - size;
            for (let i = 0; i < overflow; i++) {
                this.cache.delete(this.cache.keys().next().value)
            }
        }
        this.capacity = size;
    }
    has(key) {
        return this.cache.has(key);
    }
    clear() {
        this.cache.clear();
    }
}

const contextFileElements = new LRUCache(maxFiles);

/**
 * Creates a div element showing context file count (current/total).
 * @param {number} fileCount - The current number of context files.
 * @returns {HTMLDivElement} The file count element.
 */
const createNumberOfFiles = (fileCount) => {
    const files = document.createElement('div');
    fileCount = Math.min(maxFiles, fileCount);
    files.id = 'file-number'
    files.innerText = `${fileCount}/${maxFiles}`
    if (fileCount == maxFiles) {
        files.style.opacity = '60%';
    }
    return files;
}

/**
 * Handles the display of the `contextFiles` element, and the file count.
 */
const showContextFiles = () => {
    const current = contextFiles.style.display;
    const numberCount = contextFiles.children.namedItem("file-number")
    const children = numberCount ? contextFiles.childElementCount - 1 : contextFiles.childElementCount;

    if (current == "flex") {
        if (children == 0) {
            contextFiles.style.display = 'none';
        }
    } else {
        if (children > 0) {
            contextFiles.style.display = 'flex';
        }
    }

    contextFiles.style.display == 'flex' && replaceContextFileCount(children);
    showFileMentions();
}

/**
 * Shows the last `maxFiles` number of mentioned files, and adapts when `maxFiles` is updated.
 */
const showFileMentions = () => {
    const children = Array.from(contextFiles.children);
    for (const child of children) {
        if (child.id == "file-number") {
            child.style.display = 'flex';
        } else if (contextFileElements.has(child.dataset.unique)) {
            child.style.display = 'flex';
        } else {
            child.style.display = 'none';
        }
    }
}

/**
 * Updates displayed context file count in the UI.
 * @param {number} size - The new file count to display.
 */
const replaceContextFileCount = (size) => {
    const newCount = createNumberOfFiles(size);
    const oldCount = contextFiles.querySelector("#file-number");
    if (oldCount) {
        contextFiles.removeChild(oldCount);
        contextFiles.appendChild(newCount);
    } else {
        contextFiles.appendChild(newCount);
    }
}

/**
 * Deletes a specified child from the `contextFiles` element.
 * @param {string} location - The file path of the context file child to remove.
 */
const deleteContextFileChild = (location) => {
    const children = Array.from(contextFiles.children);
    for (const child of children) {
        if (child.dataset.unique == location) {
            contextFiles.removeChild(child);
            break;
        }
    }
}

/**
 * 
 * @param {string} location - The unique identifier for the element: the location of the file.
 * @returns {boolean} `true` if the element exists, `false` otherwise.
 */
const contextFileElementExists = (location) => {
    return Array.from(contextFiles.children).some((child) => child.dataset.unique == location);
}

/**
 * Removes a deleted context file from storage and UI.
 * @param {string} location - The file path of the context file to remove.
 */
const removeDeletedContext = (location) => {
    const index = contextedFilesStorage.findIndex((val) => val[0] == location);
    contextedFilesStorage.splice(index, 1);
    contextFileElements.delete(location);
    vscode.postMessage({ command: 'fileContext', key: location });
    showContextFiles();
}

/**
 * Removes all mentioned files children from `contextFiles` element.
 */
const removeMentionedFiles = () => {
    const children = contextFiles.querySelectorAll(`.temp-mention`);
    children.forEach((child) => {
        contextFiles.removeChild(child);
    })
}

/**
 * Checks if a file is already being shown, from either the `contextedFileStorage`, or within the `contextFiles` element.
 * @param {string} className - The className to target within `contextFiles`.
 * @param {string} location - The unique identifier for the element: the location of the file.
 * @returns {boolean} `true` if the element exists, `false` otherwise.
 */
const alreadyShowingFiles = (className, location) => {
    if (className != 'temp-mention') return false;
    const children = contextFiles.querySelectorAll(`.${className}`);
    const child = Array.from(children).some((val) => val.dataset.unique == location);
    const alreadySaved = contextedFilesStorage.findIndex((val) => val[0] == location);
    return (child || alreadySaved != -1) ? true : false;
}

/**
 * Updates `mentionedFiles` using the most recent `prompt` value, keeping it up to date.
 */
const updateMentionedFiles = () => {
    const value = prompt.value;
    let match;
    let verified = {};

    while ((match = regEx.exec(value)) != null) {
        const key = match.index;
        const filename = match[0].substring(1);
        const keyExists = key in mentionedFiles && mentionedFiles[key][0] == filename; 
        const isValidFile = keyExists && filename in fileTitlesWithLocations && fileTitlesWithLocations[filename].includes(mentionedFiles[key][1]);

        if (isValidFile) {
            const location = mentionedFiles[key][1];
            verified[key] = mentionedFiles[key];
            contextFileElements.put(location, filename);
        } else if (filename in fileTitlesWithLocations) {
            const location = fileTitlesWithLocations[filename][0];
            verified[key] = [filename, location];
            contextFileElements.put(location, filename);
        } else if (contextFileElementExists(location)) {
            deleteContextFileChild(location);
        }
    }

    mentionedFiles = verified;
}

/**
 * Updates `contextFiles`, keeping it parallel with the current `mentionedFiles`.
 */
const updateContextFiles = () => {
    removeMentionedFiles();
    contextFileElements.clear();

    for (const [location, filename] of contextedFilesStorage) {
        if (filename in fileTitlesWithLocations && fileTitlesWithLocations[filename].includes(location)) {
            contextFileElements.put(location, filename);
        } else if (contextFileElementExists(location)) {
            deleteContextFileChild(location);
        }
    }

    updateMentionedFiles();

    for (const [key, fileDetails] of Object.entries(mentionedFiles)) {
        const [filename, location] = fileDetails;
        createContextedFileElement(filename, location, 'temp-mention');
    }
    
    showContextFiles();
}

/**
 * Creates UI element for a context file with remove button.
 * @param {string} filename - The name of the file.
 * @param {string} location - The full path of the file.
 * @param {string} [className='file-mention'] - The className that the created element should have.
 * @returns {boolean} `true` if the element was created successfully, `false` otherwise.
 */
const createContextedFileElement = (filename, location, className='file-mention') => {
    if (!baseWorkspacePath || alreadyShowingFiles(className, location)) return false;

    const relativeLocation = location.substring(baseWorkspacePath.length + 1);
    const main = document.createElement('div');
    const name = document.createElement('div');
    const cancel = document.createElement('button');

    main.classList.add(className);
    main.dataset.unique = location;
    name.id = 'name';
    cancel.classList.add('close-button');

    main.key = location;
    main.title = relativeLocation;
    name.innerText = filename;
    cancel.innerText = 'x';
    cancel.style.paddingLeft = '7px';

    cancel.addEventListener('click', (e) => {
        main.remove();
        removeDeletedContext(location);
    })

    name.addEventListener('click', (e) => {
        vscode.postMessage({ command: "openFile", location });
    })

    main.appendChild(name);
    className == 'file-mention' && main.appendChild(cancel);
    contextFiles.appendChild(main);
    return true;
}

/**
 * Renders all context files in the UI with count display.
 */
const addContextedFiles = () => {
    contextFileElements.clear();
    contextFiles.replaceChildren();

    for (const [location, filename] of contextedFilesStorage) {
        if (filename in fileTitlesWithLocations && fileTitlesWithLocations[filename].includes(location)) {
            createContextedFileElement(filename, location);
            contextFileElements.put(location, filename);
        }
    }
    
    updateMentionedFiles();

    for (const [key, fileDetails] of Object.entries(mentionedFiles)) {
        const [filename, location] = fileDetails;
        createContextedFileElement(filename, location, "temp-mention");
        contextFileElements.put(location, filename);
    }

    showContextFiles();
}

/**
 * Formats user questions for the chat history by highlighting '@mentioned' files.
 * @param {string} text - The text to format.
 * @returns {string} The formatted text with highlighted mentions.
 */
const formatUserQuestion = (text) => {
    text = text.replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>');
    return text.replace(regEx, (match) => {
        const title = match.substring(1);
        if (!(title in fileTitlesWithLocations)) return match;
        return "<code>" + match + "</code>";
    });
};

/**
 * Creates a 'Run' button for executable code blocks.
 * @param {string} key - The key identifier for the code block.
 * @returns {HTMLButtonElement} The run button element.
 */
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

/**
 * Creates a 'Copy' button for code blocks.
 * @param {string} text - The text to copy.
 * @returns {HTMLButtonElement} The copy button element.
 */
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

/**
 * Creates a 'Copy' button for the chat entry, which will copy the response in Markdown format.
 * @param {HTMLElement} element - The element to assign the copy button top.
 * @param {string} key - The key identifier for the response element.
 */
const generateResponseCopyButton = (element, key) => {
    const copyButton = document.createElement('button');
    copyButton.innerHTML = `<i class="fa-solid fa-copy"></i>`;
    copyButton.classList.add('response-copy');
    copyButton.title = 'Copy'

    copyButton.onclick = () => {
        vscode.postMessage({ command: 'copyResponse', key });
        copyButton.innerHTML = '<i class="fa-solid fa-check"></i>';
        copyButton.title = 'Copied!'
        setTimeout(() => {
            copyButton.innerHTML = `<i class="fa-solid fa-copy"></i>`
            copyButton.title = 'Copy';
        }, 2000);
    }

    element.appendChild(copyButton);
}

/**
 * Generates a 'Delete' button for a chat entry.
 * @param {HTMLElement} chatEntry - The chat entry element.
 * @param {string} key - The key identifier for the chat entry.
 */
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

/**
 * Adds action buttons (run/copy) to code blocks in responses.
 * @param {HTMLElement} codeBlock - The code block element.
 * @param {number} currentTime - The current time for matching purposes.
 */
const generateButtons = (codeBlock, currentTime) => {
    const container = document.createElement('div');
    const buttonDiv = document.createElement('div');
    if (!codeBlock.textContent) return;
    const copyButton = generateCopyButton(codeBlock.textContent.trim());

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

/**
 * Creates UI for cancelable code blocks for mentioned code.
 * @param {HTMLElement} codeBlock - The code block element.
 */
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

/**
 * Adds copy buttons to all existing code blocks.
 */
const addCopyButtons = () => {
    document.querySelectorAll("#chat-history pre code").forEach(codeBlock => {
        generateButtons(codeBlock, null);
    });
};

/**
 * Highlights new code blocks and adds interaction buttons.
 * @param {number} currentTime - The current time for matching purposes.
 */
const highlightNewCodeBlocks = (currentTime = Date.now()) => {
    const newCodeBlocks = document.querySelectorAll("#chat-history pre code:not(.hljs)");
    newCodeBlocks.forEach(codeBlock => {
        hljs.highlightElement(codeBlock);
        generateButtons(codeBlock, currentTime);
        codeBlock.classList.add('hljs');
    });
};

/**
 * Applies syntax highlighting to mentioned code blocks.
 */
const highlightMentionedCodeBlock = () => {
    document.querySelectorAll("#content pre code").forEach(codeBlock => {
        hljs.highlightElement(codeBlock);
        cancelButtons(codeBlock);
        codeBlock.classList.add('hljs');
    });
};

/**
 * Initial syntax highlighting setup for all code blocks.
 */
const highlightAllCodeBlocks = () => {
    hljs.highlightAll();
    addCopyButtons();
};

/**
 * Adds the needed buttons to all existing chat entries.
 */
const addButtons = () => {
    document.querySelectorAll(".chat-entry").forEach((element) => {
        const responseElement = element.querySelector('.response');
        generateCloseButton(element, element.id);
        responseElement && generateResponseCopyButton(responseElement, element.id);
    })
}

highlightAllCodeBlocks();
addButtons();

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

/**
 * Toggles output filename input based on checkbox state.
 * @param {Event} e - The event object.
 */
const handleDisable = (e) => {
    e.preventDefault();
    outputFileNameInput.disabled = !writeToFileCheckbox.checked;
    vscode.postMessage({ command: 'outputToFile', checked: writeToFileCheckbox.checked });
};

writeToFileCheckbox.addEventListener('change', handleDisable);

/**
 * Appends a new user question to chat history, and creates a div for the response.
 * @param {string} question - The user's question.
 */
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

/**
 * Verifies '@mentioned' files exist in workspace before sending.
 * @param {string} value - The prompt value to check.
 */
const verifyMentionedFiles = (value) => {
    let match;
    let verified = {};

    while ((match = regEx.exec(value)) != null) {
        const key = match.index;
        const filename = match[0].substring(1);
        if (key in mentionedFiles && mentionedFiles[key][0] == filename) {
            verified[key] = mentionedFiles[key];
        } else if (filename in fileTitlesWithLocations) {
            verified[key] = [filename, fileTitlesWithLocations[filename][0]];
        }
    }

    mentionedFiles = verified;
}

/**
 * Finds boundaries of current word at cursor position.
 * @param {string} value - The text value.
 * @param {number} start - The cursor start position.
 * @returns {Array<number>} The start and end indexes of the word.
 */
const startAndEndIndexForCursorWord = (value, start) => {
    let startIndex = value.substring(0, start).lastIndexOf(' ');
    let endIndex = value.substring(start).indexOf(' ');
    startIndex = startIndex == -1 ? 0 : startIndex + 1;
    endIndex = endIndex == -1 ? value.length : endIndex + start;
    return [startIndex, endIndex];
}

/**
 * Gets word at current cursor position.
 * @param {string} value - The text value.
 * @param {number} start - The cursor start position.
 * @returns {string} The word at the cursor position.
 */
const findCurrentCursorWord = (value, start) => {
    lastCursorPosition = start;
    const [startIndex, endIndex] = startAndEndIndexForCursorWord(value, start);
    return value.substring(startIndex, endIndex);
}

/**
 * Returns the correct current auto-complete filename candidate, the filename and the start index.
 * @param {string} string - The string to search in.
 * @returns {Array} The word and start index, or empty array if not found.
 */
const getCorrectFilename = (string) => {
    const initialMatch = string.match(regEx);
    if (!initialMatch) return [];

    const [startIndex, endIndex] = startAndEndIndexForCursorWord(prompt.value, lastCursorPosition);
    let word;
    let wordStartIndex;

    if (initialMatch.length > 1) {
        const relativeCursorPosition = lastCursorPosition - startIndex;
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

/**
 * Replaces cursor word with selected filename from autocomplete.
 * @param {number} start - The start position of the word.
 * @param {Array} fileInfo - The file information [filename, location].
 */
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
    updateContextFiles();
}

/**
 * Creates clickable file autocomplete suggestions.
 * @param {string} file - The file name.
 * @param {string} value - The file path.
 * @param {number} idx - The current item index.
 * @param {number} total - The total number items to be created.
 * @returns {HTMLDivElement} The search item element.
 */
const createSearchItem = (file, value, idx, total) => {
    if (!baseWorkspacePath) return;
    const item = document.createElement('div');
    const location = value.substring(baseWorkspacePath.length + 1);

    item.key = idx;
    item.classList.add('search-item');
    item.innerHTML = `<b>${file}</b>: (<i>${location}</i>)`;
    item.tabIndex = "0"

    item.addEventListener('click', (event) => {
        autocompleteUsed = true;
        replaceCursorWord(lastCursorPosition, [file, value]);
        vscode.postMessage({ command: 'updatePrompt', value: prompt.value, files: mentionedFiles });
    })
    item.addEventListener('keydown', (event) => {
        if (event.key == 'Enter') {
            event.preventDefault();
            item.click();
        } else if (event.key == "ArrowUp") {
            event.preventDefault();
            if (idx == 0) prompt.focus();
            else {
                const prevIdx = (idx - 1 + total) % total;
                fileSearch.children[prevIdx].focus();
            }
        } else if (event.key == "ArrowDown") {
            event.preventDefault();
            const nextIdx = (idx + 1) % total;
            fileSearch.children[nextIdx].focus();
        }
    })
    return item;
}

/**
 * Orders file options based on mention status, position, and alphabetical order.
 * @param {Array} options - The file options to sort.
 * @returns {Array} The sorted file options.
 */
const orderFileOptions = (options) => {
    return options.sort((a, b) => {
        const [filenameA, locationA] = a;
        const [filenameB, locationB] = b;

        const entryA = Object.entries(mentionedFiles).find(
            ([key, [name, loc]]) => name === filenameA && loc === locationA
        );
        const entryB = Object.entries(mentionedFiles).find(
            ([key, [name, loc]]) => name === filenameB && loc === locationB
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

        const nameCompare = filenameA.localeCompare(filenameB);
        if (nameCompare !== 0) return nameCompare;
        return locationA.localeCompare(locationB);
    });
};

/**
 * Displays the filename suggestions dropdown.
 * @param {string} string - The string to search for matches.
 */
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
    for (const [filename, locations] of options) {
        for (const loc of locations) {
            flatOptions.push([filename, loc]);
        }
    }

    const orderedOptions = orderFileOptions(flatOptions);
    const totalLength = orderedOptions.length;
    let idx = 0;

    for (const [filename, location] of orderedOptions) {
        const row = createSearchItem(filename, location, idx, totalLength);
        idx += 1;
        fileSearch.appendChild(row);
    }

    fileSearch.style.display = 'flex';
};


/**
 * Calculates the Levenshtein distance between two strings.
 * @param {string} a - First string.
 * @param {string} b - Second string.
 * @returns {number} The Levenshtein distance.
 */
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

/**
 * Normalizes whitespace in a string.
 * @param {string} str - The string to normalize.
 * @returns {string} The normalized string.
 */
const normalizeString = (str) => {
  return str
    .replace(/\s+/g, ' ')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\r\n|\r/g, '\n');
}

/**
 * Escapes special characters in a string.
 * @param {string} str - The string to escape.
 * @returns {string} The escaped string.
 */
const escapeString = (str) => {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Compares code blocks with high similarity threshold.
 * @param {string} codeBlock - The code block to compare.
 * @param {string} value - The value to compare against.
 * @returns {boolean} `true` if the code blocks are similar, `false` otherwise.
 */
const comapreCodeBlock = (codeBlock, value) => {
    const normCode = escapeString(normalizeString(codeBlock));
    const normValue = escapeString(normalizeString(value));
    const distance = levenDist(normCode, normValue);
    const maxLength = Math.max(normCode.length, normValue.length);
    const similarity = (1 - distance / maxLength);
    return similarity >= 0.95;
}

/**
 * Generates dropdown values for LLM selection.
 * @param {Array<string>} names - The LLM names.
 * @param {number} index - The selected index.
 */
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

openMediaFolder.addEventListener("click", () => {
    vscode.postMessage({ command: 'mediaFolder' });
})

prompt.addEventListener("keydown", (event) => {
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

prompt.addEventListener("input", (event) => {
    autocompleteUsed = false;
    updateContextFiles();
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
        fileSearch.replaceChildren();
        fileSearch.style.display = 'none';
    } else {
        vscode.postMessage({ command: "stopResponse" });
    }
});

window.addEventListener("message", (e) => {
    const { command, text, value, key } = e.data;

    if (command == "response") {
        if (!(responseArea.lastElementChild)) return;
        responseArea.lastElementChild.querySelector('.response').innerHTML = text;
        if (value) {
            highlightNewCodeBlocks(lastMatching + 5000);
            generateCloseButton(responseArea.lastElementChild, key);
            generateResponseCopyButton(responseArea.lastElementChild, key)
        } else highlightNewCodeBlocks();
    } else if (command == "loading") {
        if (!(responseArea.lastElementChild)) return;
        responseArea.lastElementChild.querySelector('.response').innerHTML = text;
    } else if (command == "error") {
        if (!(responseArea.lastElementChild)) return;
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
        contextFileElements.changeSize(maxFiles);
        prompt.placeholder = `Type your message here, with @file.ext to mention files (max ${maxFiles}), and using tab to select the correct one...`;
    } else if (command == 'configUpdate') {
        if (key == "models") generateLLMDropdownValues(value.names, value.index);
        else if (key == "fileSize") {
            maxFiles = value;
            contextFileElements.changeSize(maxFiles);
            prompt.placeholder = `Type your message here, with @file.ext to mention files (max ${maxFiles}), and using tab to select the correct one...`;
        }
    }
});