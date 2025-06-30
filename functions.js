const vscode = require("vscode");
const fs = require("node:fs");
const path = require('path');
const { spawn } = require('child_process');


/** Constructs the file path for a given filename. */
const getFilePath = (filename, fileType='md') => {
    const filePath = path.join(vscode.workspace.workspaceFolders[0].uri.path, `${filename}.${fileType}`);
    return filePath.at(0) == '/' || filePath.at(0) == '\\' ? filePath.slice(1) : filePath;
}

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
const highlightFilenameMentions = (text) => {
    const regEx = new RegExp("\\B\\@[\\[\\]a-zA-Z]+\\.[a-zA-Z]+", "g");
    return text.replace(regEx, (match) => {
        return "<code>" + match + "</code>";
    });
};

/** Extracts file titles from a list of files. */
const getFileNames = (allFiles) => {
    let fileTitles = {};
    let titleRegEx = new RegExp("\\\\[[\\[\\]a-zA-Z]+\\.[a-zA-Z]+");
    for (const file of allFiles) {
        let path = file.path.substring(1);
        path = path.replaceAll("/", "\\");
        let matchedTitle = path.match(titleRegEx);
        if (!matchedTitle) continue;
        for (let title of matchedTitle) {
            title = title.substring(1);
            if (title in fileTitles) fileTitles[title].push(file.path);
            else fileTitles[title] = [file.path];
        }
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

const sanitizeProgram = (text) => {
    const regex = /```.*\n([\s\S]*?)```/;
    const match = text.match(regex);
    if (match) {
        const code = match[1].trim();
        return code;
    } else {
        return ""
    }
}

const runPythonFile = async (text) => {
    const filePath = getFilePath("run_py", "py");
    const outputPath = getFilePath("run_py_output", "txt");
    const basePath = path.dirname(outputPath);
    if (basePath.at(0) == '\\' || basePath.at(0) == '/') basePath = basePath.substring(1);

    const isDangerous = await checkCodeForDangerousPatterns(text);
    if (isDangerous) return;

    fs.writeFileSync(filePath, text);

    const pyProg = spawn('python', [filePath], {
        timeout: 30 * 1000, // 30 seconds,
        env: {
            BASE_WORKSPACE_PATH: basePath
        }
    });
  
    pyProg.stdout.on('data', (data) => {
        fs.appendFileSync(outputPath, `${data.toString()}`)
    });
    pyProg.stderr.on('data', (data) => {
        fs.appendFileSync(outputPath, `Python error: ${data.toString()}`)
    });
    pyProg.on('close', (code) => {
        fs.appendFileSync(outputPath, `Python process exited with code ${code}\n\n\n`);
        vscode.window.showInformationMessage(`Output: ${outputPath}`);
    });
}

class LRUCache {
    constructor(capacity) {
        this.cache = new Map();
        this.capacity = capacity;
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

    size() {
        return this.cache.size;
    }

    has(key) {
        return this.cache.has(key);
    }

    async getTextFile() {
        let textFromFiles = "Files mentioned in order from newest to oldest:\n\n";
        
        for (const [location, fileName] of Array.from(this.cache).reverse()) {
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
    sendToFile,
    replaceFileMentions,
    highlightFilenameMentions,
    getFileNames,
    getNonce,
    addFileToPrompt,
    sanitizeProgram,
    runPythonFile,
    LRUCache
}
