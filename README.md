# ai-chat vscode extension

This VSCode extension allows the users to be able to ask multiple LLMs questions about their code. 

It allows users to mention open files using `@filename.ext` in order for the LLM to be able to have access to that file, and answer the question based on the code. They are able to pick from 5 different LLMs, which are free, and switches between them if there is an error with the selected LLM. Also, it gives the user the ability to highlight part of a file, and use the keyboard shortcut `Ctrl+K` in order to open the extension and mention the highlighted text automatically.

To be able to call the LLMs, it uses `OpenRouter`, so in order to be able to use the extension, you will need an OpenRouter API key, which the extension will ask for when you open it for the first time.

## Local Installation and Usage

* Run `npm i` inside the extension directory to download all the needed libraries
* In your terminal, outside of the extension directory, run `npm install -g @vscode/vsce`. This package will allow you to build the extension.
* Move into the extension directory, and run `vsce package`. It will have 2 prompts, answer them and it will create a `.vsix` file.
* After doing the previous step, run `code --install-extension ai-chat-0.0.2.vsix`. This should install the extension.
* If everything is done correctly, you will be able to see the extension in the Activity Bar, and have the ability to highlight part of a file and use `Ctrl+K or Cmd+K` to mention it. To change the API key, click `AI Chat: Change API Key` to update it.

## What's in the folder

* This folder contains all of the files necessary for your extension.
* `package.json` - this is the manifest file in which you declare your extension and command.
  * The sample plugin registers a command and defines its title and command name. With this information VS Code can show the command in the command palette. It doesn’t yet need to load the plugin.
* `extension.js` - this is the main file where you will provide the implementation of your command.
  * The file exports one function, `activate`, which is called the very first time your extension is activated (in this case by executing the command). Inside the `activate` function we call `registerCommand`.
  * We pass the function containing the implementation of the command as the second parameter to `registerCommand`.
* `webview.js` - this file holds the code that handles the implementation of the chat panel.
  * The file has all the needed components and functions that is used by the webview panel, and handles the talking to `extension.js` using VSCode's postMessage.
* `styles.css`, `spinner.css` - these CSS files hold the styling for the webview panel, and the loading spinner.

## Get up and running straight away

* Press `F5` to open a new window with your extension loaded.
* Run your command from the command palette by pressing (`Ctrl+Shift+P` or `Cmd+Shift+P` on Mac) and typing `AI Chat: Chat with AI`.
* Set breakpoints in your code inside `extension.js` to debug your extension.
* Find output from your extension in the debug console..

## Make changes

* You can relaunch the extension from the debug toolbar after changing code in `extension.js`.
* You can also reload (`Ctrl+R` or `Cmd+R` on Mac) the VS Code window with your extension to load your changes.

## Explore the API

* You can open the full set of our API when you open the file `node_modules/@types/vscode/index.d.ts`.

## Run tests

* Install the [Extension Test Runner](https://marketplace.visualstudio.com/items?itemName=ms-vscode.extension-test-runner)
* Open the Testing view from the activity bar and click the Run Test" button, or use the hotkey `Ctrl/Cmd + ; A`
* See the output of the test result in the Test Results view.
* Make changes to `test/extension.test.js` or create new test files inside the `test` folder.
  * The provided test runner will only consider files matching the name pattern `**.test.js`.
  * You can create folders inside the `test` folder to structure your tests any way you want.

## Go further

 * [Follow UX guidelines](https://code.visualstudio.com/api/ux-guidelines/overview) to create extensions that seamlessly integrate with VS Code's native interface and patterns.
 * [Publish your extension](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) on the VS Code extension marketplace.
 * Automate builds by setting up [Continuous Integration](https://code.visualstudio.com/api/working-with-extensions/continuous-integration).
 * Integrate to the [report issue](https://code.visualstudio.com/api/get-started/wrapping-up#issue-reporting) flow to get issue and feature requests reported by users.
