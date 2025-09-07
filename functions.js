const vscode = require("vscode");
const fs = require("node:fs");
const path = require('path');
const seen = new Set();
const fileRegEx = new RegExp(/\B@(?:[a-zA-Z0-9_.-]*[a-zA-Z0-9_-]+)/g);

/**
 * Constructs the file path for a given filename.
 * @param {string} filename - The name of the file.
 * @param {string} [fileType='md'] - The file extension.
 * @returns {string} The full file path.
 */
const getFilePath = (filename, fileType) => {
    const filePath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, `${filename}.${fileType}`);
    return filePath.at(0) == '/' || filePath.at(0) == '\\' ? filePath.slice(1) : filePath;
}

/**
 * @typedef {{ [filename: string]: [fileLocations: string[]] }} FileLocationsMap
 */

/**
 * Gets all the files in the current workspace directory.
 * @param {string} include - Glob pattern for files to include.
 * @param {string} exclude - Glob pattern for files to exclude.
 * @param {string} defaultInclude - Default glob pattern for files to include.
 * @param {string} defaultExclude - Default glob pattern for files to exclude.
 * @returns {Promise<FileLocationsMap>} A promise that resolves to an object containing file titles and paths.
 */
const getAllFiles = async (include, exclude, defaultInclude, defaultExclude) => {
    try {
        const allFiles = await vscode.workspace.findFiles(include, exclude);
        return getFileNames(allFiles);
    } catch (e) {
        const allFiles = await vscode.workspace.findFiles(defaultInclude, defaultExclude);
        return getFileNames(allFiles);
    }
}

/**
 * Debounce function to stop repetitive calls to `getAllFiles`.
 * @param {Function} func - The function to debounce.
 * @param {number} wait - The number of milliseconds to wait.
 * @returns {Promise<any>} A debounced function.
 */
const debounce = (func, wait) => {
    let timeout;
    let lastPromise = null;
    return async (...args) => {
        const context = this;
        const later = async () => {
            timeout = null;
            lastPromise = await func.apply(context, args);
        };

        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        return lastPromise;
    };
};

/**
 * Writes content to a file in the workspace.
 * @param {string} content - The content to write to the file.
 * @param {string} filename - The name of the file to write to.
 */
const sendToFile = (content, filename) => {
    try {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length == 0) {
            throw new Error('No workspace folder is open.');
        }
        const filePath = getFilePath(filename, "md");
        fs.writeFileSync(filePath, content, { flag: "a" });
    } catch (err) {
        console.error(err);
        vscode.window.showErrorMessage('Failed to write to file: ' + err.message);
    }
};

/**
 * Replaces file mentions in a question.
 * @param {string} question - The question containing file mentions.
 * @param {Array<string>} files - An array of file mentions to replace.
 * @returns {string} The question with file mentions replaced.
 */
const replaceFileMentions = (question, files) => {
    for (let file of files) {
        question = question.replace(file, file.substring(1));
    }
    return question;
};

/**
 * Highlights filename mentions in text.
 * @param {string} text - The text to highlight filename mentions in.
 * @param {FileLocationsMap} fileTitles - An object mapping filenames to their paths.
 * @returns {string} The text with filename mentions highlighted.
 */
const highlightFilenameMentions = (text, fileTitles) => {
    text = text.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return text.replace(fileRegEx, (match) => {
        const title = match.substring(1);
        if (!(title in fileTitles)) return match;
        return "<code>" + match + "</code>";
    });
};

/**
 * Extracts file titles from a list of files.
 * @param {Array<vscode.Uri>} allFiles - An array of file objects.
 * @returns {FileLocationsMap} An object mapping file titles to their paths.
 */
const getFileNames = (allFiles) => {
    let fileTitles = {};
    for (const file of allFiles) {
        let title = path.basename(file.fsPath);
        if (!title) continue;
        if (title in fileTitles) fileTitles[title].push(file.fsPath);
        else fileTitles[title] = [file.fsPath];
    }
    return fileTitles;
};

/**
 * Reads text from a file.
 * @param {string} path - The path of the file to read.
 * @returns {Promise<string|null>} A promise that resolves to the file content or `null` if an error occurs.
 */
const getTextFromFile = async (path) => {
    const uri = vscode.Uri.file(path);
    try {
        const text = await vscode.workspace.fs.readFile(uri);
        return text;
    } catch (err) {
        return null;
    }
};

/**
 * Generates a random string of given length.
 * @param {number} len - The length of the generated string.
 * @returns {string} A random string.
 */
const getRandomString = (len) => {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < len; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
};

/**
 * Checks the generated code for dangerous patterns, and alerts the user.
 * @param {string} code - The code to check for dangerous patterns.
 * @returns {false | PromiseLike<boolean>} A promise that resolves to `true` if the code is dangerous, `false` otherwise.
 */
const checkCodeForDangerousPatterns = (code) => {
    const dangerousPatterns = [
        /os\.system\(/i,        // Detects calls to os.system()
        /subprocess\.(Popen|call|run)\(/i, // Detects subprocess calls
        /eval\(/i,             // Detects eval() calls
        /exec\(/i,             // Detects exec() calls
        /shutil\.rmtree\(/i,   // Detects dangerous file deletions
        /rm\s-\srf/i,          // Detects Unix rm -rf command
        /pickle\.load\(/i,
        /json\.loads\(\s*[^,\}]*\s*\)/i,
        /yaml\.safe_load\(/i
    ];

    const hasDangerousCode = dangerousPatterns.some(pattern => pattern.test(code));

    if (hasDangerousCode) {
        return vscode.window.showWarningMessage('The code contains potentially dangerous commands!', 
            "Proceed",
            "Cancel"
            ).then((selection) => {
                if (selection === 'Proceed') return false;
                else return true;
            })
    } else {
        return false;
    }
}

/**
 * Escaping special characters in a regular expression.
 * @param {string} str - The string to escape.
 * @returns {string} The escaped string.
 */
const escapeRegExp = (str) => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Gets all the generated programs from the response.
 * @param {string} text - The text to extract programs from.
 * @param {string} token - The token to search for.
 * @param {boolean} [final=false] - Whether this is the final extraction.
 * @returns {Array<string>} An array of code blocks.
 */
const getAllRunnablePrograms = (text, token, final=false) => {
    const blocks = [];
    const escapedToken = escapeRegExp(token);
    const regex = new RegExp(
        `${escapedToken}[\\s\\S]*?\`\`\`(?:\\w+)?\\n([\\s\\S]*?)\`\`\`[\\s\\S]*?${escapedToken}`,
        "g"
    );
    
    while ((match = regex.exec(text)) !== null) {
        const code = match[1].trim();
        if (!seen.has(code)) {
            seen.add(code);
            blocks.push(code);
        }
    }
    
    if (final) seen.clear();
    return blocks;
}

/**
 * Creates a VSCode terminal for the Agent.
 * @param {string} basePath - The base path for the terminal.
 * @returns {vscode.Terminal} The created terminal.
 */
const createVSCodeTerminal = (basePath) => {
    const terminal = vscode.window.createTerminal({
        name: 'Agent Terminal',
        cwd: basePath,
        env: {
            ...process.env,
            BASE_WORKSPACE_PATH: basePath
        }
    })

    return terminal;
}

/**
 * Creates and runs the generated Python script.
 * @param {string} text - The Python code to run.
 * @returns {Promise<void>}
 */
const runPythonFile = async (text) => {
    const filePath = getFilePath("run_py", "py");
    const basePath = path.dirname(filePath);
    const isDangerous = await checkCodeForDangerousPatterns(text);
    if (isDangerous) {
        return;
    }

    fs.writeFileSync(filePath, text);
    const pyProg = createVSCodeTerminal(basePath);
    const command = `python "${filePath}"`
    pyProg.show();
    pyProg.sendText(command);
}

/**
 * An LRUCache that is used for handling the number of files for context.
 */
class LRUCache {
    /**
     * Creates a new LRUCache instance.
     * @param {number} capacity - The maximum capacity of the cache.
     */
    constructor(capacity) {
        this.cache = new Map();
        this.capacity = capacity;
    }

    /**
     * Gets a value from the cache.
     * @param {string} key - The key to get.
     * @returns {-1 | string} The value if found, `-1` otherwise.
     */
    get(key) {
        if (!this.cache.has(key)) return -1;
        let val = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, val);
        return val;
    }

    /**
     * Puts a key-value pair into the cache.
     * @param {string} key - The key to put.
     * @param {string} value - The value to put.
     */
    put(key, value) {
        this.cache.delete(key);
        if (this.cache.size === this.capacity) {
            this.cache.delete(this.cache.keys().next().value);
            this.cache.set(key, value);
        } else {
            this.cache.set(key, value);
        }
    }

    /**
     * Deletes a key from the cache.
     * @param {string} key - The key to delete.
     */
    delete(key) {
        this.cache.delete(key);
    }

    /**
     * Handles changing the size of the cache.
     * @param {number} size - The new size of the cache.
     */
    changeSize(size) {
        if (this.size() > size) {
            const overflow = this.size() - size;
            for (let i = 0; i < overflow; i++) {
                this.cache.delete(this.cache.keys().next().value)
            }
        }
        this.capacity = size;
    }

    /**
     * Gets the current size of the cache.
     * @returns {number} The size of the cache.
     */
    size() {
        return this.cache.size;
    }

    /**
     * Checks if the cache has a key.
     * @param {string} key - The key to check.
     * @returns {boolean} `true` if the cache has the key, `false` otherwise.
     */
    has(key) {
        return this.cache.has(key);
    }

    /**
     * Composes all of the text from the files stored in the LRUCache.
     * @returns {Promise<string>} A promise that resolves to the combined text from all files.
     */
    async getTextFile() {
        let textFromFiles = "Files recently mentioned:\n\n";
        
        for (const [location, filename] of Array.from(this.cache)) {
            const fileText = await getTextFromFile(location);
            if (fileText === null) {
                this.delete(location);
            } else {
                textFromFiles += `${filename} (${location.substring(1)}):\n${fileText}\n\n`
            }
        }

        return textFromFiles;
    }
}

module.exports = {
    fileRegEx,
    getFilePath,
    getAllFiles,
    debounce,
    sendToFile,
    replaceFileMentions,
    highlightFilenameMentions,
    getFileNames,
    getRandomString,
    getAllRunnablePrograms,
    runPythonFile,
    LRUCache
}
