import * as vscode from 'vscode';
import * as path from 'path';
import readability from 'text-readability-ts';
import removeMarkdown from 'remove-markdown';

const extensionId = 'readability';

export function activate(context: vscode.ExtensionContext) {
	const provider = new ReadabilityProvider(context.extensionUri);

	context.subscriptions.push(vscode.commands.registerCommand(`${extensionId}.checkSelection`, provider.checkSelection, provider));

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ReadabilityProvider.viewType, provider));

	context.subscriptions.push(
		vscode.commands.registerCommand(`${extensionId}.addColor`, () => {
			provider.addColor();
		}));

	context.subscriptions.push(
		vscode.commands.registerCommand(`${extensionId}.clearColors`, () => {
			provider.clearColors();
		}));

	// Update the settings when the configuration relevant to the extension changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration(extensionId)) {
				return;
			}
			provider.syncSettings();
		}),
	);
}

const positiveIcon = '✓';
const negativeIcon = '✗';

class ReadabilityProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = `${extensionId}.scoreView`;

	private _view?: vscode.WebviewView;

	constructor(
		private readonly _extensionUri: vscode.Uri,
	) { }

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,

			localResourceRoots: [
				this._extensionUri
			]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		webviewView.webview.onDidReceiveMessage((data) => {
			switch (data.type) {
				case 'colorSelected':
					{
						vscode.window.activeTextEditor?.insertSnippet(new vscode.SnippetString(`#${data.value}`));
						break;
					}
			}
		});
	}

	public addColor() {
		if (this._view) {
			this._view.show?.(true); // `show` is not implemented in 1.49 but is for 1.50 insiders
			this._view.webview.postMessage({ type: 'addColor' });
		}
	}

	public clearColors() {
		if (this._view) {
			this._view.webview.postMessage({ type: 'clearColors' });
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview) {
		// Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));

		// Do the same for the stylesheet.
		const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
		const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));
		const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));

		// Use a nonce to only allow a specific script to be run.
		const nonce = getNonce();

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<!--
					Use a content security policy to only allow loading styles from our extension directory,
					and only allow scripts that have a specific nonce.
					(See the 'webview-sample' extension sample for img-src content security policy examples)
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">

				<link href="${styleResetUri}" rel="stylesheet">
				<link href="${styleVSCodeUri}" rel="stylesheet">
				<link href="${styleMainUri}" rel="stylesheet">

				<title>Readability</title>
			</head>
			<body>
				<div id="empty-view">Highlight text you would like to check the readability of then right click and select "Check Readability".</div>
				  <div id="content-container" class="container hide">
					<div id="flesch-ease" class="card">
						<h3 title="Scale is between 1-100, 100 being the easiest.">Flesch Reading Ease</h3>
						<div class="value">90</div>
						<div class="status">
							<span class="icon"></span>
							<span>Ideal >=</span>
							<span class="ideal">${this.idealFleschReadingEaseScore}</span>
						</div>
					</div>
					<div id="flesch-grade" class="card">
						<h3 title="Scale is 0-18. It shows the required education to be able to understand a text. Text intended for readership by the general public should aim for a grade level of around 8.">Flesch Kincaid Grade</h3>
						<div class="value">Grade 10</div>
						<div class="status">
							<span class="icon"></span>
							<span>Ideal <=</span>
							<span class="ideal">${this.idealFleschKincaidGradeLevel}</span>
						</div>
					</div>
					<div class="card">
						<q id="selected-text">Blah blah blah</q>
					</div>
				</div>

				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}


	// See https://readable.com/readability/flesch-reading-ease-flesch-kincaid-grade-level/ for more information on these defaults.
	public idealFleschKincaidGradeLevel: number = 8;
	public idealFleschReadingEaseScore: number = 65;
	// This URL regex could capture false positives for period delimited strings that aren't URLs or if there are no spaces between sentences.
	private _urlRegex = /((?:http(?:s)*:\/\/)*[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/\/=]*))/gim;

	getActiveEditorSelectedText(): string | undefined {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		const selection = editor.selection;
		if (selection && !selection.isEmpty) {
			const selectionRange = new vscode.Range(selection.start.line, selection.start.character, selection.end.line, selection.end.character);
			return editor.document.getText(selectionRange);
		}
	}

	syncSettings(): void {
    const userSetting = vscode.workspace.getConfiguration(extensionId);
    this.idealFleschReadingEaseScore = Math.max(0, Math.min(userSetting.idealFleschReadingEaseScore, 100));
    this.idealFleschKincaidGradeLevel = Math.max(0, Math.min(userSetting.idealFleschKincaidGradeLevel, 18));
		if (this._view) {
			this._view.webview.postMessage({ command: 'syncSettings', idealFleschEase: this.idealFleschReadingEaseScore, idealFleschGrade: this.idealFleschKincaidGradeLevel });
		}
  }

	// Check the highlighted/selected text for readability.
	checkSelection() {
		const rawSelectedText = this.getActiveEditorSelectedText();
		if (!rawSelectedText) {
			// No selection, nothing to check.
			return;
		}

		let cleanedText = this.cleanText(rawSelectedText);

		// Default "ideal score" are based on https://readable.com/readability/what-is-readability/
		console.log(cleanedText);
		console.log(`automatedReadabilityIndex: ${readability.automatedReadabilityIndex(cleanedText)}`);
		console.log(`colemanLiauIndex: ${readability.colemanLiauIndex(cleanedText)}`);
		console.log(`daleChallReadabilityScore: ${readability.daleChallReadabilityScore(cleanedText)}`);
		console.log(`fleschReadingEase: ${readability.fleschReadingEase(cleanedText)}`);
		console.log(`fleschReadingEaseGrade: ${readability.fleschReadingEaseToGrade(readability.fleschReadingEase(cleanedText))}`);
		// To reach the widest audience, we recommend aiming for a Flesch Kincaid grade between 8 and 10.
		console.log(`fleschKincaidGrade (ideal 8-10): ${readability.fleschKincaidGrade(cleanedText)}`);
		//console.log(`readability: ${readability.(cleanedText)}`);
		console.log(`textStandard: ${readability.textStandard(cleanedText)}`);
		console.log(`difficult words: ${readability.difficultWords(cleanedText)}`);

		if (this._view) {
			this._view.webview.postMessage({ command: 'checkSelected', fleschEase: readability.fleschReadingEase(cleanedText), fleschGrade: readability.fleschKincaidGrade(cleanedText), selectedText: rawSelectedText });
		}
	}

	cleanText(text: string) {
		// Remove markdown formatting, if present, this also removes html links and other non-text content.
		text = removeMarkdown(text);

		// remove any raw urls because they make a readability score worse unintentionally.
		text = text.replace(this._urlRegex, '');

		// Check if it could be a variable name (no spaces).
		if (!text.trim().includes(' ')) {
			// "Readability" tests aren't ideal for variable names because they are designed for sentences and paragraphs.
			// but I can still try to make it a little better.
			// When used against a variable name it tends to give a bad readability score.
			// example:
			// "renderMessageBox":
			// 		automatedReadabilityIndex: 54.4
			// 		colemanLiauIndex: 47.4
			// 		daleChallReadabilityScore: 19.48
			// 		fleschReadingEase: -301.79
			// 		fleschKincaidGrade: 55.6
			// 		textStandard: 15th and 16th grade
			// vs
			// "render message box" (with spaces):
			// 		automatedReadabilityIndex: 5.2
			// 		colemanLiauIndex: 5.35
			// 		daleChallReadabilityScore: 14.31
			// 		fleschReadingEase: 59.97
			// 		fleschKincaidGrade: 5.6
			// 		textStandard: 5th and 6th grade
			//

			// Simple replacements to make the variable name seem more like a short sentence for the readability test.
			// Replace common variable name delimiters ".", "-", & "_" with spaces
			text = text.replace(/[\.\/_-]/g, ' ');
			// Add spaces for camel and pascal casing
			text = text.replace(/([a-zA-Z])([A-Z])/g, '$1 $2');
			// remove any non-word characters in case its including any invocation parens or accessor brackets or something.
			// set it all to lowercase and remove any extra spaces on the ends.
			text = text.replace(/\W/gm, ' ').replace(/\s\s+/gm, ' ').toLocaleLowerCase().trim();
			// add a period at the end if it doesn't have one.
			// this doesn't effect the flesch readability tests but does effect other ones just in case we support them in the future.
			text = text.endsWith('.') ? text : `${text}.`;
		}

		return text;
	}
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
