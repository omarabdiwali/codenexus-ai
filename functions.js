const vscode = require("vscode");
const fs = require("node:fs");
const path = require('path');

/** Constructs the file path for a given filename. */
const getFilePath = (filename) => {
    const filePath = path.join(vscode.workspace.workspaceFolders[0].uri.path, `${filename}.md`).slice(1);
    return filePath;
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

/** Extracts file location from a response. */
const getLocationFromResponse = (response, locations) => {
    let index = Number(response);
    let location = locations[index];
    location = location.substring(location.indexOf(" ") + 1);
    return location;
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

/** Handles mentioned files in a response. */
const mentionedFiles = async (matches, titles, duplicatedFiles) => {
    let files = "";
    let response = "";
    let clearance = true;
    let lastFile = null;
    let fulfilled = [];

    if (matches == null) return { response, clearance, match: lastFile, fulfilled, files };

    for (let match of matches) {
        let fileName = match.substring(1);
        if (fileName in titles) {
            if (titles[fileName].length > 1) {
                lastFile = fileName;
                response = `Which ${fileName} are you referring to:\n`;
                clearance = false;
                for (let i = 0; i < titles[fileName].length; i++) {
                    response += `(${i + 1}) ${titles[fileName][i]}\n`;
                }
            } else {
                let loc = titles[fileName][0];
                if (duplicatedFiles.has(loc)) continue;
                const text = await getTextFromFile(loc);
                files += fileName + ":\n" + text + "\n\n";
                fulfilled.push(match);
                duplicatedFiles.add(loc);
            }

            if (!clearance) break;
        }
    }

    return { response, clearance, fulfilled, files, match: lastFile };
};

module.exports = {
    getFilePath,
    sendToFile,
    replaceFileMentions,
    getLocationFromResponse,
    highlightFilenameMentions,
    getFileNames,
    getTextFromFile,
    getNonce,
    addFileToPrompt,
    mentionedFiles
}
