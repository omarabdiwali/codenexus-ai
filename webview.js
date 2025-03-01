const vscode = acquireVsCodeApi();
const button = document.getElementById("ask");
const prompt = document.getElementById("prompt");
const responseArea = document.getElementById("chat-history");
const llmSelect = document.getElementById("llmSelect");
const writeToFileCheckbox = document.getElementById("writeToFileCheckbox");
const outputFileNameInput = document.getElementById("outputFileNameInput");

prompt.focus();

let prevCommand = null;
let prevFile = null;
let maximumVal = 0;

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

const highlightFilenameMentions = (text) => {
    const regEx = new RegExp("\\B\\@[a-zA-Z]+\\.[a-zA-Z]+", "g");
    return text.replace(regEx, (match) => {
        return `<code>${match}</code>`;
    });
};

const updatePromptWithHighlighting = () => {
    const rawText = prompt.innerText;
    const highlightedText = highlightFilenameMentions(rawText);
    prompt.innerHTML = highlightedText;
    setCaretAtEnd(prompt);
};

const setCaretAtEnd = (element) => {
    const range = document.createRange();
    const selection = window.getSelection();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
};

prompt.addEventListener("input", (e) => {
    if (prevCommand == "selection") {
        prompt.innerText = validateInput(prompt.innerText);
        setCaretAtEnd(prompt);
    } else {
        updatePromptWithHighlighting();
    }
});

prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        button.click();
    } else if (event.key === "Enter" && event.shiftKey) {
        document.execCommand('insertLineBreak');
        event.preventDefault();
    }
});

const getButtonContainer = (codeBlock) => {
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

    return { container, button };
};

const addCopyButtons = () => {
    document.querySelectorAll("pre code").forEach((codeBlock) => {
        const { container, button } = getButtonContainer(codeBlock);
        container.appendChild(button);
    });
};

const highlightCode = () => {
    hljs.highlightAll();
    addCopyButtons();
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
};

button.addEventListener("click", () => {
    const text = prompt.innerText.trim();
    const context = prevCommand == "selection";
    if (text.length == 0) return;
    prompt.innerText = "";
    vscode.postMessage({ command: 'chat', text, context, file: prevFile, writeToFile: writeToFileCheckbox.checked, outputFile: outputFileNameInput.value });
});

window.addEventListener("message", (e) => {
    const { command, text, file, maxVal, question } = e.data;
    prevCommand = command;
    prevFile = file;
    maximumVal = maxVal || 0;

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
    }
});