const vscode = require('vscode');
const openai = require('openai');
const showdown = require('showdown');
const { performance } = require("perf_hooks");

const {
    getFilePath,
    sendToFile,
    replaceFileMentions,
    highlightFilenameMentions,
    getFileNames,
    getNonce,
    addFileToPrompt,
    LRUCache
} = require("./functions");

const userQuestions = [];
const questionHistory = [];
const responseHistory = [];
const duplicatedFiles = new Set();
const fileHistory = new LRUCache(3);

let questionsAndResponses = [];
let previousResponse = "";
let currentResponse = "";
let textFromFile = "";

let llmIndex = 0;
let writeToFile = false;
let outputFileName = "output";
let fileTitles = {};
let currenlyResponding = false;
let continueResponse = true;

const converter = new showdown.Converter();
converter.setOption("tables", true);
converter.setOption("smoothLivePreview", true);

const deepseek = "deepseek/deepseek-chat:free";
const gemma = "google/gemini-2.0-flash-exp:free";
const qwen = "qwen/qwen3-235b-a22b:free";
const gemma3 = "google/gemma-3-27b-it:free";
const nvidia = "nvidia/llama-3.3-nemotron-super-49b-v1:free";
const llama = "meta-llama/llama-4-maverick:free";

const llms = [
    nvidia,
    llama,
    qwen,
    deepseek,
    gemma,
    gemma3
];

const llmNames = [
    "Llama 3.3 Nemotron",
    "Llama 4 Maverick",
    "Qwen3",
    "Deepseek V3",
    "Gemma 2.0 Flash",
    "Gemma 3.0 (27b)"
];

const sendStream = (panel, stream) => {
    if (writeToFile) {
        sendToFile(stream, outputFileName);
    } else if (panel && panel.webview) {
        panel.webview.postMessage({ command: "response", text: converter.makeHtml(stream) });
    }
};

const generateMessages = async (chat, mentionedCode) => {
    const messages = [];
    
    if (fileHistory.size() > 0) {
        const files = await fileHistory.getTextFile();
        messages.push({
            role: 'user',
            content: files
        })
    }

    for (const {question, response} of questionsAndResponses.slice(-5)) {
        const systemResponse = response.substring(0, response.lastIndexOf('\n'));

        messages.push({
            role: 'user',
            content: question
        })
        messages.push({
            role: 'assistant',
            content: systemResponse
        })
    }

    messages.push({
        role: 'user',
        content: mentionedCode.length > 0 ? chat + '\n\n' + mentionedCode : chat
    })

    return messages;
}

const sendChat = async (panel, messages, openChat, chat, index, count, originalQuestion) => {
    const startTime = performance.now();
    let sendMessage = true;
    currentResponse = "";

    try {
        const stream = await openChat.chat.completions.create({
            model: llms[index],
            stream: true,
            messages
        });

        for await (const chunk of stream) {
            if (sendMessage) panel.webview.postMessage({ command: 'cancelView', value: true });
            sendMessage = false;
            if (!continueResponse) break;
            const val = chunk.choices[0]?.delta?.content || "";
            currentResponse += val;
            if (val.length > 0) writeToFile ? sendToFile(val, outputFileName) : sendStream(panel, currentResponse);
        }

        if (currentResponse.length === 0 && continueResponse) throw new Error("Error: LLM has given no response!");

        continueResponse = true;
        let totalTime = `${(performance.now() - startTime) / 1000}`;
        totalTime = totalTime.substring(0, totalTime.indexOf('.') + 5);
        
        const runTime = `Call to ${llmNames[index]} took ${totalTime} seconds.`;
        const totalResponse = `${currentResponse}\n\n**${runTime}**`;

        if (writeToFile) {
            const pathToFile = getFilePath(outputFileName);
            const webviewResponse = `The response to your question has been completed at:\n\n **${pathToFile}**`;
            sendToFile(`\n\n**${runTime}**\n\n`, outputFileName);

            if (panel && panel.webview) {
                panel.webview.postMessage({ command: "response", text: converter.makeHtml(webviewResponse) });
            }

        } else {
            sendStream(panel, totalResponse);
        }

        questionHistory.push(chat);
        responseHistory.push(totalResponse);
        questionsAndResponses.push({
            question: originalQuestion,
            response: totalResponse
        })

    } catch (err) {
        // console.log(err);
        if (!continueResponse) {
            let totalTime = `${(performance.now() - startTime) / 1000}`;
            totalTime = totalTime.substring(0, totalTime.indexOf('.') + 5);
            const runTime = `Call to ${llmNames[index]} took ${totalTime} seconds.`;
            writeToFile ? sendToFile(`**${runTime}**`, outputFileName) : sendStream(panel, runtime);
            continueResponse = true;
            return;
        }
        if (count === llms.length) {
            console.log("hit an error!");
            console.log(err.error);

            if (responseHistory.length < questionHistory.length) {
                responseHistory.push(err.message);
            }

            if (!writeToFile && panel && panel.webview) {
                panel.webview.postMessage({ command: "error", text: err.message, question: chat });
            } else {
                vscode.window.showErrorMessage("Error writing to chat: " + err.message);
            }
        } else {
            index += 1;
            index %= llms.length;
            await sendChat(panel, messages, openChat, chat, index, count + 1, originalQuestion);
        }
    }
};

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
    let apiKey = await context.secrets.get('aiChatApiKey');
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

        await context.secrets.store('aiChatApiKey', apiKey);
    }

    const provider = new AIChatViewProvider(context.extensionUri, context, apiKey);

    const updateOpenAIClient = (key) => {
        if (provider) {
            provider.apiKey = key;
            provider.openChat = new openai.OpenAI({
                baseURL: "https://openrouter.ai/api/v1",
                apiKey: key
            });
        }
    };

    const changeApiKeyCommand = vscode.commands.registerCommand('ai-chat.changeApiKey', async () => {
        const newApiKey = await vscode.window.showInputBox({
            prompt: 'Enter your new OpenRouter API key',
            ignoreFocusOut: true,
            password: true,
        });

        if (newApiKey) {
            await context.secrets.store('aiChatApiKey', newApiKey);
            updateOpenAIClient(newApiKey);
            vscode.window.showInformationMessage('OpenRouter API key updated successfully.');
        } else {
            vscode.window.showWarningMessage('No API Key entered. Key not updated.');
        }
    });
    
    const focusChatCommand = vscode.commands.registerCommand('ai-chat.chat.focus', async (data) => {
        if (provider) {
            provider.show();
            provider.handleIncomingData(data);
        } else {
            vscode.window.showWarningMessage("Chat view provider not available yet.");
        }
    })

    const openChatShortcut = vscode.commands.registerCommand('ai-chat.openChatWithSelection', async () => {
        const editor = vscode.window.activeTextEditor;
        let text = "";

        if (editor) {
            const selection = editor.selection;
            text = editor.document.getText(selection);
        }
        
        await vscode.commands.executeCommand('ai-chat.chat.focus', text);
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(AIChatViewProvider.viewType, provider),
        changeApiKeyCommand,
        openChatShortcut
    );

    const include = ''
    const exclude = '{**/node_modules/**,**/.next/**,**/images/**,**/*.png,**/*.jpg,**/*.svg,**/*.git*,**/*.eslint**,**/*.mjs,**/public/**,**/*config**,**/*_**,**/*.lock,**/*.woff}';
    const allFiles = await vscode.workspace.findFiles(include, exclude);
    fileTitles = getFileNames(allFiles);

    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.*', false, true, false);
    fileWatcher.onDidCreate(async (uri) => {
        const allFiles = await vscode.workspace.findFiles(include, exclude);
        fileTitles = getFileNames(allFiles);
        provider.updateFileList();
    });
    fileWatcher.onDidDelete(async (uri) => {
        const allFiles = await vscode.workspace.findFiles(include, exclude);
        fileTitles = getFileNames(allFiles);
        provider.updateFileList();
    });
}

class AIChatViewProvider {
    static viewType = 'ai-chat.chat';
    _view;

    /**
     * @param {string} _extensionUri
     * @param {vscode.ExtensionContext} context
     */
    constructor(_extensionUri, context, apiKey) {
        this._extensionUri = _extensionUri;
        this.context = context;
        this.apiKey = apiKey;
        this.regenHtml = 0;
        this.prevWrite = false;
        this.openChat = new openai.OpenAI({
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: this.apiKey
        });
    }

    async handleIncomingData(data) {
        let trimmed = data.replaceAll("\n", "").replaceAll(" ", "");
        
        if (trimmed.length > 0) {
            textFromFile = data;
            let htmlText = converter.makeHtml("```\n" + data + "\n```");
            await new Promise(res => setTimeout(res, 500));
            this._view.webview.postMessage({ command: 'content', text: htmlText });
        }

        this._view.webview.postMessage({ command: 'focus' });
    }

    updateFileList() {
        if (this._view && this._view.webview) {
            const notOpenFolder = !vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length == 0;
            this._view.webview.postMessage({ command: 'fileTitles', value: fileTitles });
            if (!notOpenFolder) {
                this._view.webview.postMessage({ command: 'workspacePath', value: vscode.workspace.workspaceFolders[0].uri.path });
            }
        }
    }

    loading() {
        if (this._view && this._view.webview) {
            this._view.webview.postMessage({ command: "loading", text: this._getSpinner() });
        }
    }

    show() {
        if (this._view) {
            this._view.show();
        } else {
            vscode.window.showErrorMessage("Attempted to show view, but it's not resolved yet. Open initially before using the keyboard shortcut.");
        }
    }

    resolveWebviewView(webviewView, _token) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview();
        webviewView.webview.postMessage({ command: 'focus' });
        this.updateFileList();

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                if (this.prevWrite != writeToFile || this.regenHtml != questionsAndResponses.length) {
                    webviewView.webview.html = this._getHtmlForWebview();
                    this.regenHtml = questionsAndResponses.length;
                    this.prevWrite = writeToFile;
                }
                this.updateFileList();
                this._view.webview.postMessage({ command: 'fileContext', value: Array.from(fileHistory.cache).reverse() })
                this._view.webview.postMessage({ command: 'focus' });
            } else {
                textFromFile = "";
            }
        });

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.command == "chat") {
                if (currenlyResponding) return;

                let userQuestion = message.text;
                userQuestions.push(userQuestion);
                questionHistory.push(userQuestion);                
                writeToFile = message.writeToFile;
                outputFileName = message.outputFile ? message.outputFile : "output";

                if (webviewView && webviewView.webview) {
                    webviewView.webview.postMessage({ command: 'chat', text: userQuestion });
                }
                
                if (writeToFile) sendStream(webviewView, "## " + userQuestion + "\n\n");

                let text = message.text;
                for (const [index, info] of Object.entries(message.mentionedFiles)) {
                    const [file, location] = info;
                    fileHistory.put(location, file);
                    text = replaceFileMentions(text, ["@" + file]);
                }

                const messages = await generateMessages(text, textFromFile);
                textFromFile = "";
                this.loading();
                
                webviewView.webview.postMessage({ command: 'content', text: '' });
                webviewView.webview.postMessage({ command: 'fileContext', value: Array.from(fileHistory.cache).reverse() });
                currenlyResponding = true;

                webviewView.webview.postMessage({ command: 'disableAsk' });
                await sendChat(webviewView, messages, this.openChat, text, llmIndex, 0, userQuestion);
                webviewView.webview.postMessage({ command: 'cancelView', value: false });
                
                currenlyResponding = false;
            } else if (message.command === 'copy') {
                vscode.env.clipboard.writeText(message.text);
            } else if (message.command == "selectLLM") {
                llmIndex = parseInt(message.index);
            } else if (message.command === 'remove') {
                textFromFile = "";
            } else if (message.command === 'clearHistory') {
                webviewView.webview.postMessage({ command: 'history', value: currenlyResponding });
                questionsAndResponses = [];
            } else if (message.command === 'stopResponse') {
                continueResponse = false;
                webviewView.webview.postMessage({ command: 'cancelView', value: false });
            } else if (message.command === 'outputToFile') {
                writeToFile = message.checked;
            } else if (message.command === 'fileContext') {
                fileHistory.delete(message.key);
            }
        });
    }

    _getSpinner() {
        const cssFile = this._view.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "spinner.css"));
        return /*html*/`
        <link rel="stylesheet" href="${cssFile}">
        <div id="container"><div id="spinner"></div></div>
        `;
    }

    _getHtmlForWebview() {
        let optionsHtml = '';
        for (let i = 0; i < llmNames.length; i++) {
            optionsHtml += `<option value="${i}" ${i === llmIndex ? 'selected' : ''}>${llmNames[i]}</option>`;
        }

        let chatHistoryHtml = '';
        for (let i = 0; i < questionsAndResponses.length; i++) {
              chatHistoryHtml += `
                <div class="chat-entry">
                    <div class="question"><strong>You:</strong> ${highlightFilenameMentions(questionsAndResponses[i].question)}</div>
                    <div class="response">${converter.makeHtml(questionsAndResponses[i].response)}</div>
                </div>
            `;
        }

        const jsFile = this._view.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "webview.js"));
        const cssFile = this._view.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "styles.css"));
        const nonce = getNonce();
        const disableOutput = !vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length == 0;

        return /*html*/`
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css">
            <link rel="stylesheet" href="${cssFile}">
            <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
            <script src="https://cdn.jsdelivr.net/npm/dompurify@3.2.5/dist/purify.min.js"></script>
            <title>AI Chat</title>
          </head>
          <body>
            <div id="chat-container">
                <div id="input-area">
                    <div id="context-files"></div>
                    <textarea id="prompt" rows="3" placeholder="Type your message here, with @file.ext to mention files, and using tab to select the correct one..."></textarea>
                    <div tabindex='-1' id="file-options"></div>
                    <div class="options-container">
                        <div id="llmDropdown">
                            <label for="llmSelect">Select LLM:</label>
                            <select id="llmSelect">
                                ${optionsHtml}
                            </select>
                        </div>
                        <button id="clear-history">Clear History</button>
                    </div>

                    <div class="${disableOutput ? "checkbox-button-container-hidden" : "checkbox-button-container"}">
                        <input type="checkbox" id="writeToFileCheckbox" class="checkbox-button-input" ${writeToFile ? 'checked' : ''}>
                        <label for="writeToFileCheckbox" class="checkbox-button-label">Write to File</label>
                        <input ${writeToFile ? "" : "disabled"} type="text" id="outputFileNameInput" value="${outputFileName == "output" ? "" : outputFileName}" placeholder="Enter file name...">
                    </div>
                    
                    <div id="content"></div>
                    <button class="button-styling ask-chat" id="ask">Ask</button>
                </div>
                <div id="chat-history">
                    ${chatHistoryHtml}
                </div>
            </div>
            <script nonce="${nonce}" src="${jsFile}"></script>
          </body>
        </html>
        `;
    }
}

function deactivate() { }

module.exports = {
    activate,
    deactivate
}