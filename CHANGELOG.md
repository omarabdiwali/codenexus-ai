**v1.6.2**
  - Adds a copy button to the responses, copying the text in Markdown format to the clipboard

**v1.6.3**
  - Fixes some inconsistencies with the LRU Cache implementation
  - Renames a function

**v1.7.0**
  - Allows for conversation with image generation LLMs
  - Images available for viewing, and for discussion
  
**v1.7.1**
  - Fixes a bug where the context files were not shown when the extension was opened initially
  
**v1.8.0**
  - Adds the ability to open mentioned files by clicking on them
  - Better handling for deleted files in the context

**v1.8.1**
  - Adds better compatibility with the different themes of VSCode
  - A little change in the autocomplete functionality, where users can go back to prompt input when they use the 'ArrowUp' on the first suggested element
  - This update also gets the semantic versioning numbers, following the correct specifications

**v1.8.2**
  - Changes the styling for the generated code buttons
  - Creates a header on top of the code block, interaction buttons are now icons

**v1.9.0**
  - Changes to the way chat entry buttons are generated
  - Moves the location of the 'Delete' chat entry button to a more visible place

**v1.9.1**
  - Fixes a bug where the chat window freezes when configuration changes are done while LLM is responding
  - Queues the changes, and waits until the LLM is finished responding

**v2.0.0**
  - Adds the ability for users to have and create multiple separate chat sessions
  - Ability to view previous snippets in a dropdown when added as context to the chat using the `Ctrl+K` keyboard shortcut

**v2.1.0**
  - Users are now able to attach files and images to the chat
  - Created keyboard shortcut `Ctrl+Shift+K` that adds to the code snippet, instead of replacing it
  - Better information when LLM is automatically switching

**v2.2.0**
  - Snippets and runnable programs are now saved when webview visibility is changed
  - Moved snippets to their respective sessions
  - Fixed issue where snippets are not sent with request when initially opened
  - Changed file icon, reworked and created better functions