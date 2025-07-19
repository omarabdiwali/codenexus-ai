const vscode = require("vscode");
const fs = require("node:fs");
const path = require('path');
const seen = new Set();

/** Constructs the file path for a given filename. */
const getFilePath = (filename, fileType='md') => {
    const filePath = path.join(vscode.workspace.workspaceFolders[0].uri.path, `${filename}.${fileType}`);
    return filePath.at(0) == '/' || filePath.at(0) == '\\' ? filePath.slice(1) : filePath;
}

/** Gets all the files in the current workspace directory. */
const getAllFiles = async (include, exclude, defaultInclude, defaultExclude) => {
    try {
        const allFiles = await vscode.workspace.findFiles(include, exclude);
        return getFileNames(allFiles);
    } catch (e) {
        const allFiles = await vscode.workspace.findFiles(defaultInclude, defaultExclude);
        return getFileNames(allFiles);
    }
}

/** Debounce function to stop repetitve calls to `getAllFiles`. */
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

/** Writes content to a file in the workspace. */
const sendToFile = (content, filename) => {
    try {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length == 0) {
            throw new Error('No workspace folder is open.');
        }
        const filePath = getFilePath(filename);
        fs.writeFileSync(filePath, content, { flag: "a" });
    } catch (err) {
        console.error(err);
        vscode.window.showErrorMessage('Failed to write to file: ' + err.message);
    }
};

/** Replaces file mentions in a question. */
const replaceFileMentions = (question, files) => {
    for (let file of files) {
        question = question.replace(file, file.substring(1));
    }
    return question;
};

/** Highlights filename mentions in text. */
const highlightFilenameMentions = (text, fileTitles) => {
    const regEx = new RegExp(/[\b\@][\w\.]*\.[a-zA-Z]+\b/g);
    return text.replace(regEx, (match) => {
        const title = match.substring(1);
        if (!(title in fileTitles)) return match;
        return "<code>" + match + "</code>";
    });
};

/** Extracts file titles from a list of files. */
const getFileNames = (allFiles) => {
    let fileTitles = {};
    for (const file of allFiles) {
        let title = path.basename(file.path);
        if (!title) continue;
        if (title in fileTitles) fileTitles[title].push(file.path);
        else fileTitles[title] = [file.path];
    }
    return fileTitles;
};

/** Reads text from a file. */
const getTextFromFile = async (path) => {
    const uri = vscode.Uri.file(path);
    try {
        const text = await vscode.workspace.fs.readFile(uri);
        return text;
    } catch (err) {
        return null;
    }
};

/** Generates a random nonce (32-character string). */
const getNonce = () => {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
};

/** Adds file content to a prompt. */
const addFileToPrompt = async (file, location, duplicatedFiles) => {
    if (duplicatedFiles.has(location)) return "";
    duplicatedFiles.add(location);
    const text = await getTextFromFile(location);
    return file + ":\n" + text;
};

/** Checks the generated code for dangerous patterns, and alerts the user. */
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

const escapeRegExp = (str) => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Gets all the generated programs from the response. */
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

/** Creates and runs the generated Python script. */
const runPythonFile = async (text) => {
    const filePath = getFilePath("run_py", "py");
    const basePath = path.dirname(filePath);
    if (basePath.at(0) == '\\' || basePath.at(0) == '/') basePath = basePath.substring(1);

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

/** An LRUCache that is used for handling the number of files for context. */
class LRUCache {
    constructor(capacity) {
        this.cache = new Map();
        this.capacity = capacity;
        this.maxSize = capacity;
    }

    get(key) {
        if (!this.cache.has(key)) return -1;
        let val = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, val);
        return val;
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
        this.capacity += 1;
    }

    changeSize(size) {
        if (this.size() <= size) {
            this.capacity = size - this.size();
        } else {
            const overflow = this.size() - size;
            for (let i = 0; i < overflow; i++) {
                this.cache.delete(this.cache.keys().next().value)
            }
            this.capacity = 0;
        }
        this.maxSize = size;
    }

    size() {
        return this.cache.size;
    }

    has(key) {
        return this.cache.has(key);
    }

    async getTextFile() {
        let textFromFiles = "Files mentioned in order from newest to oldest:\n\n";
        
        for (const [location, fileName] of Array.from(this.cache)) {
            const fileText = await getTextFromFile(location);
            if (fileText === null) {
                this.delete(location);
            } else {
                textFromFiles += `${fileName} (${location.substring(1)}):\n${fileText}`
            }
        }

        return textFromFiles;
    }
}

module.exports = {
    getFilePath,
    getAllFiles,
    debounce,
    sendToFile,
    replaceFileMentions,
    highlightFilenameMentions,
    getFileNames,
    getNonce,
    getAllRunnablePrograms,
    runPythonFile,
    LRUCache
}
