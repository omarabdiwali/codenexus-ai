const vscode = require('vscode');
const openai = require('openai');
const showdown = require('showdown');
const fs = require("node:fs");
const { performance } = require("perf_hooks");

const userQuestions = [];
const questionHistory = [];
const responseHistory = [];
const duplicatedFiles = new Set();

let previousResponse = "";
let currentResponse = "";
let textFromFile = "";
let llmIndex = 0;
let writeToFile = false;
let outputFileName = "output";

const converter = new showdown.Converter();
converter.setOption("tables", true);

const llama = "meta-llama/llama-3.3-70b-instruct:free";
const llamalarge = "meta-llama/llama-3.1-405b-instruct:free";
const deepseek = "deepseek/deepseek-chat:free";
const gemma = "google/gemini-2.0-flash-lite-preview-02-05:free";
const gemmapro = "google/gemini-2.0-pro-exp-02-05:free";

const llms = [
    gemmapro,
    deepseek,
    llamalarge,
    gemma,
    llama
]

const llmNames = [
    "Gemma 2.0 Pro",
    "Deepseek V3",
    "Llama (405b)",
    "Gemma 2.0 Flash",
    "Llama (70b)"
]

const readToFile = (content, filename) => {
    try {
        const filePath = vscode.workspace.workspaceFolders[0].uri.fsPath + `\\` + filename + ".md";
        fs.writeFileSync(filePath, content, { flag: "a" });
    } catch (err) {
        console.error(err);
        vscode.window.showErrorMessage('Failed to write to file: ' + err.message);
    }
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
    let apiKey = context.globalState.get('aiChatApiKey');

    if (!apiKey) {
        apiKey = await vscode.window.showInputBox({
            prompt: 'Enter your OpenRouter API key',
            ignoreFocusOut: true,
            password: true,
        });

        if (!apiKey) {
            vscode.window.showErrorMessage('AI Chat requires an OpenRouter API key to function.');
            return;
        }

        await context.globalState.update('aiChatApiKey', apiKey);
    }

    let openChat = new openai.OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: apiKey
    })

    const updateOpenAIClient = (key) => {
        openChat = new openai.OpenAI({
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: key
        })
    }

    const disposable = vscode.commands.registerCommand('ai-chat.chat', async function () {
        const panel = vscode.window.createWebviewPanel("ai", "AI Chat", vscode.ViewColumn.Two, { enableScripts: true });
        const spinCss = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'spinner.css'));
        const cssFile = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'styles.css'));
        const jsFile = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview.js'));
        
        // customize what you want to include/exclude from your folder
        const include = ''
        const exclude = '{**/node_modules/**,**/.next/**,**/images/**,**/*.png,**/*.jpg,**/*.svg,**/*.git*,**/*.eslint**,**/*.mjs,**/public/**,**/*config**,**/*_**,**/*.lock,**/*.woff}';
        const allFiles = await vscode.workspace.findFiles(include, exclude);
        let fileTitles = getFileNames(allFiles);

        panel.webview.html = getWebviewContent(llmIndex, userQuestions, responseHistory, writeToFile, outputFileName, cssFile, jsFile);

        const sendStream = (stream) => {
          if (writeToFile) {
            readToFile(stream, outputFileName);
          } else {
            panel.webview.postMessage({ command: "response", text: converter.makeHtml(stream), file: null });
          }
        };

        const loading = () => {
            panel.webview.postMessage({ command: "loading", text: getSpinner(spinCss), file: null });
        }

        const sendChat = async (chat, index, count) => {
            const startTime = performance.now();
            currentResponse = "";

            try {
                const stream = await openChat.chat.completions.create({
                    model: llms[index],
                    stream: true,
                    messages: [
                        {
                            role: "user",
                            content: chat
                        }
                    ]
                })

                for await (const chunk of stream) {
                    const val = chunk.choices[0]?.delta?.content || "";
                    currentResponse += val;
                    if (val.length > 0) writeToFile ? sendStream(val) : sendStream(currentResponse);
                }

                if (currentResponse.length === 0) throw new Error("Error: LLM has given no response!");

                const endTime = performance.now();
                const runTime = `Call to ${llmNames[index]} took ${(endTime - startTime) / 1000} seconds.`;
                const totalResponse = `${currentResponse}\n\n**${runTime}**`;
                
                if (writeToFile) {
                    const pathToFile = vscode.workspace.workspaceFolders[0].uri.fsPath + '\\' + outputFileName;
                    const webviewResponse = `The response to your question has been completed at:\n\n **${pathToFile}.md**`; 
                    sendStream(`\n\n**${runTime}**\n\n`);
                    panel.webview.postMessage({ command: "response", text: converter.makeHtml(webviewResponse), file: null });
                } else {
                    sendStream(totalResponse);
                }

                questionHistory.push(chat);
                responseHistory.push(totalResponse);

            } catch (err) {
                if (count === llms.length) {
                    console.log("hit an error!");
                    console.log(err.error);

                    if (responseHistory.length < questionHistory.length) {
                        responseHistory.push(err.message);
                    }
                    
                    if (!writeToFile) {
                        panel.webview.postMessage({ command: "error", text: err.message, file: null, question: chat });
                    } else {
                        vscode.window.showErrorMessage("Error writing to chat: " + err.message)
                    }
                } else {
                    index += 1;
                    index %= llms.length;
                    await sendChat(chat, index, count + 1);
                }
            }
        }

        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command == "chat") {
                let userQuestion = message.text;
                if (!message.context) {
                    userQuestions.push(userQuestion);
                    questionHistory.push(userQuestion);
                } 
                writeToFile = message.writeToFile;
                outputFileName = message.outputFile ? message.outputFile : "output";
                
                if (!writeToFile) {
                    panel.webview.postMessage({ command: 'chat', text: userQuestion });
                } else {
                    panel.webview.postMessage({ command: 'chat', text: userQuestion });
                    sendStream("## " + userQuestion + "\n\n");
                }

                let text = message.text;
                let regEx = new RegExp("\\B\\@[\\[\\]a-zA-Z]+\\.[a-zA-Z]+", "g");
                let matches = text.match(regEx);

                if (message.context) {
                    let locations = previousResponse.split("\n");
                    let file = getLocationFromResponse(text, locations);
                    const fileValue = await addFileToPrompt(message.file, file);
                    textFromFile += fileValue + "\n"
                    text = replaceFileMentions(questionHistory.at(-1), ["@" + message.file]);
                    questionHistory[questionHistory.length - 1] = text;
                    matches = text.match(regEx);
                } else {
                    textFromFile = "";
                    duplicatedFiles.clear();
                }
                
                let mentioned = await mentionedFiles(matches, fileTitles);
                text = replaceFileMentions(text, mentioned.fulfilled);
                textFromFile += mentioned.files;

                if (!mentioned.clearance) {
                    previousResponse = mentioned.response;
                    panel.webview.postMessage(
                        {
                            command: "selection",
                            text: mentioned.response,
                            file: mentioned.match,
                            maxVal: fileTitles[mentioned.match].length
                        }
                    );
                    return;
                }

                let question = `${text}\n\n${textFromFile}`;
                loading();
                await sendChat(question, llmIndex, 0);
            } else if (message.command === 'copy') {
                vscode.env.clipboard.writeText(message.text);
            } else if (message.command == "selectLLM") {
                llmIndex = parseInt(message.index);
            }
        })
        panel.onDidDispose(() => {
            if (responseHistory.length < userQuestions.length) {
                responseHistory.push(currentResponse ? currentResponse : "Error: Webview was disposed before response was given.");
            }
        }, null, context.subscriptions);
    });

    const changeApiKeyCommand = vscode.commands.registerCommand('ai-chat.changeApiKey', async () => {
        const newApiKey = await vscode.window.showInputBox({
            prompt: 'Enter your new OpenRouter API key',
            ignoreFocusOut: true,
            password: true,
        });

        if (newApiKey) {
            await context.globalState.update('aiChatApiKey', newApiKey);
            updateOpenAIClient(newApiKey);
            vscode.window.showInformationMessage('OpenRouter API key updated successfully.');
        } else {
            vscode.window.showWarningMessage('No API Key entered. Key not updated.');
        }
    });

    context.subscriptions.push(disposable, changeApiKeyCommand);
}

const replaceFileMentions = (question, files) => {
    for (let file of files) {
        question = question.replace(file, file.substring(1));
    }
    return question;
}

const getLocationFromResponse = (response, locations) => {
    let index = Number(response);
    let location = locations[index];
    location = location.substring(location.indexOf(" ") + 1);
    return location;
}


const addFileToPrompt = async (file, location) => {
    if (duplicatedFiles.has(location)) return "";
    duplicatedFiles.add(location);
    const text = await getTextFromFile(location);
    return file + ":\n" + text;
}

const highlightFilenameMentions = (text) => {
    const regEx = new RegExp("\\B\\@[\\[\\]a-zA-Z]+\\.[a-zA-Z]+", "g");
    return text.replace(regEx, (match) => {
        return "<code>" + match + "</code>";
    });
};

const getFileNames = (allFiles) => {
    let fileTitles = {};
    let titleRegEx = new RegExp("\\\\[\\[\\]a-zA-Z]+\\.[a-zA-Z]+");

    for (const file of allFiles) {
        let path = file.path.substring(1);
        path = path.replaceAll("/", "\\")
        let matchedTitle = path.match(titleRegEx);
        if (!matchedTitle) continue;
        for (let title of matchedTitle) {
            title = title.substring(1);
            if (title in fileTitles) fileTitles[title].push(file.path);
            else fileTitles[title] = [file.path];
        }
    }

    return fileTitles;
}

const getTextFromFile = async (path) => {
    const uri = vscode.Uri.file(path);
    const text = await vscode.workspace.fs.readFile(uri);
    return text;
}

const mentionedFiles = async (matches, titles) => {
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
                    response += `(${i + 1}) ${titles[fileName][i]}\n`
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
}

const getWebviewContent = (selectedLLMIndex, questionHistory, responseHistory, writeToFile, outputFileName, cssFile, jsFile) => {
    let optionsHtml = '';
    for (let i = 0; i < llmNames.length; i++) {
        optionsHtml += `<option value="${i}" ${i === selectedLLMIndex ? 'selected' : ''}>${llmNames[i]}</option>`;
    }

    let chatHistoryHtml = '';
    for (let i = 0; i < questionHistory.length; i++) {
        chatHistoryHtml += `
            <div class="chat-entry">
                <div class="question"><strong>You:</strong> ${highlightFilenameMentions(questionHistory[i])}</div>
                <div class="response">${converter.makeHtml(responseHistory[i])}</div>
            </div>
        `;
    }

    return /*html*/`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css">
        <link rel="stylesheet" href="${cssFile}">
        <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
        <title>AI Chat</title>
      </head>
      <body>
        <div id="chat-container">
            <div id="input-area">
                <textarea id="prompt" rows="3" placeholder="Type your message here..."></textarea>
                <div id="llmDropdown">
                    <label for="llmSelect">Select LLM:</label>
                    <select id="llmSelect">
                        ${optionsHtml}
                    </select>
                </div>

                <div class="checkbox-button-container">
                    <input type="checkbox" id="writeToFileCheckbox" class="checkbox-button-input" ${writeToFile ? 'checked' : ''}>
                    <label for="writeToFileCheckbox" class="checkbox-button-label">Write to File</label>
                    <input ${writeToFile ? "" : "disabled"} type="text" id="outputFileNameInput" value="${outputFileName == "output" ? "" : outputFileName}" placeholder="Enter file name...">
                </div>

                <button id="ask">Ask</button>
            </div>
            <div id="chat-history">
                ${chatHistoryHtml}
            </div>
        </div>
        <script src="${jsFile}"></script>
      </body>
    </html>
    `
}

const getSpinner = (cssFile) => {
    return /*html*/`
    <link rel="stylesheet" href="${cssFile}">
    <div id="container"><div id="spinner"></div></div>
    `;
};

// This method is called when your extension is deactivated
function deactivate() { }

module.exports = {
    activate,
    deactivate
}