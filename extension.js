const vscode = require('vscode');
const openai = require('openai');
const fs = require('fs');
const { performance } = require("perf_hooks");

const { unified } = require('unified');
const remarkParseMod = require('remark-parse');
const remarkGfmMod = require('remark-gfm');
const remarkRehypeMod = require('remark-rehype');
const rehypeStringifyMod = require('rehype-stringify');
const rehypeSanitizeMod = require('rehype-sanitize');

const remarkParse = remarkParseMod.default || remarkParseMod;
const remarkGfm = remarkGfmMod.default || remarkGfmMod;
const remarkRehype = remarkRehypeMod.default || remarkRehypeMod;
const rehypeStringify = rehypeStringifyMod.default || rehypeStringifyMod;
const rehypeSanitize = rehypeSanitizeMod.default || rehypeSanitizeMod;

const {
    fileRegEx,
    getFilePath,
    getAllFiles,
    sendToFile,
    replaceFileMentions,
    highlightFilenameMentions,
    getRandomString,
    LRUCache,
    runPythonFile,
    getAllRunnablePrograms,
    debounce,
    sanitizeString,
    initializeNewSession,
    setSessionTitle,
} = require("./functions");

const userQuestions = [];
const questionHistory = [];
const responseHistory = [];
const activePrograms = new Set();
const defaultInclude = "";
const defaultExclude = "{**/node_modules/**,**/.next/**,**/images/**,**/*.png,**/*.jpg,**/*.svg,**/*.git*,**/*.eslint**,**/*.mjs,**/public/**,**/*config**,**/*.lock,**/*.woff,**/.venv/**,**/*.vsix,**/*._.DS_Store,**/*.prettierrc,**/Lib/**,**/lib/**}";

let fileHistory = new LRUCache(3);
let sessions = [];
let currentSession = initializeNewSession(sessions, 3);
let currentResponse = "";
let textFromFile = "";
let savedData = { text: "", addition: false };
let promptValue = "";
let currentMentionedFiles = {};
let locationOfMentionedFiles = [];
let attachments = [];

let llmIndex = 0;
let writeToFile = false;
let outputFileName = "output";
let fileTitles = {};
let currentlyResponding = false;
let currentQuestionObj = {};
let continueResponse = true;
let agentMode = false;
let ollama = false;
let queuedChanges = [];

let runnablePrograms = {}
let lastCalled = 0;
let interactionHistory = 5;
let lruSize = 3;
let include = defaultInclude;
let exclude = defaultExclude;

const mdProcessor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSanitize)
    .use(rehypeStringify);

const token = '!@!@!@!'
const backticks = '````';

const systemMessage = `
You are an AI Coding Agent assistant. When the user asks a question involving changes like file creation or modification, you MUST generate Python code that can be executed to perform those changes. The code you generate MUST:

- Be enclosed exactly once at the beginning and once at the end with ${token}, with no other usages of ${token} inside or outside the code.
- Be syntactically correct and executable as a Python file.
- Use only Python.
- Use necessary imports and no unnecessary ones. If a package is needed but not installed, generate a Python function within the code to install it.
- When modifying or creating files, use the environment variable 'BASE_WORKSPACE_PATH' for file paths to ensure correct directory placement, and always default to the current directory, or '.'.
- If multiple steps or programs are needed, split them logically into multiple Python programs, each enclosed separately following the mentioned rules.
- When needing to execute commands, use shell execution via Python.
- Provide some explanation (no more than four sentences) about the code after generating it.
- After enclosing the Python code within ${token}, also enclose it within ${backticks.length} backticks as shown:

  ${token}
  ${backticks}python
  # your python code
  ${backticks}
  ${token}

- The user's operating system platform is indicated as ${process.platform} if platform-dependent concerns arise.

Always double-check that you follow these rules exactly before streaming your response.

# Output Format

Generate only the described Python program(s) enclosed exactly once with ${token} at start and end, and also ${backticks.length} backticks around the code block inside those tokens. Include a brief explanation if needed, but keep it minimal and after the enclosed code.
`

let openRouterModels = [];
let openRouterNames = [];
let ollamaModels = [];
let ollamaNames = [];
let customSystemPrompt = "";

/**
 * Sets the global variables to the fields in the chosen `sessionId`.
 * @param {string | number} sessionId - The selected sessionId.
 */
const setGlobalVariables = (sessionId) => {
    if (!(sessionId in sessions)) return;
    promptValue = sessions[sessionId].prompt;
    currentMentionedFiles = sessions[sessionId].mentionedFiles;
    writeToFile = sessions[sessionId].writeToFile;
    agentMode = sessions[sessionId].agentMode;
    outputFileName = sessions[sessionId].outputFileName;
    attachments = sessions[sessionId].files;
    textFromFile = sessions[sessionId].textFromFile;

    const currentModels = ollama ? ollamaModels : openRouterModels;
    llmIndex = Math.min(sessions[sessionId].llmIndex, currentModels.length - 1);
    llmIndex = Math.max(llmIndex, 0);
    sessions[sessionId].llmIndex = llmIndex;
    fileHistory = sessions[sessionId].fileHistory;
    if (fileHistory.size() != lruSize) fileHistory.changeSize(lruSize);
}

/**
 * Updates the session variable within the currently active session (`currentSession`).
 * @param {string} key - The key to update.
 * @param {any} value - The value to set the key to.
 */
const updateSessionVariable = (key, value) => {
    if (!(currentSession in sessions)) return;
    sessions[currentSession][key] = value;
}

/**
 * Adds file information to user question by replacing file mentions with file titles and locations.
 * @param {string} message - The user message containing file mentions.
 * @returns {string} The message with file information added.
 */
const addFileInfoToUserQuestion = (message) => {
    let count = 0;
    const infoMessage = message.replace(fileRegEx, (match) => {
        const title = match.substring(1);
        if (!(title in fileTitles)) return match;
        const location = locationOfMentionedFiles.at(count);
        if (location === undefined) return match;
        count++;
        return `${title} (${location})`
    })

    locationOfMentionedFiles = [];
    return infoMessage;
}

/**
 * Converts markdown to HTML using unified processor.
 * @param {string} md - The markdown text to convert.
 * @returns {Promise<string>} - The converted HTML string.
 */
const mdToHtml = async (md) => {
    const file = await mdProcessor.process(md || '');
    return String(file);
}

/**
 * Handles file configuration changes.
 * @param {vscode.WorkspaceConfiguration} config - The workspace configuration.
 * @param {CodeNexusViewProvider} provider - The view provider instance.
 */
const fileConfigChange = (config, provider) => {
    include = config.get("FilesIncluded", defaultInclude);
    exclude = config.get("FilesExcluded", defaultExclude);
    provider.updateFileList();
}

/**
 * Handles model and name changes for LLM providers.
 * @param {string} change - The type of change (OpenRouter/Ollama).
 * @param {string} type - The type of update (models/names).
 * @param {Array} newValue - The new values.
 * @param {CodeNexusViewProvider} provider - The view provider instance.
 * @param {vscode.WorkspaceConfiguration} config - The workspace configuration.
 */
const handleModelAndNameChanges = (change, type, newValue, provider, config) => {
    const modelChange = type === "models";
    let renderChange = true;
    if (change.startsWith("OpenRouter")) {
        const otherType = modelChange ? "OpenRouterModelNames" : "OpenRouterModels";
        const otherValue = config.get(otherType, []);
        const cutoff = Math.min(newValue.length, otherValue.length);
        openRouterModels = modelChange ? newValue.slice(0, cutoff) : otherValue.slice(0, cutoff);
        openRouterNames = modelChange ? otherValue.slice(0, cutoff) : newValue.slice(0, cutoff);
        renderChange = !ollama;
    } else if (change.startsWith("Ollama")) {
        const otherType = modelChange ? "OllamaModelNames" : "OllamaModels";
        const otherValue = config.get(otherType, []);
        const cutoff = Math.min(newValue.length, otherValue.length);
        ollamaModels = modelChange ? newValue.slice(0, cutoff) : otherValue.slice(0, cutoff);
        ollamaNames = modelChange ? otherValue.slice(0, cutoff) : newValue.slice(0, cutoff);
        renderChange = ollama;
    }

    const names = ollama ? ollamaNames : openRouterNames;
    llmIndex = Math.min(llmIndex, names.length - 1);
    llmIndex = Math.max(0, llmIndex);

    const payload = {
        key: "models",
        value: {
            names,
            index: llmIndex
        }
    }

    renderChange && provider.postMessage("configUpdate", payload);
}

const configChangeDebounce = debounce(fileConfigChange, 3000);

/**
 * Checks if a specific configuration has changed.
 * @param {string} value - The configuration key to check.
 * @param {vscode.ConfigurationChangeEvent} event - The configuration change event.
 * @returns {boolean} `true` if the configuration has changed.
 */
const isChanged = (value, event) => {
    return event.affectsConfiguration(`CodenexusAI.${value}`)
}

/**
 * Updates configuration based on workspace changes.
 * @param {vscode.ConfigurationChangeEvent} event - The configuration change event.
 * @param {CodeNexusViewProvider} provider - The view provider instance.
 * @returns {Promise<void>}
 */
const updateConfig = async (event, provider) => {
    const config = vscode.workspace.getConfiguration("CodenexusAI");
    if (isChanged("OpenRouterModels", event) || isChanged("OllamaModels", event)) {
        const key = isChanged("OpenRouterModels", event) ? "OpenRouterModels" : "OllamaModels";
        const models = config.get(key, []);
        const validModels = models.filter((val) => val.trim().length != 0);
        handleModelAndNameChanges(key, "models", validModels, provider, config);
    } else if (isChanged("OpenRouterModelNames", event) || isChanged("OllamaModelNames", event)) {
        const key = isChanged("OpenRouterModelNames", event) ? "OpenRouterModelNames" : "OllamaModelNames";
        const modelNames = config.get(key, []);
        const validNames = modelNames.filter((val) => val.trim().length != 0);
        handleModelAndNameChanges(key, "names", validNames, provider, config);
    } else if (isChanged("FilesIncluded", event) || isChanged("FilesExcluded", event)) {
        await configChangeDebounce(config, provider);
    } else if (isChanged("UseOllama", event)) {
        ollama = config.get("UseOllama", false);
        handleModelAndNameChanges("useOllama", "ollama", [], provider, config);
    } else if (isChanged("ContextFileSize", event)) {
        lruSize = config.get("ContextFileSize", 3);
        fileHistory.changeSize(lruSize);
        const payload = { key: "fileSize", value: lruSize };
        const otherPayload = { value: Array.from(fileHistory.cache) };
        provider.postMessage("configUpdate", payload);
        provider.postMessage("fileHistory", otherPayload);
    } else if (isChanged("ContextInteractionSize", event)) {
        interactionHistory = config.get("ContextInteractionSize", 5)
    } else if (isChanged("SystemPrompt", event)) {
        customSystemPrompt = config.get("SystemPrompt", "").trim()
    }
}

/**
 * Gets or updates configuration data.
 * @param {vscode.ConfigurationChangeEvent} [event=null] - The configuration change event.
 * @param {CodeNexusViewProvider} [provider=null] - The view provider instance.
 * @returns {Promise<void>}
 */
const getConfigData = async (event=null, provider=null) => {
    if (event && provider) {
        await updateConfig(event, provider);
        return;
    }

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
    lruSize = config.get("ContextFileSize", 3);
    fileHistory.changeSize(lruSize);
    interactionHistory = config.get("ContextInteractionSize", 5);
    include = config.get("FilesIncluded", "");
    exclude = config.get("FilesExcluded", defaultExclude);
    customSystemPrompt = config.get("SystemPrompt", "").trim();
}

/**
 * Updates queued configuration changes.
 */
const updateQueuedChanges = async () => {
    for (const [variant, value] of queuedChanges) {
        if (variant == "selectLLM") {
            llmIndex = parseInt(value);
            updateSessionVariable("llmIndex", parseInt(value));
        } else if (variant == "outputToFile") {
            writeToFile = value;
            updateSessionVariable("writeToFile", value);
        } else if (variant == "changeMode") {
            agentMode = value == "false" ? false : true;
            updateSessionVariable("agentMode", agentMode);
        } else if (variant == "configUpdate") {
            await getConfigData(value[0], value[1]);
        }
    }

    queuedChanges = [];
}

/**
 * Generates a Python program from the LLM response stream.
 * @param {CodeNexusViewProvider} provider - The view provider instance.
 * @param {string} stream - The response stream text.
 * @param {boolean} final - Whether this is the final chunk.
 * @param {string} chatKey - The unique key of the response.
 */
const generateProgram = (provider, stream, final, chatKey) => {
    const currentTime = Date.now();
    if (currentTime - lastCalled < 2000 && !final) return;
    lastCalled = currentTime;

    const programs = getAllRunnablePrograms(stream, token, final);
    for (const prog of programs) {
        const key = chatKey + " / " + crypto.randomUUID();
        runnablePrograms[key] = prog;
        activePrograms.add(key);
        provider.postMessage('pythonProg', { text: prog, key });
    }
}

/**
 * Sends a stream response to the webview.
 * @param {CodeNexusViewProvider} provider - The view provider instance.
 * @param {string} stream - The response stream text.
 * @param {boolean} [final=false] - Whether this is the final chunk.
 * @param {string} [key=null] - The unique key for this response.
 * @returns {Promise<void>}
 */
const sendStream = async (provider, stream, final=false, key=null) => {
    const showData = stream.replaceAll(token, "");
    agentMode && generateProgram(provider, stream, final, key);
    const html = await mdToHtml(showData);
    provider.postMessage("response", { text: html, value: final, key });
};

/**
 * Adds a message to the messages array.
 * @param {Array} messages - The messages array, showing the conversation.
 * @param {string} role - The role (user/assistant/system).
 * @param {string} text - The message text.
 * @param {boolean} [addFiles=false] - Add files to the message.
 */
const addMessage = (messages, role, text, addFiles=false) => {
    if (addFiles) {
        const content = [{ type: "text", text }];
        for (const file of attachments) {
            content.push({
                type: "image_url",
                image_url: {
                    url: file.content,
                    detail: "low"
                }
            })
        }
        messages.push({ role, content });
    } else {
        messages.push({
            role,
            content: [{ type: "text", text }]
        })
    }
}

/**
 * Adds the image data to the previous message element.
 * @param {Array} messages - The messages array, showing the conversation.
 * @param {string} imageData - The image data in base64 format.
 * @param {string} imageType - The file type of the image.
 * @param {string} match - The markdown image string.
 */
const addImageToMessage = (messages, imageData, imageType, match) => {
    const lastMessage = messages.at(-1);
    const imageObj = {
        type: "image_url",
        image_url: {
            url: `data:image/${imageType};base64,${imageData}`,
            detail: "low"
        }
    }

    let messageText = lastMessage.content[0].text;
    messageText = messageText.replace(match, "");
    lastMessage.content[0].text = messageText;
    lastMessage.content.push(imageObj);
    messages[messages.length - 1] = lastMessage;
}

/**
 * Generates messages for the LLM API call.
 * @param {string} chat - The user's chat message.
 * @param {string} mentionedCode - Any code mentioned in the message.
 * @returns {Promise<Array>} The array of messages.
 */
const generateMessages = async (chat, mentionedCode) => {
    const messages = [];
    const noFolder = !vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length == 0;
    let completeMessage = addFileInfoToUserQuestion(chat);
    let baseMessage = "";

    if (mentionedCode && mentionedCode.length > 0) completeMessage += '\n\n' + mentionedCode;

    if (!noFolder) {
        let basePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
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

    for (const { question, response, snippet, mode } of sessions[currentSession].chats.slice(-interactionHistory)) {
        const systemResponse = response.substring(0, response.lastIndexOf('\n'));
        const compQuestion = snippet && snippet.trim().length > 0 ? question + '\n\n' + snippet : question;
        if (!agentMode && mode != agentMode) continue;
        addMessage(messages, 'user', compQuestion);
        addMessage(messages, 'assistant', systemResponse);
        parseResponseForImages(systemResponse, messages);
    }

    addMessage(messages, 'user', completeMessage, true);
    return messages;
}

/**
 * Verifies that a directory exists, and if it doesn't, creates it.
 * @param {string} path - The path of the directory.
 */
const verifyDirectoryExists = (path) => {
    if (!fs.existsSync(path)) {
        try {
            fs.mkdirSync(path);
        } catch (e) {
            console.log(e);
        }
    }
}

/**
 * Translate an image from a data: url to a vscode.Uri, and save it to a file.
 * @param {CodeNexusViewProvider} provider - The view provider instance.
 * @param {string} imageUrl - The data: url string for the image.
 * @returns {vscode.Uri}
 */
const translateImage = (provider, imageUrl) => {
    const slashIndex = imageUrl.indexOf('/');
    const semiColonIndex = imageUrl.indexOf(";");
    const imageType = imageUrl.substring(slashIndex + 1, semiColonIndex);
    const imageBase64 = imageUrl.split(',')[1];
    const imageBuffer = Buffer.from(imageBase64, "base64");
    let filepath;

    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        filepath = getFilePath(getRandomString(6), imageType);
    } else {
        const mediaDirectory = vscode.Uri.joinPath(provider._extensionUri, "media");
        verifyDirectoryExists(mediaDirectory.fsPath);
        filepath = vscode.Uri.joinPath(mediaDirectory, `${getRandomString(6)}.${imageType}`).fsPath;
    }

    fs.writeFileSync(filepath, imageBuffer);
    const imageUri = vscode.Uri.file(filepath);
    const imageWebviewUri = provider._view.webview.asWebviewUri(imageUri);
    return imageWebviewUri;
}

/**
 * Parses the response for images, and adds them to the request.
 * @param {string} response - The response message.
 * @param {Array} messages - The messages array, showing the conversation.
 */
const parseResponseForImages = (response, messages) => {
    const imgRegEx = new RegExp("!\\[([^\\]]*)\\]\\(([^)]+)\\)", "g");
    let match;
    while ((match = imgRegEx.exec(response)) !== null) {
        const imageUri = match[2];
        const uri = vscode.Uri.parse(imageUri);
        try {
            const imageBase64 = fs.readFileSync(uri.fsPath, "base64");
            const lastPeriodIndex = uri.fsPath.lastIndexOf('.');
            const imageType = lastPeriodIndex != -1 ? uri.fsPath.substring(lastPeriodIndex + 1).toLowerCase() : 'png';
            addImageToMessage(messages, imageBase64, imageType, match[0]);
        } catch (e) { }
    }
}

/**
 * Sends a chat message to the LLM and handles the response.
 * @param {CodeNexusViewProvider} provider - The view provider instance.
 * @param {Array} messages - The messages array, showing the conversation.
 * @param {openai.OpenAI} openChat - The OpenAI client instance.
 * @param {string} chat - The user's chat message.
 * @param {number} index - The LLM model index.
 * @param {number} count - The retry count.
 * @param {string} originalQuestion - The original user question.
 * @param {string} additionalText - The additional text to add to the question, from `textFromFile`.
 * @param {Array} models - The available models.
 * @param {Array} names - The model names.
 * @returns {Promise<void>}
 */
const sendChat = async (provider, messages, openChat, chat, index, count, originalQuestion, additionalText, models, names) => {
    activePrograms.clear();
    const startTime = performance.now();
    const key = crypto.randomUUID();
    let sendMessage = true;
    currentResponse = "";

    try {
        const stream = await openChat.chat.completions.create({
            model: models[index],
            stream: true,
            messages
        });

        for await (const chunk of stream) {
            if (sendMessage) provider.postMessage('changeAsk', { value: true });
            sendMessage = false;
            if (!continueResponse) {
                stream.controller.abort();
                break;
            }
            let val = chunk.choices[0]?.delta?.content || "";
            if (chunk.choices[0]?.delta?.images) {
                for (const image of chunk.choices[0].delta.images) {
                    const imageUrl = image.image_url.url;
                    const imageWebiewUri = translateImage(provider, imageUrl);
                    val += `\n\n![Image](${imageWebiewUri})\n\n`;
                }
            }
            currentResponse += val;
            if (val.length > 0) writeToFile ? sendToFile(val, outputFileName) : await sendStream(provider, currentResponse, false, key);
        }

        if (currentResponse.length === 0 && continueResponse) throw new Error("Error: LLM has given no response!");

        continueResponse = true;
        let totalTime = `${(performance.now() - startTime) / 1000}`;
        totalTime = totalTime.substring(0, totalTime.indexOf('.') + 5);

        const runTime = `Call to ${names[index]} took ${totalTime} seconds.`;
        const totalResponse = `${currentResponse}\n\n**${runTime}**`;

        if (writeToFile) {
            const pathToFile = getFilePath(outputFileName, "md");
            const webviewResponse = `The response to your question has been completed at:\n\n **${pathToFile}**`;
            sendToFile(`\n\n**${runTime}**\n\n`, outputFileName);
            const html = await mdToHtml(webviewResponse);
            provider.postMessage("response", { text: html, value: true, key });
        } else {
            await sendStream(provider, totalResponse, true, key);
        }

        activePrograms.clear();
        questionHistory.push(chat);
        responseHistory.push(totalResponse);
        sessions[currentSession].chats.push({
            question: originalQuestion,
            response: totalResponse,
            snippet: additionalText,
            mode: agentMode,
            key
        })

    } catch (err) {
        // console.log(err);
        if (!continueResponse) {
            let totalTime = `${(performance.now() - startTime) / 1000}`;
            totalTime = totalTime.substring(0, totalTime.indexOf('.') + 5);
            const runTime = `Call to ${names[index]} took ${totalTime} seconds.`;
            writeToFile ? sendToFile(`**${runTime}**`, outputFileName) : await sendStream(provider, runTime, true, key);
            continueResponse = true;
            return;
        }
        if (count === models.length) {
            console.log("hit an error!");
            console.log(err.error);

            if (responseHistory.length < questionHistory.length) {
                responseHistory.push(err.message);
            }

            if (!writeToFile) provider.postMessage("error", { text: err.message, key: crypto.randomUUID() });
            else vscode.window.showErrorMessage("Error writing to chat: " + err.message);
        } else {
            index += 1;
            index %= models.length;
            vscode.window.showInformationMessage(`Switching to ${names[index]}...`);
            await sendChat(provider, messages, openChat, chat, index, count + 1, originalQuestion, additionalText, models, names);
        }
    }
};

/**
 * Activates the extension.
 * @param {vscore.ExtensionContext} context - The extension context.
 * @returns {Promise<void>}
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
            const correctData = data == undefined ? savedData : data;
            savedData = correctData;
            if (!provider._view) await vscode.commands.executeCommand('workbench.view.extension.codenexus-ai-view');
            provider.show();
            await provider.handleIncomingData(correctData.text, correctData.addition);
        } else {
            vscode.window.showWarningMessage("Chat view provider not available yet.");
        }
    })

    const openChatShortcut = vscode.commands.registerCommand('codenexus-ai.openChatWithSelection', async () => {
        const editor = vscode.window.activeTextEditor;
        const text = editor ? editor.document.getText(editor.selection) : "";
        await vscode.commands.executeCommand('codenexus-ai.chat.focus', { text, addition: false });
    });

    const addToChatSelection = vscode.commands.registerCommand('codenexus-ai.addToChatSelection', async () => {
        const editor = vscode.window.activeTextEditor;
        const text = editor ? editor.document.getText(editor.selection) : "";
        await vscode.commands.executeCommand('codenexus-ai.chat.focus', { text, addition: true })
    })

    vscode.workspace.onDidChangeConfiguration(async (event) => {
        if (event.affectsConfiguration("CodenexusAI")) {
            if (currentlyResponding) queuedChanges.push(["configUpdate", [event, provider]]);
            else await getConfigData(event, provider);
        }
    })

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CodeNexusViewProvider.viewType, provider),
        changeApiKeyCommand,
        openChatShortcut,
        addToChatSelection
    );

    fileTitles = await getAllFiles(include, exclude, defaultInclude, defaultExclude);

    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.*', false, true, false);
    const getFilesOnChange = () => {
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
     * @param {string} apiKey
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

    /**
     * Sends a message to the webview.
     * @param {string} command - The command to send.
     * @param {Object} [payload=null] - The payload data.
     */
    postMessage(command, payload = null) {
        if (!this._view || !this._view.webview) return;
        this._view.webview.postMessage({ command, ...payload })
    }

    /**
     * Handles incoming data to the webview.
     * @param {string} data - The incoming data.
     * @param {boolean} addition - If `data` should be added to `textFromFile`, or replace it.
     * @returns {Promise<void>}
     */
    async handleIncomingData(data, addition) {
        if (!data) {
            this.postMessage('focus');
            return;
        }

        let trimmed = data.replaceAll("\n", "").replaceAll(" ", "");
        if (trimmed.length > 0) {
            if (!textFromFile) textFromFile = data;
            else textFromFile = addition ? textFromFile + '\n\n' + data : data;
            updateSessionVariable("textFromFile", textFromFile);
            await new Promise(res => setTimeout(res, 500));
            await this.provideContent(textFromFile);
        }

        this.postMessage('focus');
    }

    /**
     * Updates the workspace path in the webview.
     */
    updateWorkspacePath() {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length == 0) return;
        this.postMessage('workspacePath', { value: vscode.workspace.workspaceFolders[0].uri.fsPath });
    }

    /**
     * Updates the file list in the webview.
     * @param {boolean} [updatePath=true] - Whether to update the workspace path.
     * @param {boolean} [fetchFiles=true] - Whether to re-fetch the files in the current directory.
     */
    updateFileList(updatePath=true, fetchFiles=true) {
        if (updatePath) this.updateWorkspacePath();
        if (fetchFiles) {
            getAllFiles(include, exclude, defaultInclude, defaultExclude)
                .then(newFiles => { fileTitles = newFiles; })
                .finally(() => { this.postMessage('fileTitles', { value: fileTitles }); })
        } else {
            this.postMessage('fileTitles', { value: fileTitles });
        }
    }

    /**
     * Updates page values in the webview.
     */
    updatePageValues() {
        const sessionTitles = {};
        for (const key of Object.keys(sessions)) {
            sessionTitles[key] = sessions[key].title; 
        }
        this.postMessage('canDelete', { text: currentSession, value: !currentlyResponding });
        this.postMessage('updateValues', { value: [writeToFile, agentMode, llmIndex, fileHistory.capacity, outputFileName, sessionTitles, currentSession, attachments] });
        this.postMessage("promptValue", { text: promptValue, value: currentMentionedFiles });
        this.postMessage('fileContext', { value: Array.from(fileHistory.cache) });
    }

    /**
     * Shows loading spinner in the webview.
     */
    loading() {
        this.postMessage("loading", { text: this._getSpinner() });
    }

    /**
     * Generates the headers for the code blocks.
     */
    generateHeaders() {
        this.postMessage('generateHeaders', { value: runnablePrograms });
    }

    /**
     * Provides additional content to the question.
     * @param {string} text - The text to add to the question.
     */
    async provideContent(text) {
        if (text.length == 0) {
            this.postMessage('content', { text });
        } else {
            let htmlText = await mdToHtml("````\n" + text + "\n````");
            this.postMessage('content', { text: htmlText });
        }
    }

    /**
     * Shows the webview.
     */
    show() {
        if (this._view) {
            this._view.show();
        } else {
            vscode.commands.executeCommand('codenexus-ai.chat.focus');
        }
    }

    /**
     * Updates the HTML content of the webview.
     * @param {boolean} showSidebar - Boolean indicating if the sidebar should be in view.
     * @returns {Promise<void>}
     */
    async updateHTML(showSidebar) {
        if (!this._view || !this._view.webview) return;
        this._view.webview.html = await this._getHtmlForWebview(showSidebar);
        this.inProgress();
        this.updateWorkspacePath();
        this.updateFileList(false, false);
        this.updatePageValues();
        this.generateHeaders();
        await this.provideContent(textFromFile);
        this.postMessage('focus');
    }

    /**
     * Shows in-progress state in the webview.
     */
    inProgress() {
        if (currentlyResponding) {
            const question = currentQuestionObj.question;
            const snippet = currentQuestionObj.snippet || "";
            this.postMessage("chat", { text: question, value: snippet });
            this.postMessage("loading", { text: this._getSpinner() });
            this.postMessage("changeAsk", { value: true });
        }
    }

    /**
     * Gets the local resource roots, and resolves any missing paths.
     * @returns {Array<vscode.Uri>}
     */
    getLocalResourceRoots() {
        const resourceRoots = [];
        const mediaPath = vscode.Uri.joinPath(this._extensionUri, "media").fsPath;
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            resourceRoots.push(vscode.Uri.file(vscode.workspace.workspaceFolders[0].uri.fsPath));
        }

        try {
            verifyDirectoryExists(mediaPath);
            resourceRoots.push(vscode.Uri.file(mediaPath));
        } catch (e) {
            console.log(e);
        }

        return resourceRoots;
    }

    /**
     * Resolves the webview view.
     * @param {vscode.WebviewView} webviewView - The webview view.
     * @param {vscode.CancellationToken} _token - The cancellation token.
     * @returns {Promise<void>}
     */
    async resolveWebviewView(webviewView, _token) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri,
                ...this.getLocalResourceRoots()
            ]
        };

        webviewView.webview.html = await this._getHtmlForWebview();
        this.postMessage("configUpdate", { key: 'fileSize', value: fileHistory.capacity });
        this.postMessage('focus');
        this.updateFileList(true, false);

        webviewView.onDidChangeVisibility(async () => {
            if (webviewView.visible) {
                if (this.interactions != sessions[currentSession].chats.length) {
                    webviewView.webview.html = await this._getHtmlForWebview();
                    this.interactions = sessions[currentSession].chats.length;
                }
                this.inProgress();
                this.updateWorkspacePath();
                this.updateFileList(false, false);
                this.updatePageValues();
                this.generateHeaders();
                await this.provideContent(textFromFile);
                this.postMessage('focus');
            } else {
                webviewView.webview.html = webviewView.webview.html.replace("sidebar-visible", "sidebar-hidden");
            }
        });

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.command === "chat") {
                const numOfModels = ollama ? ollamaModels.length : openRouterModels.length;
                if (currentlyResponding) return;
                if (llmIndex >= numOfModels || llmIndex < 0) {
                    if (numOfModels > 0) {
                        llmIndex = 0;
                        return;
                    }
                    const provider = ollama ? 'Ollama' : 'OpenRouter';
                    await vscode.window.showErrorMessage(`No available models for ${provider}. Add LLMs using the 'Settings' icon on the webview.`);
                    return;
                }

                updateSessionVariable("llmIndex", llmIndex);
                this.postMessage('disableAsk');
                currentlyResponding = true;
                currentQuestionObj = {
                    question: message.text,
                    snippet: sessions[currentSession].textFromFile
                }

                promptValue = "";
                currentMentionedFiles = {};

                updateSessionVariable("prompt", "");
                updateSessionVariable("mentionedFiles", {});

                let userQuestion = message.text;
                userQuestions.push(userQuestion);
                questionHistory.push(userQuestion);
                writeToFile = message.writeToFile;
                outputFileName = message.outputFile ? message.outputFile : "output";

                updateSessionVariable("writeToFile", message.writeToFile);
                updateSessionVariable("outputFileName", outputFileName)

                if (sessions[currentSession].title == "New Chat") {
                    setSessionTitle(sessions[currentSession], userQuestion);
                    this.postMessage("updateTitle", { text: currentSession, value: sessions[currentSession].title });
                }

                this.postMessage('canDelete', { text: currentSession, value: false });
                this.postMessage('chat', { text: userQuestion, value: textFromFile });
                if (writeToFile) sendToFile("**" + userQuestion + "**\n\n", outputFileName);

                let text = message.text;
                for (const [index, info] of Object.entries(message.mentionedFiles)) {
                    const [file, location] = info;
                    fileHistory.put(location, file);
                    locationOfMentionedFiles.push(location);
                    text = replaceFileMentions(text, ["@" + file]);
                }

                updateSessionVariable("fileHistory", fileHistory);

                this.loading();
                this.postMessage('content', { text: '' });
                const messages = await generateMessages(message.text, textFromFile);
                this.postMessage('fileContext', { value: Array.from(fileHistory.cache) });

                const additionalContent = sessions[currentSession].textFromFile;
                textFromFile = "";
                updateSessionVariable("textFromFile", "");
                
                if (ollama) await sendChat(this, messages, this.ollamaChat, text, llmIndex, 0, userQuestion, additionalContent, ollamaModels, ollamaNames)
                else await sendChat(this, messages, this.openChat, text, llmIndex, 0, userQuestion, additionalContent, openRouterModels, openRouterNames);
                this.postMessage('changeAsk', { value: false });
                this.postMessage('canDelete', { text: currentSession, value: true });

                await updateQueuedChanges();
                currentlyResponding = false;
                currentQuestionObj = {};
                lastCalled = 0;
            } else if (message.command === 'copy') {
                await vscode.env.clipboard.writeText(message.text);
            } else if (message.command === "selectLLM") {
                llmIndex = parseInt(message.index);
                updateSessionVariable("llmIndex", llmIndex);
            } else if (message.command === 'remove') {
                textFromFile = "";
                updateSessionVariable("textFromFile", "");
            } else if (message.command === 'clearHistory') {
                this.postMessage('history', { value: currentlyResponding });
                updateSessionVariable("chats", []);
                if (currentlyResponding) {
                    const programKeys = [...Object.keys(runnablePrograms)];
                    for (const key of programKeys) {
                        if (activePrograms.has(key)) continue;
                        delete runnablePrograms[key];
                    }
                } else {
                    runnablePrograms = {};
                }
            } else if (message.command === 'stopResponse') {
                continueResponse = false;
                this.postMessage('changeAsk', { value: false });
            } else if (message.command === 'outputToFile') {
                if (currentlyResponding) queuedChanges.push([message.command, message.checked]);
                else {
                    writeToFile = message.checked;
                    updateSessionVariable("writeToFile", writeToFile);
                }
            } else if (message.command === 'fileContext') {
                fileHistory.delete(message.key);
                updateSessionVariable("fileHistory", fileHistory);
            } else if (message.command === 'runProgram') {
                const file = runnablePrograms[message.key];
                if (!file) return;
                delete runnablePrograms[message.key]
                await runPythonFile(file);
            } else if (message.command === 'changeMode') {
                if (currentlyResponding) queuedChanges.push([message.command, message.value]);
                else {
                    agentMode = message.value == 'false' ? false : true;
                    updateSessionVariable("agentMode", agentMode);
                }
            } else if (message.command === 'updatePrompt') {
                updateSessionVariable("prompt", message.value);
                updateSessionVariable("mentionedFiles", message.files);
                promptValue = message.value;
                currentMentionedFiles = message.files;
            } else if (message.command === 'deleteEntry') {
                const index = sessions[currentSession].chats.findIndex((val) => val.key == message.key);
                const programKeys = [...Object.keys(runnablePrograms)];
                for (const key of programKeys) {
                    const [chatKey, _] = key.split(" / ");
                    if (chatKey == message.key) delete runnablePrograms[key];
                }
                if (index == -1) return;
                sessions[currentSession].chats.splice(index, 1);
                this.interactions = sessions[currentSession].chats.length - 1;
            } else if (message.command === 'openSettings') {
                await vscode.commands.executeCommand("workbench.action.openSettings", "CodenexusAI")
            } else if (message.command === 'refreshFiles') {
                this.updateFileList();
            } else if (message.command === 'updateApiKey') {
                await vscode.commands.executeCommand('codenexus-ai.changeApiKey');
            } else if (message.command === 'copyResponse') {
                const chatEntry = sessions[currentSession].chats.find((val) => val.key == message.key);
                if (chatEntry === undefined) return;
                await vscode.env.clipboard.writeText(chatEntry.response);
            } else if (message.command === 'mediaFolder') {
                const mediaDirectory = vscode.Uri.joinPath(this._extensionUri, "media");
                verifyDirectoryExists(mediaDirectory.fsPath);
                await vscode.env.openExternal(mediaDirectory);
            } else if (message.command === 'openFile') {
                try {
                    const uri = vscode.Uri.file(message.location);
                    await vscode.window.showTextDocument(uri);
                } catch (e) {
                    let message = e.message;
                    if (e.name === "CodeExpectedError") {
                        const startIndex = e.message.indexOf("Error:");
                        message = e.message.substring(startIndex, e.message.length - 1);
                    }
                    await vscode.window.showErrorMessage(message || `Error opening file: ${message.location}`);
                }
            } else if (message.command === 'newSession') {
                if (currentlyResponding) return;
                const newSession = initializeNewSession(sessions, lruSize);
                setGlobalVariables(newSession);
                currentSession = newSession;
                await this.updateHTML(false);
            } else if (message.command === 'changeSession') {
                if (currentlyResponding) return;
                const sessionId = message.id;
                setGlobalVariables(sessionId);
                currentSession = sessionId;
                await this.updateHTML(true);
            } else if (message.command === 'deleteSession') {
                const numOfSessions = Object.keys(sessions).length;
                const deleteId = message.id;
                if (currentlyResponding && deleteId == currentSession) return;
                if (numOfSessions == 1) {
                    delete sessions[deleteId];
                    const newSession = initializeNewSession(sessions, lruSize);
                    setGlobalVariables(newSession);
                    currentSession = newSession;
                    await this.updateHTML(false);
                } else {
                    delete sessions[deleteId];
                    if (currentSession == deleteId) {
                        const sessionIds = Object.keys(sessions);
                        setGlobalVariables(sessionIds[0]);
                        currentSession = sessionIds[0];
                        await this.updateHTML(true);
                    }
                }
            } else if (message.command === "attachments") {
                let newFiles = message.files ? message.files : [];
                attachments = newFiles;
                updateSessionVariable("files", newFiles);
            }
        });
    }

    /**
     * Gets the loading spinner HTML.
     * @returns {string} The spinner HTML.
     */
    _getSpinner() {
        const cssFile = this._view.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "spinner.css"));
        return /*html*/`
            <link rel="stylesheet" href="${cssFile}">
            <div id="container"><div id="spinner"></div></div>
        `;
    }

    /**
     * Gets the HTML for the webview.
     * @param {boolean} [showSidebar=false] - Boolean indicating if the sidebar should be visible.
     * @returns {Promise<string>} The webview HTML.
     */
    async _getHtmlForWebview(showSidebar=false) {
        let names = ollama ? ollamaNames : openRouterNames;
        let optionsHtml = '';
        for (let i = 0; i < names.length; i++) {
            optionsHtml += `<option value="${i}" ${i === llmIndex ? 'selected' : ''}>${names[i]}</option>`;
        }

        let chatHistoryHtml = '';
        for (let i = 0; i < sessions[currentSession].chats.length; i++) {
            const item = sessions[currentSession].chats[i];
            const response = await mdToHtml(item.response.replaceAll(token, ""));
            let snippetHtml = '';

            if (item.snippet && item.snippet.trim() !== '') {
                const sanitizedSnippet = sanitizeString(item.snippet);
                snippetHtml = `
                    <br><br>
                    <details class="snippet-dropdown">
                        <summary class="snippet-button">View Snippet</summary>
                        <div class="snippet-content">
                            <pre><code>${sanitizedSnippet}</code></pre>
                        </div>
                    </details>
                `;
            }

            chatHistoryHtml += `
                <div class="chat-entry" id="${item.key}">
                    <div class="question"><strong>
                        You:</strong> ${highlightFilenameMentions(item.question, fileTitles)}
                        ${snippetHtml}
                    </div>
                    <div class="response">
                        ${response}
                    </div>
                </div>
            `;
        }

        let sessionsHTML = '';
        const sessionKeys = Object.keys(sessions).sort((a, b) => Number(b) - Number(a));

        for (const key of sessionKeys) {
            const session = sessions[key];
            const isActive = key == currentSession;
            const title = sanitizeString(session.title);

            sessionsHTML += `
                <div class="session-item ${isActive ? 'active' : ''}" data-session-id="${key}" title="${title}">
                    <span class="session-title">${title}</span>
                    <button class="session-switch all-sessions" id="${key}" style="display: none;"></button>
                    <button class="session-delete options" data-session-id="${key}" title="Delete Session">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </div>
            `;
        }

        const jsFile = this._view.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "webview.js"));
        const cssFile = this._view.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "styles.css"));
        const nonce = getRandomString(32);
        const disableOutput = !vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length == 0;
        const placeholder = `Type your message here, with @file.ext to mention files (max ${fileHistory.capacity}), and using tab to select the correct one...`

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
            <title>CodeNexus</title>
        </head>
        <body class="${showSidebar ? 'sidebar-visible' : 'sidebar-hidden'}"> 
            <div id="app-container">
                
                <div id="session-panel">
                    <div class="session-panel-header">
                        <button id="new-sessions" class="button-styling ask-chat">
                            <i class="fas fa-plus"></i> New Chat
                        </button>
                    </div>
                    <div id="session-list">
                        ${sessionsHTML}
                    </div>
                </div>

                <div id="chat-container">
                    <div id="input-area">
                        <div id="context-files"></div>
                        
                        <textarea id="prompt" rows="3" placeholder="${placeholder}"></textarea>
                        <div tabindex='-1' id="file-options"></div>
                        <details id="files-dropdown">
                            <summary id="files-dropdown-button" class="snippet-button">Files</summary>
                            <div id="preview-container"></div>
                        </details>
                        
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
                            
                            <label for="file-input" id="file-label" class="options" title="Add Files">
                                <i class="fas fa-file-circle-plus"></i>
                            </label>
                            <input type="file" multiple accept="image/*" id="file-input">
                            <button title="Chat Sessions" class="options" id="toggle-sidebar-btn"><i class="fa-regular fa-pen-to-square"></i></button>
                            <button title="Clear History" class="options" id="clear-history"><i class="fas fa-solid fa-trash-can icon"></i></button>
                            <button title="Refresh Files" class="options" id="refresh-files"><i class="fas fa-solid fa-sync-alt icon"></i></button>
                            <button title="Open Media Folder" class="options" id="media-folder"><i class="fa-solid fa-images icon"></i></button>
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