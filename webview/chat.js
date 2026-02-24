/**
 * Appends a new user question to chat history, and creates a div for the response.
 * @param {string} question - The user's question.
 * @param {string} codeSnippet - The user's additional code snippet.
 */
const appendToChat = (question, codeSnippet) => {
    const chatEntry = document.createElement('div');
    chatEntry.classList.add('chat-entry');

    let snippetHtml = '';

    if (codeSnippet && codeSnippet.trim() !== '') {
        const sanitizedSnippet = sanitizeString(codeSnippet);

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

    const questionDiv = document.createElement('div');
    questionDiv.classList.add('question');
    questionDiv.innerHTML = '<strong>You: </strong>' + formatUserQuestion(question) + snippetHtml;
    chatEntry.appendChild(questionDiv);

    const responseDiv = document.createElement('div');
    responseDiv.classList.add('response');
    responseDiv.innerHTML = "";

    chatEntry.appendChild(responseDiv);
    responseArea.appendChild(chatEntry);
    responseArea.scrollTop = responseArea.scrollHeight;
}

/**
 * Verifies '@mentioned' files exist in workspace before sending.
 * @param {string} value - The question value to check.
 */
const verifyMentionedFiles = (value) => {
    let match;
    let verified = {};

    while ((match = regEx.exec(value)) != null) {
        const key = match.index;
        const filename = match[0].substring(1);
        if (key in mentionedFiles && mentionedFiles[key][0] == filename) {
            verified[key] = mentionedFiles[key];
        } else if (filename in fileTitlesWithLocations) {
            verified[key] = [filename, fileTitlesWithLocations[filename][0]];
        }
    }

    mentionedFiles = verified;
}

/**
 * Finds boundaries of current word at cursor position.
 * @param {string} value - The text value.
 * @param {number} start - The cursor start position.
 * @returns {Array<number>} The start and end indexes of the word.
 */
const startAndEndIndexForCursorWord = (value, start) => {
    let startIndex = value.substring(0, start).lastIndexOf(' ');
    let endIndex = value.substring(start).indexOf(' ');
    startIndex = startIndex == -1 ? 0 : startIndex + 1;
    endIndex = endIndex == -1 ? value.length : endIndex + start;
    return [startIndex, endIndex];
}

/**
 * Gets word at current cursor position.
 * @param {string} value - The text value.
 * @param {number} start - The cursor start position.
 * @returns {string} The word at the cursor position.
 */
const findCurrentCursorWord = (value, start) => {
    lastCursorPosition = start;
    const [startIndex, endIndex] = startAndEndIndexForCursorWord(value, start);
    return value.substring(startIndex, endIndex);
}

/**
 * Returns the correct current auto-complete filename candidate, the filename and the start index.
 * @param {string} string - The string to search in.
 * @returns {Array} The word and start index, or empty array if not found.
 */
const getCorrectFilename = (string) => {
    const initialMatch = string.match(regEx);
    if (!initialMatch) return [];

    const [startIndex, _] = startAndEndIndexForCursorWord(question.value, lastCursorPosition);
    let word;
    let wordStartIndex;

    if (initialMatch.length > 1) {
        const relativeCursorPosition = lastCursorPosition - startIndex;
        let match;
        while ((match = regEx.exec(string)) !== null) {
            const start = match.index;
            const end = start + match[0].length;
            if (start > relativeCursorPosition) break;
            if (start <= relativeCursorPosition && end >= relativeCursorPosition) {
                word = match[0];
                wordStartIndex = startIndex + start;
                break;
            }
        }
    } else {
        const matchedWord = initialMatch[0];
        const matchedStart = startIndex + string.indexOf(matchedWord);
        const matchedEnd = matchedStart + matchedWord.length;
        if (matchedStart <= lastCursorPosition && matchedEnd >= lastCursorPosition) {
            word = matchedWord;
            wordStartIndex = matchedStart;
        }
    }

    return [word, wordStartIndex];
}

/**
 * Replaces cursor word with selected filename from autocomplete.
 * @param {number} start - The start position of the word.
 * @param {Array} fileInfo - The file information [filename, location].
 */
const replaceCursorWord = (start, fileInfo) => {
    const value = question.value;
    const [word, location] = fileInfo;
    const [stringStart, stringEnd] = startAndEndIndexForCursorWord(value, start);
    const [wordChange, startIndex] = getCorrectFilename(value.substring(stringStart, stringEnd));
    if (!wordChange) return;

    const endIndex = startIndex + wordChange.length;
    const addWord = value.substring(0, startIndex + 1) + word;
    const cursorPosition = addWord.length;

    question.value = addWord + value.substring(endIndex);
    question.focus();
    question.setSelectionRange(cursorPosition, cursorPosition);

    mentionedFiles[startIndex] = [word, location];
    fileSearch.replaceChildren();
    fileSearch.style.display = 'none';
    updateContextFiles();
}

/**
 * Creates clickable file autocomplete suggestions.
 * @param {string} file - The file name.
 * @param {string} value - The file path.
 * @param {number} idx - The current item index.
 * @param {number} total - The total number items to be created.
 * @returns {HTMLDivElement} The search item element.
 */
const createSearchItem = (file, value, idx, total) => {
    if (!baseWorkspacePath) return null;
    const item = document.createElement('div');
    const location = value.substring(baseWorkspacePath.length + 1);

    item.key = idx;
    item.classList.add('search-item');
    item.innerHTML = `<b>${file}</b>: (<i>${location}</i>)`;
    item.tabIndex = "0"

    item.addEventListener('click', (event) => {
        autocompleteUsed = true;
        replaceCursorWord(lastCursorPosition, [file, value]);
        vscode.postMessage({ command: 'updateQuestion', value: question.value, files: mentionedFiles });
    })

    item.addEventListener('keydown', (event) => {
        if (event.key == 'Enter') {
            event.preventDefault();
            item.click();
        } else if (event.key == "ArrowUp") {
            event.preventDefault();
            if (idx == 0) question.focus();
            else {
                const prevIdx = (idx - 1 + total) % total;
                fileSearch.children[prevIdx].focus();
            }
        } else if (event.key == "ArrowDown") {
            event.preventDefault();
            const nextIdx = (idx + 1) % total;
            fileSearch.children[nextIdx].focus();
        }
    })
    
    return item;
}

/**
 * Orders file options based on mention status, position, and alphabetical order.
 * @param {string} searchString - The string/filename to search for.
 * @param {Array} options - The file options to sort.
 * @returns {Array} The sorted file options.
 */
const orderFileOptions = (searchString, options) => {
    return options.sort((a, b) => {
        const [filenameA, locationA] = a;
        const [filenameB, locationB] = b;

        const entryA = Object.entries(mentionedFiles).find(
            ([key, [name, loc]]) => name === filenameA && loc === locationA
        );
        const entryB = Object.entries(mentionedFiles).find(
            ([key, [name, loc]]) => name === filenameB && loc === locationB
        );

        const isMentionedA = !!entryA;
        const isMentionedB = !!entryB;

        if (isMentionedA && !isMentionedB) return -1;
        if (!isMentionedA && isMentionedB) return 1;
        if (isMentionedA && isMentionedB) {
            const keyA = parseInt(entryA[0]);
            const keyB = parseInt(entryB[0]);
            return keyB - keyA;
        }

        const startsWithA = filenameA.startsWith(searchString);
        const startsWithB = filenameB.startsWith(searchString);
        if (startsWithA && !startsWithB) return -1;
        if (!startsWithA && startsWithB) return 1;

        const nameCompare = filenameA.localeCompare(filenameB);
        if (nameCompare !== 0) return nameCompare;
        return locationA.localeCompare(locationB);
    });
};

/**
 * Displays the filename suggestions dropdown.
 * @param {string} string - The string to search for matches.
 */
const showFileOptions = (string) => {
    fileSearch.replaceChildren();
    const [word, start] = getCorrectFilename(string);

    if (!word) {
        fileSearch.style.display = 'none';
        return;
    }

    const file = word.substring(1).trim();
    const options = [];
    for (const key of Object.keys(fileTitlesWithLocations)) {
        const lowerCaseKey = key.toLowerCase();
        if (file && lowerCaseKey.startsWith(file.toLowerCase())) {
            options.push([key, fileTitlesWithLocations[key]]);
        }
    }

    if (!file || options.length == 0) {
        fileSearch.style.display = 'none';
        return;
    }

    let flatOptions = [];
    for (const [filename, locations] of options) {
        for (const loc of locations) {
            flatOptions.push([filename, loc]);
        }
    }

    const orderedOptions = orderFileOptions(file, flatOptions);
    const totalLength = orderedOptions.length;
    let idx = 0;

    for (const [filename, location] of orderedOptions) {
        const row = createSearchItem(filename, location, idx, totalLength);
        if (row == null) continue;
        idx += 1;
        fileSearch.appendChild(row);
    }

    fileSearch.style.display = 'flex';
};

/**
 * Calculates the Levenshtein distance between two strings.
 * @param {string} a - First string.
 * @param {string} b - Second string.
 * @returns {number} The Levenshtein distance.
 */
const levenDist = (a, b) => {
    const tmp = [];
    let i, j, alen = a.length, blen = b.length, score, alen1 = alen + 1, blen1 = blen + 1;

    for (i = 0; i < alen1; i++) {
        tmp[i] = [i];
    }
    for (j = 0; j < blen1; j++) {
        tmp[0][j] = j;
    }

    for (i = 1; i < alen1; i++) {
        for (j = 1; j < blen1; j++) {
            score = (a[i - 1] === b[j - 1]) ? 0 : 1;
            tmp[i][j] = Math.min(tmp[i - 1][j] + 1, tmp[i][j - 1] + 1, tmp[i - 1][j - 1] + score);
        }
    }
    return tmp[alen][blen];
}

/**
 * Normalizes whitespace in a string.
 * @param {string} str - The string to normalize.
 * @returns {string} The normalized string.
 */
const normalizeString = (str) => {
    return str
        .replace(/\s+/g, ' ')
        .replace(/^\s+|\s+$/g, '')
        .replace(/\r\n|\r/g, '\n');
}

/**
 * Escapes special characters in a string.
 * @param {string} str - The string to escape.
 * @returns {string} The escaped string.
 */
const escapeString = (str) => {
    return str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}

/**
 * Compares code blocks with high similarity threshold.
 * @param {string} codeBlock - The code block to compare.
 * @param {string} value - The value to compare against.
 * @returns {boolean} `true` if the code blocks are similar, `false` otherwise.
 */
const compareCodeBlock = (codeBlock, value) => {
    const normCode = escapeString(normalizeString(codeBlock));
    const normValue = escapeString(normalizeString(value));
    const distance = levenDist(normCode, normValue);
    const maxLength = Math.max(normCode.length, normValue.length);
    const similarity = (1 - distance / maxLength);
    return similarity >= 0.95;
}

/**
 * Generates dropdown values for LLM selection.
 * @param {Array<string>} names - The LLM names.
 * @param {number} index - The selected index.
 */
const generateLLMDropdownValues = (names, index) => {
    llmSelect.innerHTML = "";
    for (let i = 0; i < names.length; i++) {
        const option = document.createElement("option");
        option.text = names[i];
        option.value = i;
        llmSelect.appendChild(option);
    }
    llmSelect.value = index;
}

/**
 * Validates the listed `sessionItems` and updates their titles.
 * @param {Object<string,string>} sessions - An Object that links sessionIds with their titles.
 * @param {string | number} currentSession - The current sessionId.
 */
const updateSessionTitles = (sessions, currentSession) => {
    const sessionItems = document.querySelectorAll('div[data-session-id]');
    for (const sessionItem of sessionItems) {
        const sessionId = sessionItem.getAttribute('data-session-id');
        if (sessionId in sessions) {
            sessionItem.title = sessions[sessionId];
            const sessionTitle = sessionItem.querySelector('.session-title');
            if (!sessionTitle) continue;
            sessionTitle.innerText = sessions[sessionId];
            if (sessionId == currentSession) sessionItem.classList.add('active');
            else sessionItem.classList.remove('active');
        } else {
            sessionItem.remove();
        }
    }
}