const vscode = require('vscode');
const openai = require('openai');
const showdown = require('showdown');
const { performance } = require("perf_hooks");

const userQuestions = [];
const questionHistory = [];
const responseHistory = [];
let textFromFile = "";
let llmIndex = 0;

const converter = new showdown.Converter();

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

    const updateOpenAIClient = (apiKey) => {
        openChat = new openai.OpenAI({
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: apiKey
        })
    }

    const disposable = vscode.commands.registerCommand('ai-chat.chat', async function () {
        const panel = vscode.window.createWebviewPanel("ai", "AI Chat", vscode.ViewColumn.Two, { enableScripts: true });
        panel.webview.html = getWebviewContent(llmIndex, userQuestions, responseHistory);

        const sendStream = (stream, addition) => {
            panel.webview.postMessage({ command: "response", text: converter.makeHtml(stream), file: null });
        }

        const loading = () => {
            panel.webview.postMessage({ command: "loading", text: getSpinner(), file: null });
        }

        const sendChat = async (chat, index, count) => {
            const startTime = performance.now();
            let fullResponse = "";

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
                    fullResponse += val;
                    if (val.length > 0) sendStream(fullResponse, fullResponse.length == val.length);
                }

                const endTime = performance.now();
                const runTime = `Call to ${llmNames[index]} took ${(endTime - startTime) / 1000} seconds.`;
                const totalResponse = `${fullResponse}\n\n**${runTime}**`
                sendStream(totalResponse);
                questionHistory.push(chat);
                responseHistory.push(fullResponse);

            } catch (err) {
                if (count === llms.length) {
                    console.log("hit an error!");
                    console.log(err.error);
                    panel.webview.postMessage({ command: "error", text: err.message, file: null, question: chat });
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
                userQuestions.push(userQuestion);
                panel.webview.postMessage({ command: 'chat', text: userQuestion });

                let text = message.text;
                let regEx = new RegExp("@[a-zA-Z]+\\.[a-zA-Z]+", "g");
                let matches = text.match(regEx);

                let resp = getOpenFiles(vscode.workspace.textDocuments);
                let fileTexts = resp.texts;
                let fileTitles = resp.titles;

                if (message.context) {
                    let locations = responseHistory.at(-1).split("\n");
                    let file = getLocationFromResponse(text, locations);
                    textFromFile += addFileToQuestion(message.file, file, fileTexts) + "\n";
                    text = replaceFileMentions(questionHistory.at(-1), ["@" + message.file]);
                    matches = text.match(regEx);
                } else {
                    textFromFile = "";
                }

                let mentioned = getMentionedFiles(matches, fileTitles, fileTexts);
                text = replaceFileMentions(text, mentioned.fulfilled);

                if (!mentioned.clearance) {
                    questionHistory.push(userQuestion);
                    responseHistory.push(mentioned.response);
                    panel.webview.postMessage(
                        {
                            command: "selection",
                            text: mentioned.response,
                            file: mentioned.match,
                            maxVal: fileTitles[mentioned.match].length
                        });
                    return;
                }
                textFromFile += mentioned.response + "\n";
                let question = `${text}\n\n${textFromFile}`;
                loading();
                await sendChat(question, llmIndex, 0);
            } else if (message.command === 'copy') {
                vscode.env.clipboard.writeText(message.text);
            } else if (message.command == "selectLLM") {
                llmIndex = message.index;
            }
        })
        panel.onDidDispose(() => {
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

const addFileToQuestion = (file, location, texts) => {
    return file + ":\n" + texts[location];
}

const getMentionedFiles = (matches, titles, texts) => {
    if (matches == null) return { response: "", clearance: true, match: null, fulfilled: [] };
    let clearance = true;
    let response = "";
    let lastFile = null;
    let fulfilled = [];

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
                response += fileName + ":\n" + texts[loc];
                fulfilled.push(match);
            }

            if (!clearance) break;
        }
    }

    return { response, clearance, fulfilled, match: lastFile };
}

const getOpenFiles = (documents) => {
    let fileTexts = {};
    let fileTitles = {};

    for (let i = 0; i < documents.length; i++) {
        let file = documents[i];
        if (file.fileName.startsWith("git") || file.fileName.includes(".git")) continue;
        let titleRegEx = new RegExp("\\\\[a-zA-Z]+\\.[a-zA-Z]+");
        let realTitle = file.fileName.match(titleRegEx);
        if (!realTitle) continue;

        for (let title of realTitle) {
            title = title.substring(1);
            if (title in fileTitles) fileTitles[title].push(file.fileName);
            else fileTitles[title] = [file.fileName];
        }

        fileTexts[file.fileName] = file.getText();
    }

    return { texts: fileTexts, titles: fileTitles }
}

const getWebviewContent = (selectedLLMIndex, questionHistory, responseHistory) => {
    let optionsHtml = '';
    for (let i = 0; i < llmNames.length; i++) {
        optionsHtml += `<option value="${i}" ${i === selectedLLMIndex ? 'selected' : ''}>${llmNames[i]}</option>`;
    }

    let chatHistoryHtml = '';
    for (let i = 0; i < questionHistory.length; i++) {
        chatHistoryHtml += `
            <div class="chat-entry">
                <div class="question"><strong>You:</strong> ${questionHistory[i]}</div>
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
        <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
        <title>AI Chat</title>
        <style>
            body, html {
                margin: 0;
                padding: 0;
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                font-family: var(--vscode-font-family);
                font-size: var(--vscode-font-size);
                font-weight: var(--vscode-font-weight);
                overflow-y: scroll;
            }
            .chat-entry {
                margin-bottom: 10px;
                border-bottom: 1px solid var(--vscode-editor-foreground);
                padding-bottom: 5px;
            }
            .question, .response {
                padding: 5px;
                margin-bottom: 2px;
            }
            .question {
                background-color: var(--vscode-editor-selectionBackground);

            }
            .response {
               background-color: var(--vscode-editor-background);
            }
            #prompt {
                width: 100%;
                box-sizing: border-box;
                border: 1px solid var(--vscode-input-border);
                background-color: var(--vscode-input-background);
                color: #f0e68c;
                padding: 5px;
                margin-bottom: 10px;
                resize:vertical;
                font-family: var(--vscode-font-family);
            }
            #prompt:focus {
              outline: none;
              border-color: var(--vscode-focusBorder);
            }
            #llmDropdown {
                margin-bottom: 10px;
            }
             #llmSelect {
                background-color: var(--vscode-dropdown-background);
                color: var(--vscode-dropdown-foreground);
                border: 1px solid var(--vscode-dropdown-border);
                padding: 2px;
                font-family: var(--vscode-font-family);

            }
            #ask {
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 5px 10px;
                cursor: pointer;
            }
             #ask:hover {
                background-color: var(--vscode-button-hoverBackground);
            }
            #chat-history {
                margin-bottom: 15px;
                overflow-y: auto;
            }
            #chat-container {
                display: flex;
                flex-direction: column;
                height: calc(100vh - 20px);

            }
            #input-area{
                padding: 10px;
            }
            .copy-button {
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 2px 5px;
                cursor: pointer;
                font-size: var(--vscode-font-size);
           }
           .copy-button:hover {
                background-color: var(--vscode-button-hoverBackground);
           }
           pre code.hljs {
                position: relative;
                display: block;
                padding: 1em;
            }
            .code-container {
                position: relative;
                display: block;
            }

        </style>
        <script>
            hljs.highlightAll();
        </script>
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
                <button id="ask">Ask</button>
            </div>
            <div id="chat-history">
                ${chatHistoryHtml}
            </div>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            const button = document.getElementById("ask");
            const prompt = document.getElementById("prompt");
            const responseArea = document.getElementById("chat-history");
            const llmSelect = document.getElementById("llmSelect");

            let prevCommand = null;
            let prevFile = null;
            let maximumVal = 0;

            prompt.focus();

            llmSelect.addEventListener('change', () => {
                const selectedIndex = llmSelect.value;
                vscode.postMessage({ command: 'selectLLM', index: selectedIndex });
            });

            const validateInput = (n) => {
                let invalid = new RegExp("[0-9]", "g");
                let valid = "";
                let curPos;

                while ((curPos = invalid.exec(n)) != null) {
                    if (valid.length == 0 && curPos[0] == '0') {
                        continue;
                    } else {
                        let tempVal = valid + curPos[0];
                        if (parseInt(tempVal) <= maximumVal) {
                            valid = tempVal;
                        }
                    }
                }

                return valid;
            }

            const isNumber = (e) => {
                e.target.value = validateInput(e.target.value);
            }
            const activateNumbers = () => {
                prompt.addEventListener("input", isNumber)
            }
            const disableNumbers = () => {
                prompt.removeEventListener("input", isNumber)
            }

            const addCopyButtons = () => {
                document.querySelectorAll('pre code.hljs').forEach((codeBlock) => {
                    const container = document.createElement('div');
                    container.classList.add('code-container');
                    container.style.position = 'relative';
                    codeBlock.parentNode.insertBefore(container, codeBlock);
                    container.appendChild(codeBlock);

                    const button = document.createElement('button');
                    button.innerText = 'Copy';
                    button.classList.add('copy-button');
                    button.style.position = 'absolute';
                    button.style.top = '5px';
                    button.style.right = '5px';
                    button.onclick = () => {
                        const codeToCopy = codeBlock.textContent;
                        vscode.postMessage({ command: 'copy', text: codeToCopy });
                        button.innerText = 'Copied!';
                        setTimeout(() => button.innerText = 'Copy', 2000);
                    };
                    container.appendChild(button);
                });
            };
            const highlightCode = () => {
                hljs.highlightAll();
                addCopyButtons();
            }

            const appendToChat = (question, responseText) => {
                const chatEntry = document.createElement('div');
                chatEntry.classList.add('chat-entry');

                if (question.length > 0) {
                    const questionDiv = document.createElement('div');
                    questionDiv.classList.add('question');
                    questionDiv.innerHTML = \`<strong>You:</strong> \${question}\`;
                    chatEntry.appendChild(questionDiv);
                }

                const responseDiv = document.createElement('div');
                responseDiv.classList.add('response');
                responseDiv.innerHTML = responseText;
                chatEntry.appendChild(responseDiv);

                responseArea.appendChild(chatEntry);
                responseArea.scrollTop = responseArea.scrollHeight;
                highlightCode();
            }

            prompt.addEventListener("keydown", (event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    button.click();
                }
            });

            button.addEventListener("click", () => {
                const text = prompt.value;
                if (text.length == 0) return;
                prompt.value = "";
                disableNumbers();
                vscode.postMessage({ command: 'chat', text: text, context: prevCommand == "selection", file: prevFile });
            })

           window.addEventListener("message", (e) => {
                const { command, text, file, maxVal, question} = e.data;
                prevCommand = command;
                prevFile = file;
                maximumVal = maxVal || 0;

                if (command === "response") {
                    if (responseArea.lastElementChild) {
                        responseArea.lastElementChild.querySelector('.response').innerHTML = text;
                          highlightCode();
                    }
                } else if (command === "selection") {
                    activateNumbers();
                    responseArea.lastElementChild.querySelector('.response').innerText = text;
                } else if (command === "loading") {
                    responseArea.lastElementChild.querySelector('.response').innerHTML = text;
                    highlightCode();
                } else if (command === "error") {
                    responseArea.lastElementChild.querySelector('.response').innerText = text;
                    highlightCode();
                } else if (command == 'chat') {
                    appendToChat(text, "");
                }
            })

        </script>
      </body>
    </html>
    `
}

const getSpinner = () => {
    return /*html*/`
    <div style="
        display: flex;
        justify-content: center;
        align-items: center;
        width: 100%;
        height: 50px; /* Adjusted height */
    ">
        <div style="
            border: 4px solid rgba(0, 0, 0, 0.1); /* Light grey border */
            border-top: 4px solid #3498db; /* Blue border-top */
            border-radius: 50%;
            width: 20px; /* Smaller width */
            height: 20px; /* Smaller height */
            animation: spin 1s linear infinite;
        "></div>
    </div>
    <style>
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>
    `;
};

// This method is called when your extension is deactivated
function deactivate() { }

module.exports = {
    activate,
    deactivate
}