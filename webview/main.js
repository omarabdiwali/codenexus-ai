const vscode = acquireVsCodeApi();
const ask = document.getElementById("ask");
const question = document.getElementById("prompt");
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
const newSessions = document.getElementById('new-sessions');
const sessionList = document.getElementById('session-list');
const toggleBtn = document.getElementById('toggle-sidebar-btn');
const sessionPanel = document.getElementById('session-panel');
const fileInput = document.getElementById('file-input');
const previewContainer = document.getElementById('preview-container');
const filesDropdown = document.getElementById('files-dropdown');
const filesDropdownButton = document.getElementById('files-dropdown-button');
const body = document.body;
const regEx = new RegExp(/\B@(?:[a-zA-Z0-9_.-]*[a-zA-Z0-9_-]+)/g);

let maxFiles = 3;
let prevQuestion = "";
let baseWorkspacePath = null;
let lastCursorPosition = 0;
let fileTitlesWithLocations = {};
let mentionedFiles = {};
let contextedFilesStorage = [];
let queue = [];
let storedFiles = [];
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
 * Helper function to create a unique identifier for a file.
 * @param {File} file - The targeted file.
 * @returns {string} The unique file key.
 */
const getFileKey = (file) => {
    return `${file.name}-${file.size}-${file.lastModified}`;
};

/**
 * Renders the previews for the stored files.
 */
const renderPreviews = () => {
    sendStoredFiles();
    previewContainer.innerHTML = "";
    
    storedFiles.forEach((file, i) => {
        const reader = new FileReader();
        reader.onload = () => {
            const fileItem = document.createElement('div');
            fileItem.className = 'file-item';
            
            const img = document.createElement('img');
            img.src = reader.result;
            
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-btn';
            deleteBtn.textContent = 'x';
            deleteBtn.onclick = (e) => {
                e.preventDefault();
                const index = storedFiles.findIndex((f) => getFileKey(f) == getFileKey(file));
                index != -1 && index < storedFiles.length && storedFiles.splice(index, 1);
                fileItem.remove();
                sendStoredFiles();
                if (storedFiles.length == 0) {
                    filesDropdown.style.display = "none";
                } else {
                    filesDropdownButton.innerText = `Files (${storedFiles.length})`;
                }
            }

            fileItem.appendChild(img);
            fileItem.appendChild(deleteBtn);
            previewContainer.appendChild(fileItem);
        }

        reader.readAsDataURL(file);
    })

    if (filesDropdown.style.display == 'block') {
        if (storedFiles.length == 0) {
            filesDropdown.style.display = 'none';
        } else {
            filesDropdownButton.innerText = `Files (${storedFiles.length})`;
        }
    } else {
        if (storedFiles.length > 0) {
            filesDropdown.style.display = 'block';
            filesDropdownButton.innerText = `Files (${storedFiles.length})`;
        }
    }
}

/**
 * Translates and sends the stored files to the backend using `vscode.postMessage`.
 */
const sendStoredFiles = () => {
    const filePromises = storedFiles.map(file => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => {
                const base64Content = event.target.result;
                resolve({
                    name: file.name,
                    type: file.type,
                    lastModified: file.lastModified,
                    content: base64Content
                });
            };

            reader.onerror = (error) => reject(error);
            reader.readAsDataURL(file); 
        });
    });

    Promise.all(filePromises)
        .then(serializableFiles => {
            vscode.postMessage({
                command: 'attachments',
                files: serializableFiles
            });
        })
        .catch(error => {
            vscode.postMessage({ command: 'error', message: 'Failed to process files.' });
        });
};

/**
 * Converts file data (with binary content, e.g., Base64 or ArrayBuffer) 
 * received from the extension back into browser-compatible File objects.
 * @param {Array} serializableFiles - Array of objects containing file metadata and content.
 * @returns {Array} Array of browser File objects.
 */
const revertFilesFromExtension = (serializableFiles) => {
    if (!serializableFiles || serializableFiles.length === 0) {
        return [];
    }

    const reconstructedFiles = serializableFiles.map(fileData => {
        const { name, type, lastModified, content } = fileData;
        const base64Parts = content.split(',');
        const rawBase64 = base64Parts.length > 1 ? base64Parts[1] : base64Parts[0];
        const binary = atob(rawBase64); 
        const arrayBuffer = new ArrayBuffer(binary.length);
        const uint8Array = new Uint8Array(arrayBuffer);

        for (let i = 0; i < binary.length; i++) {
            uint8Array[i] = binary.charCodeAt(i);
        }

        const blob = new Blob([uint8Array], { type: type });
        const file = new File([blob], name, { type: type, lastModified: lastModified });
        return file;
    });

    return reconstructedFiles;
}

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
 * Updates `mentionedFiles` using the most recent `question` value, keeping it up to date.
 */
const updateMentionedFiles = () => {
    const value = question.value;
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
    const deleteButton = document.createElement('button');

    main.classList.add(className);
    main.dataset.unique = location;
    name.id = 'name';
    deleteButton.classList.add('close-button');

    main.key = location;
    main.title = relativeLocation;
    name.innerText = filename;
    deleteButton.innerText = 'x';
    deleteButton.style.paddingLeft = '7px';

    deleteButton.addEventListener('click', (e) => {
        main.remove();
        removeDeletedContext(location);
    })

    name.addEventListener('click', (e) => {
        vscode.postMessage({ command: "openFile", location });
    })

    main.appendChild(name);
    className == 'file-mention' && main.appendChild(deleteButton);
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
 * Sanitizes a string to be safely inserted into HTML.
 * @param {string} str The string to sanitize.
 * @returns {string} The sanitized string.
 */
const sanitizeString = (str) => {
    if (!str) return "";
    return str.replace(/[&<>"']/g, function (match) {
        return {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[match];
    });
}

/**
 * Formats user questions for the chat history by highlighting '@mentioned' files.
 * @param {string} text - The text to format.
 * @returns {string} The formatted text with highlighted mentions.
 */
const formatUserQuestion = (text) => {
    text = sanitizeString(text).replaceAll('\n', '<br>');
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
    runButton.innerHTML = '<i class="fa-solid fa-play"></i>';
    runButton.title = 'Run';
    runButton.classList.add('run-button');

    runButton.onclick = () => {
        vscode.postMessage({ command: "runProgram", key });
        runButton.remove()
    };

    return runButton;
}

/**
 * Creates a 'Copy' button for code blocks and chat entries.
 * @param {string} identifier - The text or id to copy.
 * @param {string} className - The className of the button.
 * @returns {HTMLButtonElement} The copy button element.
 */
const generateCopyButton = (identifier, className) => {
    const command = className == 'code-copy' ? 'copy' : 'copyResponse';
    const message = command == 'copy' ? { command, text: identifier } : { command, key: identifier };
    const title = command == 'copy' ? 'Copy Code' : 'Copy Response';

    const copyButton = document.createElement('button');
    copyButton.innerHTML = `<i class="fa-solid fa-copy"></i>`;
    copyButton.title = title;
    copyButton.classList.add(className);

    copyButton.onclick = () => {
        vscode.postMessage(message);
        copyButton.innerHTML = '<i class="fa-solid fa-check"></i>';
        copyButton.title = 'Copied!';
        copyButton.disabled = true;
        setTimeout(() => {
            copyButton.innerHTML = '<i class="fa-solid fa-copy"></i>';
            copyButton.title = title;
            copyButton.disabled = false;
        }, 2000);
    };

    return copyButton;
}

/**
 * Generates a 'Delete' button for a chat entry.
 * @param {HTMLElement} element - The chat entry element.
 * @param {string} key - The key identifier for the chat entry.
 * @returns {HTMLButtonElement} The delete button.
 */
const generateDeleteButton = (element, key) => {
    const button = document.createElement('button');
    button.innerHTML = `<i class="fa-solid fa-trash-can"></i>`;
    button.classList.add('delete-button');
    button.title = 'Delete Entry'
    button.onclick = () => {
        vscode.postMessage({ command: "deleteEntry", key });
        element.remove();
    }

    return button;
}

/**
 * Creates and applies the 'Copy' and 'Delete' buttons to the chat entry.
 * @param {HTMLElement} element - The chat entry element.
 * @param {string} key - The unique identifier for the chat entry.
 */
const generateChatEntryButtons = (element, key) => {
    const responseElement = element.querySelector('.response');
    if (!responseElement) return;

    const buttonDiv = document.createElement('div');
    const copyButton = generateCopyButton(key, 'response-button');
    const deleteButton = generateDeleteButton(element, key);

    buttonDiv.classList.add("code-container-buttons");
    buttonDiv.appendChild(copyButton);
    buttonDiv.appendChild(deleteButton);
    responseElement.appendChild(buttonDiv);
}

/**
 * Adds action buttons (run/copy) to code blocks in responses.
 * @param {HTMLElement} codeBlock - The code block element.
 * @param {number} currentTime - The current time for matching purposes.
 * @param {Object<string, string>} programs - The current runnable programs, used when webview visibility changes.
 */
const generateButtons = (codeBlock, currentTime, programs=null) => {
    const container = document.createElement('div');
    const header = document.createElement('div');
    const runnablePrograms = programs == null ? queue : Object.entries(programs);
    if (!codeBlock.textContent) return;
    const copyButton = generateCopyButton(codeBlock.textContent.trim(), 'code-copy');

    container.classList.add('code-container');
    header.classList.add('code-header-response');
    codeBlock.parentNode.insertBefore(container, codeBlock);
    container.appendChild(header);
    container.appendChild(codeBlock);

    header.appendChild(copyButton);
    const codeKey = codeBlock.textContent.trim();

    if (currentTime == null && runnablePrograms.length > 0) {
        for (const [key, value] of runnablePrograms) {
            if (compareCodeBlock(codeBlock.textContent.trim(), value.trim())) {
                const runButton = generateRunButton(key);
                header.appendChild(runButton);
                alreadyMatched[codeKey] = key;
                break;
            }
        }
    } else if (codeKey in alreadyMatched) {
        const runButton = generateRunButton(alreadyMatched[codeKey]);
        header.appendChild(runButton);
    } else if (currentTime && currentTime - lastMatching > 1000) {
        lastMatching = currentTime;
        for (const [key, value] of runnablePrograms) {
            if (compareCodeBlock(codeBlock.textContent.trim(), value.trim())) {
                const runButton = generateRunButton(key);
                header.appendChild(runButton);
                alreadyMatched[codeKey] = key;
                break;
            }
        }
    }
};

/**
 * Creates UI for deletable code blocks for mentioned code.
 * @param {HTMLElement} codeBlock - The code block element.
 */
const deleteButtons = (codeBlock) => {
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
 * Applies syntax highlighting to the snippet.
 */
const highlightSnippet = () => {
    document.querySelectorAll("#content pre code").forEach(codeBlock => {
        hljs.highlightElement(codeBlock);
        deleteButtons(codeBlock);
        codeBlock.classList.add('hljs');
    });
};

/**
 * Generates the header and required buttons for each code block.
 * @param {Object<string, string>} programs - The current runnable programs.
 */
const generateCodeHeaders = (programs) => {
    document.querySelectorAll("#chat-history pre code").forEach(codeBlock => {
        generateButtons(codeBlock, null, programs);
    });
};

/**
 * Adds the needed buttons to all existing chat entries.
 */
const addButtons = () => {
    document.querySelectorAll(".chat-entry").forEach((element) => {
        generateChatEntryButtons(element, element.id);
    })
}

hljs.highlightAll();
addButtons();