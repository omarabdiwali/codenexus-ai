const vscode = require("vscode");
const fs = require("node:fs");
const path = require('path');

/** Constructs the file path for a given filename. */
const getFilePath = (filename) => {
    const filePath = path.join(vscode.workspace.workspaceFolders[0].uri.path, `${filename}.md`);
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
    const text = await vscode.workspace.fs.readFile(uri);
    return text;
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

  async getTextFile() {
    let textFromFiles = "Files mentioned in order from newest to oldest:\n\n";
    
    for (const [location, fileName] of Array.from(this.cache).reverse()) {
      const fileText = await getTextFromFile(location);
      textFromFiles += `${fileName}:\n${fileText}`
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
    LRUCache
}
