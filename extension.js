const vscode = require('vscode');
const openai = require('openai');
const showdown = require('showdown');
const { performance } = require("perf_hooks");

const {
    getFilePath,
    getAllFiles,
    sendToFile,
    replaceFileMentions,
    highlightFilenameMentions,
    getNonce,
    LRUCache,
    runPythonFile,
    getAllRunnablePrograms,
    debounce,
} = require("./functions");

const userQuestions = [];
const questionHistory = [];
const responseHistory = [];
const fileHistory = new LRUCache(3);
const defaultInclude = "";
const defaultExclude = "{**/node_modules/**,**/.next/**,**/images/**,**/*.png,**/*.jpg,**/*.svg,**/*.git*,**/*.eslint**,**/*.mjs,**/public/**,**/*config**,**/*.lock,**/*.woff,**/.venv/**,**/*.vsix,**/*._.DS_Store,**/*.prettierrc,**/Lib/**,**/lib/**}";

let questionsAndResponses = [];
let currentResponse = "";
let textFromFile = "";
let promptValue = "";
let currentMentionedFiles = {};

let llmIndex = 0;
let writeToFile = false;
let outputFileName = "output";
let fileTitles = {};
let currentlyResponding = false;
let continueResponse = true;
let agentMode = false;
let ollama = false;
let queuedChanges = [];

let runnablePrograms = {}
let lastCalled = 0;
let interactionHistory = 5;
let include = defaultInclude;
let exclude = defaultExclude;

const converter = new showdown.Converter();
converter.setOption("tables", true);
converter.setOption("smoothLivePreview", true);

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
TOKEN BARRIER, AND FOLLOWS THE CORRECT BLUEPRINT AS THE EXAMPLE PROGRAM. ALSO, THE BASE PATH IS PROVIDED AS AN ENV VARIABLE AS WELL, WITH THE NAME 'BASE_WORKSPACE_PATH'. If asked to do multiple things, 
break the program into logical parts, that when run in a certain order, will achieve what the user wants. For example, if the user asks for something like "Create a React project, 
then make it a tic-tac-toe game", it will be broken up into two parts, the first program being creating the React project, and the second being fulfilling the tic-tac-toe requirement. 
When running something through a command prompt, make sure to run it through a shell. The user's operating system platform is: ${process.platform}
`

let openRouterModels = [];
let openRouterNames = [];
let ollamaModels = [];
let ollamaNames = [];
let customSystemPrompt = "";

const fileConfigChange = async (config, provider) => {
    const included = config.get("FilesIncluded", defaultInclude);
    const excluded = config.get("FilesExcluded", defaultExclude);
    fileTitles = await getAllFiles(included, excluded, defaultInclude, defaultExclude);
    provider.updateFileList();
}

const configChangeDebounce = debounce(fileConfigChange, 1500);

const updateConfig = async (event, provider) => {
    const config = vscode.workspace.getConfiguration("CodenexusAI");
    if (isChanged("OpenRouterModels", event)) {
        const models = config.get("OpenRouterModels", []);
        const validModels = models.filter((val) => val.trim().length != 0);
        if (models.length != validModels.length) await config.update("OpenRouterModels", validModels);
    } else if (isChanged("OpenRouterModelNames", event)) {
        const modelNames = config.get("OpenRouterModelNames", []);
        const validNames = modelNames.filter((val) => val.trim().length != 0);
        if (modelNames.length != validNames.length) await config.update("OpenRouterModelNames", validNames);
    } else if (isChanged("FilesIncluded", event) || isChanged("FilesExcluded", event)) {
        configChangeDebounce(config, provider);
    }
}

const getConfigData = async (event=null, provider=null) => {
    event && await updateConfig(event, provider);
    const config = vscode.workspace.getConfiguration("CodenexusAI");
    
    const orModels = config.get("OpenRouterModels", []).filter((val) => val.trim().length != 0);
    const orModelNames = config.get("OpenRouterModelNames", []).filter((val) => val.trim().length != 0);
    const orLength = Math.min(orModels.length, orModelNames.length);
    
    const olModels = config.get("OllamaModels", []).filter((val) => val.trim().length != 0);
    const olNames = config.get("OllamaModelNames", []).filter((val) => val.trim().length != 0);
    const olLength = Math.min(olModels.length, olNames.length);
    
    ollamaModels = olModels.slice(0, olLength);
    ollamaNames = olNames.slice(0, olLength);
    openRouterModels = orModels.slice(0, orLength);
    openRouterNames = orModelNames.slice(0, orLength);

    ollama = config.get("UseOllama", false);    
    llmIndex = ollama ? Math.min(llmIndex, olLength - 1) : Math.min(llmIndex, orLength - 1);
    llmIndex = Math.max(0, llmIndex);
    fileHistory.changeSize(config.get("ContextFileSize", 3));
    interactionHistory = config.get("ContextInteractionSize", 5);
    include = config.get("FilesIncluded", "");
    exclude = config.get("FilesExcluded", defaultExclude);
    customSystemPrompt = config.get("SystemPrompt", "").trim();
}

const isChanged = (value, event) => {
    return event.affectsConfiguration(`CodenexusAI.${value}`)
}

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

const generateProgram = (panel, stream, final) => {
    const currentTime = Date.now();
    if (currentTime - lastCalled < 2000 && !final) return;
    lastCalled = currentTime;

    const programs = getAllRunnablePrograms(stream, token, final);
    for (const prog of programs) {
        const key = crypto.randomUUID();
        runnablePrograms[key] = prog;
        panel.webview.postMessage({ command: 'pythonProg', text: prog, key });
    }
}

const sendStream = (panel, stream, final=false, key=null) => {
    if (!panel || !panel.webview) return;
    const showData = stream.replaceAll(token, "");
    agentMode && generateProgram(panel, stream, final);
    panel.webview.postMessage({ command: "response", text: converter.makeHtml(showData), value: final, key });
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
    customSystemPrompt.length && addMessage(messages, 'system', customSystemPrompt);
    
    if (fileHistory.size() > 0) {
        const files = await fileHistory.getTextFile();
        addMessage(messages, 'system', files + '\n\n' + baseMessage);
    } else if (baseMessage) {
        addMessage(messages, 'system', baseMessage);
    }

    for (const {question, response, mode} of questionsAndResponses.slice(-interactionHistory)) {
        const systemResponse = response.substring(0, response.lastIndexOf('\n'));
        if (!agentMode && mode != agentMode) continue;
        addMessage(messages, 'user', question);
        addMessage(messages, 'assistant', systemResponse);
    }

    addMessage(messages, 'user', mentionedCode.length > 0 ? chat + '\n\n' + mentionedCode : chat);
    return messages;
}

const sendChat = async (panel, messages, openChat, chat, index, count, originalQuestion, models, names) => {
    const startTime = performance.now();
    let sendMessage = true;
    currentResponse = "";

    try {
        const stream = await openChat.chat.completions.create({
            model: models[index],
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
        
        const runTime = `Call to ${names[index]} took ${totalTime} seconds.`;
        const totalResponse = `${currentResponse}\n\n**${runTime}**`;
        const key = crypto.randomUUID();

        if (writeToFile) {
            const pathToFile = getFilePath(outputFileName);
            const webviewResponse = `The response to your question has been completed at:\n\n **${pathToFile}**`;
            sendToFile(`\n\n**${runTime}**\n\n`, outputFileName);

            if (panel && panel.webview) {
                panel.webview.postMessage({ command: "response", text: converter.makeHtml(webviewResponse), value: true, key });
            }

        } else {
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
            const runTime = `Call to ${names[index]} took ${totalTime} seconds.`;
            writeToFile ? sendToFile(`**${runTime}**`, outputFileName) : sendStream(panel, runtime);
            continueResponse = true;
            return;
        }
        if (count === models.length) {
            console.log("hit an error!");
            console.log(err.error);

            if (responseHistory.length < questionHistory.length) {
                responseHistory.push(err.message);
            }

            if (!writeToFile && panel && panel.webview) {
                panel.webview.postMessage({ command: "error", text: err.message, key: crypto.randomUUID() });
            } else {
                vscode.window.showErrorMessage("Error writing to chat: " + err.message);
            }
        } else {
            index += 1;
            index %= models.length;
            await sendChat(panel, messages, openChat, chat, index, count + 1, originalQuestion, models, names);
        }
    }
};

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
    let apiKey = await context.secrets.get('codeNexusApiKey');
    if (!apiKey) {
        apiKey = await vscode.window.showInputBox({
            prompt: 'Enter your OpenRouter API key',
            ignoreFocusOut: true,
            password: true,
        });

        if (!apiKey) {
            vscode.window.showErrorMessage('CodeNexus requires an OpenRouter API key to function.');
            return;
        }

        await context.secrets.store('codeNexusApiKey', apiKey);
    }

    await getConfigData();
    const provider = new CodeNexusViewProvider(context.extensionUri, context, apiKey);

    const updateOpenAIClient = (key) => {
        if (provider) {
            provider.apiKey = key;
            provider.openChat = new openai.OpenAI({
                baseURL: "https://openrouter.ai/api/v1",
                apiKey: key
            });
        }
    };

    const changeApiKeyCommand = vscode.commands.registerCommand('codenexus-ai.changeApiKey', async () => {
        const newApiKey = await vscode.window.showInputBox({
            prompt: 'Enter your new OpenRouter API key',
            ignoreFocusOut: true,
            password: true,
        });

        if (newApiKey) {
            await context.secrets.store('codeNexusApiKey', newApiKey);
            updateOpenAIClient(newApiKey);
            vscode.window.showInformationMessage('OpenRouter API key updated successfully.');
        } else {
            vscode.window.showWarningMessage('No API Key entered. Key not updated.');
        }
    });
    
    vscode.commands.registerCommand('codenexus-ai.chat.focus', async (data) => {
        if (provider) {
            provider.show();
            await provider.handleIncomingData(data);
        } else {
            vscode.window.showWarningMessage("Chat view provider not available yet.");
        }
    })

    const openChatShortcut = vscode.commands.registerCommand('codenexus-ai.openChatWithSelection', async () => {
        const editor = vscode.window.activeTextEditor;
        const text = editor ? editor.document.getText(editor.selection) : "";
        await vscode.commands.executeCommand('codenexus-ai.chat.focus', text);
    });

    vscode.workspace.onDidChangeConfiguration(async (event) => {        
        if (event.affectsConfiguration("CodenexusAI")) {
            await getConfigData(event, provider);
            provider.updateHTML();
        }
    })

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CodeNexusViewProvider.viewType, provider),
        changeApiKeyCommand,
        openChatShortcut
    );

    fileTitles = await getAllFiles(include, exclude, defaultInclude, defaultExclude);

    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.*', false, true, false);
    const getFilesOnChange = async () => {
        fileTitles = await getAllFiles(include, exclude, defaultInclude, defaultExclude);
        provider.updateFileList();
    }

    const debounceWatcher = debounce(getFilesOnChange, 1000)

    fileWatcher.onDidCreate(async (uri) => {
        debounceWatcher();
    });
    fileWatcher.onDidDelete(async (uri) => {
        debounceWatcher();
    });
}

class CodeNexusViewProvider {
    static viewType = 'codenexus-ai.chat';
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
        this.ollamaChat = new openai.OpenAI({
            baseURL: 'http://localhost:11434/v1',
            apiKey: 'ollama'
        })
    }

    async handleIncomingData(data) {
        if (!this._view || !this._view.webview) return;
        let trimmed = data.replaceAll("\n", "").replaceAll(" ", "");
        
        if (trimmed.length > 0) {
            textFromFile = data;
            let htmlText = converter.makeHtml("```\n" + data + "\n```");
            await new Promise(res => setTimeout(res, 500));
            this._view.webview.postMessage({ command: 'content', text: htmlText });
        }

        this._view.webview.postMessage({ command: 'focus' });
    }

    updateWorkspacePath() {
        if (!this._view || !this._view.webview) return;
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length == 0) return;
        this._view.webview.postMessage({ command: 'workspacePath', value: vscode.workspace.workspaceFolders[0].uri.path });
    }

    updateFileList(updatePath=true) {
        if (!this._view || !this._view.webview) return;
        const notOpenFolder = !vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length == 0;
        this._view.webview.postMessage({ command: 'fileTitles', value: fileTitles });
        if (!notOpenFolder && updatePath) {
            this._view.webview.postMessage({ command: 'workspacePath', value: vscode.workspace.workspaceFolders[0].uri.path });
        }
    }

    updatePageValues() {
        if (!this._view || !this._view.webview) return;
        this._view.webview.postMessage({ command: 'updateValues', value: [writeToFile, agentMode, llmIndex, fileHistory.maxSize] });
        this._view.webview.postMessage({ command: "promptValue", text: promptValue, value: currentMentionedFiles });
        this._view.webview.postMessage({ command: 'fileContext', value: Array.from(fileHistory.cache) });
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

    updateHTML() {
        if (!this._view || !this._view.webview) return;
        this._view.webview.html = this._getHtmlForWebview();
        this.updateWorkspacePath();
        this.updatePageValues();
        this.updateFileList(false);
    }

    inProgress() {
        if (!this._view || !this._view.webview) return;
        if (currentlyResponding) {
            this._view.webview.postMessage({ command: "chat", text: userQuestions.at(-1) });
            this._view.webview.postMessage({ command: "loading", text: this._getSpinner() });
            this._view.webview.postMessage({ command: "cancelView", value: true });
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
                this.inProgress();
                this.updateWorkspacePath();
                this.updatePageValues();
                this.updateFileList(false);
                webviewView.webview.postMessage({ command: 'focus' });
            } else {
                textFromFile = "";
            }
        });

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.command === "chat") {
                const numOfModels = ollama ? ollamaModels.length : openRouterModels.length;
                if (currentlyResponding) return;
                if (llmIndex >= numOfModels || llmIndex < 0) {
                    const provider = ollama ? 'Ollama' : 'OpenRouter';
                    vscode.window.showErrorMessage(`No available models for ${provider}. Add LLMs using the 'Settings' icon on the webview.`);
                    return;
                }
                
                webviewView.webview.postMessage({ command: 'disableAsk' });
                currentlyResponding = true;
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
                
                if (writeToFile) sendToFile("## " + userQuestion + "\n\n", outputFileName);

                let text = message.text;
                for (const [index, info] of Object.entries(message.mentionedFiles)) {
                    const [file, location] = info;
                    fileHistory.put(location, file);
                    text = replaceFileMentions(text, ["@" + file]);
                }

                this.loading();                
                webviewView.webview.postMessage({ command: 'content', text: '' });

                const messages = await generateMessages(text, textFromFile);
                webviewView.webview.postMessage({ command: 'fileContext', value: Array.from(fileHistory.cache) });
                textFromFile = "";
                if (ollama) await sendChat(webviewView, messages, this.ollamaChat, text, llmIndex, 0, userQuestion, ollamaModels, ollamaNames)
                else await sendChat(webviewView, messages, this.openChat, text, llmIndex, 0, userQuestion, openRouterModels, openRouterNames);
                webviewView.webview.postMessage({ command: 'cancelView', value: false });

                updateQueuedChanges();
                currentlyResponding = false;
                lastCalled = 0;
            } else if (message.command === 'copy') {
                await vscode.env.clipboard.writeText(message.text);
            } else if (message.command === "selectLLM") {
                llmIndex = parseInt(message.index);
            } else if (message.command === 'remove') {
                textFromFile = "";
            } else if (message.command === 'clearHistory') {
                webviewView.webview.postMessage({ command: 'history', value: currentlyResponding });
                questionsAndResponses = [];
                runnablePrograms = {};
            } else if (message.command === 'stopResponse') {
                continueResponse = false;
                webviewView.webview.postMessage({ command: 'cancelView', value: false });
            } else if (message.command === 'outputToFile') {
                if (currentlyResponding) queuedChanges.push([message.command, message.checked]);
                else writeToFile = message.checked;
            } else if (message.command === 'fileContext') {
                fileHistory.delete(message.key);
            } else if (message.command === 'runProgram') {
                const file = runnablePrograms[message.key];
                if (!file) return;
                delete runnablePrograms[message.key]
                await runPythonFile(file);
            } else if (message.command === 'changeMode') {
                if (currentlyResponding) queuedChanges.push([message.command, message.value]);
                else agentMode = message.value == 'false' ? false : true;
            } else if (message.command === 'updatePrompt') {
                promptValue = message.value;
                currentMentionedFiles = message.files;
            } else if (message.command === 'deleteEntry') {
                const index = questionsAndResponses.findIndex((val) => val.key == message.key)
                if (index == -1) return;
                questionsAndResponses.splice(index, 1);
                this.interactions = questionsAndResponses.length - 1;
            } else if (message.command === 'openSettings') {
                await vscode.commands.executeCommand("workbench.action.openSettings", "CodenexusAI")
            } else if (message.command === 'refreshFiles') {
                fileTitles = await getAllFiles(include, exclude, defaultInclude, defaultExclude);
                webviewView.webview.postMessage({ command: 'fileTitles', value: fileTitles });
            } else if (message.command === 'updateApiKey') {
                await vscode.commands.executeCommand('codenexus-ai.changeApiKey');
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
        let names = ollama ? ollamaNames : openRouterNames;
        let optionsHtml = '';
        for (let i = 0; i < names.length; i++) {
            optionsHtml += `<option value="${i}" ${i === llmIndex ? 'selected' : ''}>${names[i]}</option>`;
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
        const placeholder = `Type your message here, with @file.ext to mention files (max ${fileHistory.maxSize}), and using tab to select the correct one...`

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
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css">
            <link rel="stylesheet" href="${cssFile}">
            <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
            <script src="https://cdn.jsdelivr.net/npm/dompurify@3.2.5/dist/purify.min.js"></script>
            <title>CodeNexus</title>
          </head>
          <body>
            <div id="chat-container">
                <div id="input-area">
                    <div id="context-files"></div>
                    <textarea id="prompt" rows="3" placeholder="${placeholder}"></textarea>
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
                        <div class="checkbox-button-container">
                            <input type="checkbox" id="writeToFileCheckbox" class="checkbox-button-input" ${writeToFile ? 'checked' : ''}>
                            <label for="writeToFileCheckbox" class="checkbox-button-label">
                                <i class="fa-solid fa-xmark fa-xl icon-x"></i>
                                <span class="label-text">Write to File</span>
                            </label>
                            <input ${writeToFile ? "" : "disabled"} type="text" id="outputFileNameInput" value="${outputFileName == "output" ? "" : outputFileName}" placeholder="Enter file name...">
                        </div>
                        <button title="Clear History" class="options" id="clear-history"><i class="fas fa-solid fa-trash-can icon"></i></button>
                        <button title="Refresh files" class="options" id="refresh-files"><i class="fas fa-solid fa-sync-alt icon"></i></button>
                        <button title="Update API Key" class="options" id="api-key"><i class="fas fa-key icon"></i></button>
                        <button title="Settings" class="options" id="open-settings"><i class="fas fa-cog icon"></i></button>
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