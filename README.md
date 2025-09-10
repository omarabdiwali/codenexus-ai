# 🤖 CodeNexus AI - Intelligent Code Assistant for VSCode

![VSCode Extension](https://img.shields.io/badge/Visual_Studio_Code-0078D4?style=for-the-badge&logo=visual%20studio%20code&logoColor=white)
![OpenRouter Integration](https://img.shields.io/badge/OpenRouter-4B32C3?style=for-the-badge)
![Ollama](https://img.shields.io/badge/Ollama-FF6C37?style=for-the-badge&logo=docker&logoColor=white)
![Python Required](https://img.shields.io/badge/Python-3.8%2B-3776AB?style=for-the-badge&logo=python&logoColor=white)

A powerful VSCode extension that brings multi-LLM intelligence to your coding workflow, with advanced context awareness and code execution capabilities.

![Extension Demo](https://i.imgur.com/LdPUDcZ.png)

## 📋 Table of Contents
- [Features](#-features)
- [Quick Start / Installation](#-quick-start)
- [Usage](#%EF%B8%8F-usage)
- [Configuration](#%EF%B8%8F-configuration)
- [Local LLM Support](#-local-llm-support-via-ollama)
- [Project Structure](#-project-structure)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)
- [License](#-license)

## ✨ Features

- **Multi-LLM Support**: Switch between as many different OpenRouter LLMs as you want, with automatic fallback.
- **Ollama Usage**: Ability to switch and use Ollama for complete privacy.
- **Code Context Awareness**:
  - `@filename` syntax with auto-complete.
  - LRU cached file context.
  - Highlight-to-chat integration (Ctrl+K/Cmd+K).
- **Agent Mode**: 
  - Intelligent Python program generation and validation.
  - Real-time code execution with safety checks.
- **Conversation Management**:
  - Message history retention.
  - One-click conversation reset.
- **Image Generation**
  - Allows the viewing and creation of images with compatible LLMs.
  - Saves the generated image locally.
- **OpenRouter Integration**: 
  - Secure API key management with validation.

## 🚀 Quick Start

### Prerequisites
- Node.js 16+.
- Python 3.8+ (for Agent Mode).
- [OpenRouter API Key](https://openrouter.ai/).
- [Ollama](https://ollama.com) (optional, needed if you want access to local LLMs).

### Installation Options

**Method 1: VSIX Package**
1. Download the latest release from [GitHub Releases](https://github.com/omarabdiwali/codenexus-ai/releases).
2. Install via VSCode: `Ctrl+Shift+P` → "Install from VSIX".

**Method 2: Source Installation**
```bash
git clone https://github.com/omarabdiwali/codenexus-ai.git
npm install -g @vscode/vsce
cd codenexus-ai
npm install
vsce package
code --install-extension codenexus-ai-*.vsix
```

## 🛠️ Usage

### Basic Chat
1. Open the extension from the activity bar.
2. Use `@filename` to reference files in your working directory.
3. Highlight code + Ctrl/K for instant context.

### Agent Mode
![Agent Mode Demo](https://i.imgur.com/vLAuwSa.png)
1. Start query with "Please create..." or "Write a program to...".
2. Review generated Python code.
3. Click "Run" for execution.

### Context Management
- Click `×` on file tags to remove from context.
- Use 'Trash' button to reset conversation.

## ⚙️ Configuration
1. First launch automatically prompts for API key.
2. Ability to update key from the extension webview or via command: `CodeNexus AI: Change API Key`.

**Additional Optional Configuration**:
  - `Context File Size`: Maximum number of files that can be kept for context (LRU size).
  - `Context Interaction Size`: The length of interaction history used for context.
  - `Files Excluded`: Files you want excluded from being accessed by the extension in the working directory using [glob patterns](https://code.visualstudio.com/docs/editor/glob-patterns).
  - `Files Included`: Files you want the extension to access using [glob patterns](https://code.visualstudio.com/docs/editor/glob-patterns) in the working directory (empty accesses everything).
  - `Model Names`: Names of the large language models using [OpenRouter](https://openrouter.ai/models).
  - `Models`: Unique IDs of the large language models from [OpenRouter](https://openrouter.ai/models) (list Models and Model Names in the same order).
  - `System Prompt`: Custom system prompt, which will be added in addition to the 'Agent' prompt when in Agent Mode.
  - `Ollama Models`: Unique models that you have downloaded locally from Ollama (ex. `gemma3:1b`).
  - `Ollama Names`: Names of the models from Ollama (ex. `Gemma 3 (1b)`).
  - `Use Ollama`: Use Ollama to run local LLMs.

  These configuration options can be accessed from the settings button on the webview or through the user's settings page, under `Codenexus AI`.

## 🌐 Local LLM Support via Ollama

Add local AI capabilities using Ollama's lightweight framework:

**Setup**:
1. Install [Ollama](https://ollama.com/download).
2. Pull models from Ollama (`ollama pull gemma3:1b`).
3. Add the model and the name to the configuration option.
4. Check the '*Use Ollama*' configuration option.
5. Select and use the LLM from the extension window.

## 📂 Project Structure
| File             | Purpose                                  |
|------------------|------------------------------------------|
| `extension.js`   | Main extension logic & VSCode integration.|
| `webview.js`     | Chat UI & message handling.               |
| `functions.js`   | Utilities & core functionality.           |
| `styles.css`     | Visual styling.                           |
| `spinner.css`    | Loading animation.                        |

## 🔧 Troubleshooting

**Common Issues:**
- **Python not found**: Ensure Python 3.8+ is in your PATH.
- **API key errors**: Re-enter your OpenRouter API key via command palette.
- **Ollama connection**: Verify Ollama is running (`ollama serve`).

**Debug Mode:**
Enable developer tools via `Ctrl+Shift+P` → "Developer: Toggle Developer Tools".

## 🤝 Contributing
We welcome contributions! Please follow our guidelines:
1. Fork the repository.
2. Create feature branch (`git checkout -b feature/your-feature`).
3. Commit changes.
4. Push to branch.
5. Open PR with detailed description.

## 📄 License
MIT License - See [LICENSE](LICENSE) for details.

---
