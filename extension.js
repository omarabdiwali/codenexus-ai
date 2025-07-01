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
    LRUCache,
    runPythonFile,
    sanitizeProgram
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
let promptValue = "";
let currentMentionedFiles = {};

let llmIndex = 0;
let writeToFile = false;
let outputFileName = "output";
let fileTitles = {};
let currenlyResponding = false;
let continueResponse = true;
let agentMode = false;
let queuedChanges = [];

let runnablePrograms = {}
let programStartIndex = 0;
let lastCalled = 0;

const converter = new showdown.Converter();
converter.setOption("tables", true);
converter.setOption("smoothLivePreview", true);

const deepseek = "deepseek/deepseek-r1-0528:free";
const gemma = "google/gemini-2.0-flash-exp:free";
const qwen = "qwen/qwen3-32b:free";
const gemma3 = "google/gemma-3-27b-it:free";
const nvidia = "nvidia/llama-3.3-nemotron-super-49b-v1:free";
const llama = "meta-llama/llama-4-maverick:free";
const microsoft = "microsoft/mai-ds-r1:free"

const token = '!@!@!@!'
const backticks = '```';

const systemMessage = `
You are being used as a AI Coding Agent assistant. When the user asks you a question, and the response to the question 
has parts where changes are being made, like new files are being created or modified, YOU MUST generate the code to allow 
for the execution of the response, using the data given to you, ONLY USING PYTHON. The code that will allow for the exection of the response MUST 
be enclosed using ${token} once at the start and again at the end, before you even generate the code, making it outside the code block.
Make sure that the code you generate will succeed, and will do what it is intended to do, such as adding comments to an existing code file, 
or creating a new file in the current directory. Double check to make sure that it will work as intended. BETWEEN the ${token} scopes, the code 
MUST BE ABLE to run as if it is a PYTHON file, making sure the syntax and the spacing are correct. IF YOU ARE ASKED TO MODIFY A FILE, USE THE BASE WORKSPACE PATH 
TO PROVIDE A PATH THAT MAKES SURE THE CREATED FILE IS MADE IN THE CORRECT DIRECTORY. MAKE SURE that instead of just responding with the 
completed task as a chat, generate a Python program so that it can be run, and will make the changes that the user is looking for. MAKE SURE that 
what you import are NEEDED, and that IT IS BEING USED. If it is NEEDED and it does not look like it is installed, generate a function that will install the NEEDED packages 
for the user. MAKE SURE THAT ${token} is only being used at the start and end of the code you generated, and no where else, not even in your explainations. YOU ARE 
ABLE TO GENERATE MULTIPLE PROGRAMS IF NEEDED, and EVERYTIME YOU GENERATE THEM, make sure that it is enclosed within ${token}. AFTER YOU USE THE ${token}, make SURE 
THAT YOUR CODE BLOCK IS ALSO ENCLOSED using ${backticks}, with an example program looking like: ${token}\n${backticks}{program....}${backticks}\n${token}. DO NOT, I REPEAT, DO NOT 
SHOW ${token} ANYWHERE ELSE IN THE RESPONSE EXCEPT ENCLOSING YOUR GENERATED FUNCTION, NOT EVEN IN YOUR EXPLANATION. ALSO, for generated code, KEEP YOUR EXPLANATION TO A MINIMUM, AND 
IF NEEDED, ONLY GIVE MAXIMUM 2 SENTENCES. VERIFY THAT YOU ARE FOLLOWING ALL OF THESE RULES WHEN STREAMING YOUR RESPONSE. MAKE SURE, TRIPLE CHECK THAT THE PROGRAM HAS THE 
TOKEN BARRIER, AND FOLLOWS THE CORRECT BLUEPRINT AS THE EXAMPLE PROGRAM. ALSO, THE BASE PATH IS PROVIDED AS AN ENV VARIABLE AS WELL, WITH THE NAME 'BASE_WORKSPACE_PATH', MAKE SURE TO USE IT,
AS THE PROGRAM WILL BE RUNNING FROM A DIFFERENT DIRECTORY.
`

const llms = [
    gemma3,
    qwen,
    microsoft
];

const llmNames = [
    "Gemma 3.0 (27b)",
    "Qwen3 (32b)",
    "Microsoft MAI"
];

const updateQueuedChanges = () => {
    for (const [variant, value] of queuedChanges) {
        if (variant == "selectLLM") {
            llmIndex = parseInt(value);
        } else if (variant == "outputToFile") {
            writeToFile = value;
        } else if (variant == "changeMode") {
            agentMode = value == "false" ? false : true;
        }
    }

    queuedChanges = [];
}

const generateProgram = (panel, stream, currentTime=Date.now()) => {
    if (currentTime - lastCalled < 2000) return;
    lastCalled = currentTime;

    const initialIndex = stream.indexOf(token, programStartIndex);
    if (initialIndex == -1) return;
    const endIndex = stream.indexOf(token, initialIndex + token.length);
    if (endIndex == -1) return;

    let pyProg = stream.substring(initialIndex + token.length, endIndex);
    pyProg = sanitizeProgram(pyProg);
    if (!pyProg) return;

    const key = crypto.randomUUID();
    runnablePrograms[key] = pyProg;
    panel.webview.postMessage({ command: 'pythonProg', text: pyProg, key });
    programStartIndex = endIndex + token.length;
}

const sendStream = (panel, stream, final=false, key=null) => {
    if (writeToFile) {
        sendToFile(stream, outputFileName);
    } else if (panel && panel.webview) {
        let showData = stream.replaceAll(token, "");
        panel.webview.postMessage({ command: "response", text: converter.makeHtml(showData), value: final, key });
        agentMode && generateProgram(panel, stream);
    }
};

const addMessage = (messages, role, content) => {
    messages.push({
        role,
        content
    })
}

const generateMessages = async (chat, mentionedCode) => {
    const messages = [];
    const noFolder = !vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length == 0;
    let baseMessage = "";

    if (!noFolder) {
        let basePath = vscode.workspace.workspaceFolders[0].uri.path;
        if (basePath.at(0) == '/' || basePath.at(0) == '\\') basePath = basePath.substring(1);
        baseMessage = `BASE WORKSPACE PATH: ${basePath}`
    }

    agentMode && addMessage(messages, 'system', systemMessage);
    
    if (fileHistory.size() > 0) {
        const files = await fileHistory.getTextFile();
        addMessage(messages, 'system', files + '\n\n' + baseMessage);
    } else if (baseMessage) {
        addMessage(messages, 'system', baseMessage);
    }

    for (const {question, response, mode} of questionsAndResponses.slice(-5)) {
        const systemResponse = response.substring(0, response.lastIndexOf('\n'));
        if (!agentMode && mode != agentMode) continue;
        addMessage(messages, 'user', question);
        addMessage(messages, 'assistant', systemResponse);
    }

    addMessage(messages, 'user', mentionedCode.length > 0 ? chat + '\n\n' + mentionedCode : chat);
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
        const key = crypto.randomUUID();

        if (writeToFile) {
            const pathToFile = getFilePath(outputFileName);
            const webviewResponse = `The response to your question has been completed at:\n\n **${pathToFile}**`;
            sendToFile(`\n\n**${runTime}**\n\n`, outputFileName);

            if (panel && panel.webview) {
                panel.webview.postMessage({ command: "response", text: converter.makeHtml(webviewResponse) });
            }

        } else {
            agentMode && generateProgram(panel, totalResponse, lastCalled + 3500);
            sendStream(panel, totalResponse, true, key);
        }

        questionHistory.push(chat);
        responseHistory.push(totalResponse);
        questionsAndResponses.push({
            question: originalQuestion,
            response: totalResponse,
            mode: agentMode,
            key
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
                panel.webview.postMessage({ command: "error", text: err.message });
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
            await provider.handleIncomingData(data);
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
    const exclude = '{**/node_modules/**,**/.next/**,**/images/**,**/*.png,**/*.jpg,**/*.svg,**/*.git*,**/*.eslint**,**/*.mjs,**/public/**,**/*config**,**/*.lock,**/*.woff,**/.venv/**,**/*.vsix,**/*._.DS_Store,**/*.prettierrc}';
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
        this.interactions = 0;
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
        if (!this._view || !this._view.webview) return;
        const notOpenFolder = !vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length == 0;
        this._view.webview.postMessage({ command: 'fileTitles', value: fileTitles });
        if (!notOpenFolder) {
            this._view.webview.postMessage({ command: 'workspacePath', value: vscode.workspace.workspaceFolders[0].uri.path });
        }
    }

    updatePageValues() {
        if (!this._view || !this._view.webview) return;
        this._view.webview.postMessage({ command: 'updateValues', value: [writeToFile, agentMode, llmIndex] });
        this._view.webview.postMessage({ command: "promptValue", text: promptValue, value: currentMentionedFiles });
        this._view.webview.postMessage({ command: 'fileContext', value: Array.from(fileHistory.cache).reverse() });
    }

    loading() {
        if (!this._view || !this._view.webview) return;
        this._view.webview.postMessage({ command: "loading", text: this._getSpinner() });
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
                if (this.interactions != questionsAndResponses.length) {
                    webviewView.webview.html = this._getHtmlForWebview();
                    this.interactions = questionsAndResponses.length;
                }
                this.updateFileList();
                this.updatePageValues();
                this._view.webview.postMessage({ command: 'focus' });
            } else {
                textFromFile = "";
            }
        });

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.command === "chat") {
                if (currenlyResponding) return;
                
                promptValue = "";
                currentMentionedFiles = {};

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

                this.loading();                
                webviewView.webview.postMessage({ command: 'content', text: '' });
                currenlyResponding = true;

                const messages = await generateMessages(text, textFromFile);
                webviewView.webview.postMessage({ command: 'fileContext', value: Array.from(fileHistory.cache).reverse() });
                textFromFile = "";
                webviewView.webview.postMessage({ command: 'disableAsk' });
                await sendChat(webviewView, messages, this.openChat, text, llmIndex, 0, userQuestion);
                webviewView.webview.postMessage({ command: 'cancelView', value: false });

                updateQueuedChanges();
                currenlyResponding = false;
                programStartIndex = 0;
                lastCalled = 0;
            } else if (message.command === 'copy') {
                await vscode.env.clipboard.writeText(message.text);
            } else if (message.command === "selectLLM") {
                llmIndex = parseInt(message.index);
            } else if (message.command === 'remove') {
                textFromFile = "";
            } else if (message.command === 'clearHistory') {
                webviewView.webview.postMessage({ command: 'history', value: currenlyResponding });
                questionsAndResponses = [];
                runnablePrograms = {};
            } else if (message.command === 'stopResponse') {
                continueResponse = false;
                webviewView.webview.postMessage({ command: 'cancelView', value: false });
            } else if (message.command === 'outputToFile') {
                if (currenlyResponding) queuedChanges.push([message.command, message.checked]);
                else writeToFile = message.checked;
            } else if (message.command === 'fileContext') {
                fileHistory.delete(message.key);
            } else if (message.command === 'runProgram') {
                const file = runnablePrograms[message.key];
                await runPythonFile(file);
            } else if (message.command === 'changeMode') {
                if (currenlyResponding) queuedChanges.push([message.command, message.value]);
                else agentMode = message.value == 'false' ? false : true;
            } else if (message.command === 'updatePrompt') {
                promptValue = message.value;
                currentMentionedFiles = message.files;
            } else if (message.command === 'deleteEntry') {
                const index = questionsAndResponses.findIndex((val) => val.key == message.key)
                questionsAndResponses.splice(index, 1);
                this.interactions = questionsAndResponses.length - 1;
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
                <div class="chat-entry" id="${questionsAndResponses[i].key}">
                    <div class="question"><strong>You:</strong> ${highlightFilenameMentions(questionsAndResponses[i].question, fileTitles)}</div>
                    <div class="response">${converter.makeHtml(questionsAndResponses[i].response.replaceAll(token, ""))}</div>
                </div>
            `;
        }

        const jsFile = this._view.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "webview.js"));
        const cssFile = this._view.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "styles.css"));
        const nonce = getNonce();
        const disableOutput = !vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length == 0;

        const llmModes = ["Chat"];
        !disableOutput && llmModes.push("Agent");
        let llmModeOption = '';

        for (const mode of llmModes) {
            const selected = (mode == "Agent") == agentMode;
            const value = mode == "Agent"
            llmModeOption += `<option value="${value}" ${selected ? 'selected' : ''}>${mode}</option>`
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
            <script src="https://cdn.jsdelivr.net/npm/dompurify@3.2.5/dist/purify.min.js"></script>
            <title>AI Chat</title>
          </head>
          <body>
            <div id="chat-container">
                <div id="input-area">
                    <div id="context-files"></div>
                    <textarea id="prompt" rows="3" placeholder="Type your message here, with @file.ext to mention files (max 3), and using tab to select the correct one..."></textarea>
                    <div tabindex='-1' id="file-options"></div>
                    <div class="options-container">
                        <div id="llmDropdown">
                            <label for="llmSelect">Select LLM:</label>
                            <select id="llmSelect">
                                ${optionsHtml}
                            </select>
                        </div>
                        <select id="mode-select">
                            ${llmModeOption}
                        </select>
                    </div>

                    <div class="options-container">
                        <div class="${disableOutput ? "checkbox-button-container-hidden" : "checkbox-button-container"}">
                            <input type="checkbox" id="writeToFileCheckbox" class="checkbox-button-input" ${writeToFile ? 'checked' : ''}>
                            <label for="writeToFileCheckbox" class="checkbox-button-label">Write to File</label>
                            <input ${writeToFile ? "" : "disabled"} type="text" id="outputFileNameInput" value="${outputFileName == "output" ? "" : outputFileName}" placeholder="Enter file name...">
                        </div>
                        <button id="clear-history">Clear History</button>
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