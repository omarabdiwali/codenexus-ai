const vscode = acquireVsCodeApi();
const ask = document.getElementById("ask");
const prompt = document.getElementById("prompt");
const responseArea = document.getElementById("chat-history");
const llmSelect = document.getElementById("llmSelect");
const writeToFileCheckbox = document.getElementById("writeToFileCheckbox");
const outputFileNameInput = document.getElementById("outputFileNameInput");
const mentionedCode = document.getElementById("content");

let prevCommand = null;
let prevFile = null;
let maximumVal = 0;

const highlightFilenameMentions = (text) => {
    const regEx = new RegExp("\\B\\@[\\[\\]a-zA-Z]+\\.[a-zA-Z]+", "g");
    return text.replace(regEx, (match) => {
        return "<code>" + match + "</code>";
    });
};

const getButtonContainer = (codeBlock, type) => {
    const container = document.createElement('div');
    container.classList.add('code-container');
    container.style.position = 'relative';
    codeBlock.parentNode.insertBefore(container, codeBlock);
    container.appendChild(codeBlock);

    const button = document.createElement('button');
    button.innerText = type;
    button.classList.add(type == 'Copy' ? 'copy-button' : 'cancel-button');
    button.style.position = 'absolute';
    button.style.top = '5px';
    button.style.right = '5px';
    button.onclick = () => {
        if (type == 'Copy') {
            const codeToCopy = codeBlock.textContent;
            vscode.postMessage({ command: 'copy', text: codeToCopy });
            button.innerText = 'Copied!';
            setTimeout(() => button.innerText = 'Copy', 2000);
        }
    };

    return { container, button };
};

const addCopyButtons = () => {
    document.querySelectorAll("#chat-history pre code").forEach((codeBlock) => {
        const { container, button } = getButtonContainer(codeBlock, 'Copy');
        container.appendChild(button);
    });
};

const addCancelButtons = () => {
    document.querySelectorAll("#content pre code").forEach(codeBlock => {
        const { container, button } = getButtonContainer(codeBlock, 'Cancel');
        container.appendChild(button);
    })
}

const highlightCode = () => {
    hljs.highlightAll();
    addCopyButtons();
    // addCancelButtons();
};

highlightCode();

llmSelect.addEventListener('change', () => {
    const selectedIndex = llmSelect.value;
    vscode.postMessage({ command: 'selectLLM', index: selectedIndex });
});

outputFileNameInput.addEventListener("input", (e) => {
    let val = e.target.value;
    let filteredValue = val.replace(/[^a-zA-Z0-9]/g, '');
    e.target.value = filteredValue;
})

const handleDisable = (e) => {
    e.preventDefault();
    outputFileNameInput.disabled = !writeToFileCheckbox.checked;
};

writeToFileCheckbox.addEventListener('change', handleDisable);

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

const appendToChat = (question, responseText) => {
    const chatEntry = document.createElement('div');
    chatEntry.classList.add('chat-entry');

    if (question.length > 0) {
        const questionDiv = document.createElement('div');
        questionDiv.classList.add('question');
        questionDiv.innerHTML = '<strong>You: </strong>' + highlightFilenameMentions(question);
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
        ask.click();
    }
})

prompt.addEventListener("input", (event) => {
    if (prevCommand == "selection") {
        event.preventDefault();
        prompt.value = validateInput(prompt.value);
    }
});

ask.addEventListener("click", () => {
    const text = prompt.value.trim();
    const context = prevCommand == "selection";
    if (text.length == 0) return;
    prompt.value = "";
    vscode.postMessage({ command: 'chat', text, context, file: prevFile, writeToFile: writeToFileCheckbox.checked, outputFile: outputFileNameInput.value });
});

window.addEventListener("message", (e) => {
    const { command, text, file, maxVal, question, final } = e.data;
    prevCommand = command;
    prevFile = file;
    maximumVal = parseInt(maxVal) || 0;

    if (command === "response") {
        responseArea.lastElementChild.querySelector('.response').innerHTML = text;
        highlightCode();
    } else if (command === "selection") {
        responseArea.lastElementChild.querySelector('.response').innerText = text;
    } else if (command === "loading") {
        responseArea.lastElementChild.querySelector('.response').innerHTML = text;
    } else if (command === "error") {
        responseArea.lastElementChild.querySelector('.response').innerText = text;
    } else if (command == 'chat') {
        appendToChat(text, "");
    } else if (command == 'focus') {
        prompt.focus();
    } else if (command == 'content') {
        content.innerHTML = text;
        hljs.highlightAll();
    }
});